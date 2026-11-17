//! UCI engine sessions: the bundled Stockfish sidecar and engines the user
//! added (see `engines.rs`). Only Rust spawns engines; the frontend has no
//! shell permissions.
//!
//! Every engine runs as one long-lived session, started on first use, and
//! several engines can analyse side by side. A task (the [`Actor`]) owns each
//! process and receives `analyze`/`stop` commands through a channel. Each `analyze` comes with its own Tauri channel, and the
//! actor streams throttled snapshots of that search to it with every line in
//! SAN and every score from White's point of view.
//!
//! A search runs until it is replaced or stopped, or to a fixed depth when the
//! request asks for one (full-game analysis does). Either way its channel ends
//! with a `done` event that says whether the search ran its course.
//!
//! Games against the engine use a bundled Stockfish session of their own (the
//! [`Opponent`]), so its playing strength never touches the analysis. Its
//! searches play a move under a clock and end with the move in `done`.
//!
//! Switching positions has to wait for the engine: after `stop`, Stockfish still
//! prints `info` lines for the old search until its `bestmove`. The actor drops
//! those lines and only then starts the next search. Requests that arrive in
//! the meantime replace each other, so only the latest position gets searched.

use std::collections::{BTreeMap, HashMap};
use std::mem;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use chess_core::shakmaty::KnownOutcome;
use chess_core::uci::{self, Info, OptionKind, Score, UciOption};
use chess_core::{AnalysisRoot, LineMove};
use serde::{Deserialize, Serialize};
use tauri::async_runtime::{self, Receiver};
use tauri::ipc::Channel;
use tauri::{AppHandle, Runtime};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::{Command as ShellCommand, CommandChild, CommandEvent};
use tokio::sync::{Mutex, mpsc, oneshot};
use tokio::time::{MissedTickBehavior, timeout};

use crate::engines::{Engines, MANAGED_OPTIONS};

/// Must match the file name of the `externalBin` entry in `tauri.conf.json`.
const SIDECAR: &str = "stockfish";
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// How long the engine may take to answer `stop` before it counts as hung.
const STOP_TIMEOUT: Duration = Duration::from_secs(5);
const QUIT_TIMEOUT: Duration = Duration::from_secs(2);
/// Snapshots are sent at most this often; Stockfish prints far more lines.
const UPDATE_INTERVAL: Duration = Duration::from_millis(100);
const MAX_MULTIPV: u32 = 5;
const MAX_DEPTH: u32 = 99;
/// How long the opponent thinks per move in games without a clock.
const UNTIMED_MOVE_TIME: Duration = Duration::from_secs(1);
/// Stockfish's top skill level, which is full strength.
const FULL_SKILL: i64 = 20;
const ELO_OPTION: &str = "UCI_Elo";
const SKILL_OPTION: &str = "Skill Level";

/// How a session sets up its engine, unless the user chose other values.
#[derive(Copy, Clone, Debug)]
struct Config {
    /// Use every core but one, leaving it for the UI; otherwise one thread.
    all_cores: bool,
    hash_mb: u32,
    /// Time the engine keeps in reserve per move for the trip to the UI and back.
    move_overhead_ms: Option<u32>,
}

/// Analysis gets the machine.
const ANALYSIS: Config = Config {
    all_cores: true,
    hash_mb: 256,
    move_overhead_ms: None,
};
/// A limited opponent needs little, and leaves the cores to the analysis.
const OPPONENT: Config = Config {
    all_cores: false,
    hash_mb: 32,
    // The game clock runs in the frontend, which sees the move a little later.
    move_overhead_ms: Some(100),
};

/// What the frontend shows about the running engine.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    name: String,
    /// The `Threads` and `Hash` settings, for engines that have them.
    threads: Option<u32>,
    hash_mb: Option<u32>,
    /// The Elo range the engine can limit itself to, if it can.
    elo: Option<StrengthRange>,
    /// The range of its skill levels, if it has them.
    skill: Option<StrengthRange>,
}

#[derive(Copy, Clone, Debug, Serialize)]
pub struct StrengthRange {
    min: i64,
    max: i64,
    default: i64,
}

impl StrengthRange {
    /// The range of the spin option called `name`, if the engine has one.
    fn of(options: &[UciOption], name: &str) -> Option<StrengthRange> {
        options.iter().find_map(|option| match option.kind {
            OptionKind::Spin { default, min, max } if option.name == name => {
                Some(StrengthRange { min, max, default })
            }
            _ => None,
        })
    }
}

/// What an engine says about itself when it starts.
#[derive(Clone, Debug)]
pub struct Handshake {
    pub name: String,
    pub author: Option<String>,
    pub options: Vec<UciOption>,
}

/// The program behind an engine.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Program {
    Bundled,
    Path(PathBuf),
}

/// How to start an engine: its program and the option values the user chose.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LaunchSpec {
    pub program: Program,
    pub values: BTreeMap<String, String>,
}

/// How strongly the opponent plays.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Strength {
    Full,
    /// `UCI_LimitStrength` with this `UCI_Elo`.
    Elo(i64),
    /// This `Skill Level`.
    Skill(i64),
}

impl Strength {
    /// The same strength within what the engine supports.
    fn clamped(self, info: &EngineInfo) -> Strength {
        let clamp = |value: i64, range: Option<StrengthRange>| {
            range.map_or(value, |r| value.clamp(r.min, r.max))
        };
        match self {
            Strength::Full => Strength::Full,
            Strength::Elo(elo) => Strength::Elo(clamp(elo, info.elo)),
            Strength::Skill(level) => Strength::Skill(clamp(level, info.skill)),
        }
    }

    /// The `setoption` commands that switch the engine to this strength.
    fn options(self) -> [String; 2] {
        let limit = |on: bool| format!("setoption name UCI_LimitStrength value {on}");
        let skill = |level: i64| format!("setoption name {SKILL_OPTION} value {level}");
        match self {
            Strength::Full => [limit(false), skill(FULL_SKILL)],
            // With the limit on, Stockfish goes by the Elo and ignores the skill level.
            Strength::Elo(elo) => [
                limit(true),
                format!("setoption name {ELO_OPTION} value {elo}"),
            ],
            Strength::Skill(level) => [limit(false), skill(level)],
        }
    }
}

/// Both players' remaining time and increment, in milliseconds.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Clock {
    white_ms: u64,
    black_ms: u64,
    white_inc_ms: u64,
    black_inc_ms: u64,
}

/// How long a search runs.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
enum Go {
    /// Until it is replaced or stopped.
    Infinite,
    Depth(u32),
    /// As long as the engine's time management decides.
    Clock(Clock),
    MoveTime(Duration),
}

impl Go {
    fn command(self) -> String {
        match self {
            Go::Infinite => "go infinite".into(),
            Go::Depth(depth) => format!("go depth {depth}"),
            Go::Clock(c) => format!(
                "go wtime {} btime {} winc {} binc {}",
                c.white_ms, c.black_ms, c.white_inc_ms, c.black_inc_ms
            ),
            Go::MoveTime(time) => format!("go movetime {}", time.as_millis()),
        }
    }
}

/// A message on the channel of an `analyze` request.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum EngineEvent {
    Update(AnalysisUpdate),
    /// The search is over. `complete` is false when it was replaced or stopped
    /// before it ended on its own; searches without a limit never complete.
    Done {
        complete: bool,
        /// The move the engine chose, in UCI notation, when the search completed.
        #[serde(skip_serializing_if = "Option::is_none")]
        bestmove: Option<String>,
    },
    /// The engine failed. The search is over; the next request restarts it.
    Error {
        message: String,
    },
}

/// The state of a search: the latest line for each MultiPV rank and the latest
/// search statistics.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisUpdate {
    /// The position as the frontend sent it.
    fen: String,
    /// Depth and selective depth of the best line.
    depth: u32,
    seldepth: u32,
    nodes: u64,
    nps: u64,
    time_ms: u64,
    /// Best line first.
    lines: Vec<Line>,
    /// `1-0`, `0-1` or `1/2-1/2` when the side to move is checkmated or
    /// stalemated. Such positions are not searched and have no lines.
    outcome: Option<&'static str>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Line {
    multipv: u32,
    depth: u32,
    /// From White's point of view.
    score: WireScore,
    san: Vec<String>,
    uci: Vec<String>,
}

/// Serialised as `{ "cp": 35 }` or `{ "mate": -3 }`.
#[derive(Copy, Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WireScore {
    Cp(i32),
    Mate(i32),
}

impl From<Score> for WireScore {
    fn from(score: Score) -> Self {
        match score {
            Score::Cp(cp) => WireScore::Cp(cp),
            Score::Mate(moves) => WireScore::Mate(moves),
        }
    }
}

/// Tauri state holding the running analysis engine sessions, by engine ID.
pub struct Engine {
    sessions: Mutex<HashMap<String, Session>>,
    config: Config,
}

/// Tauri state holding the engine session that games are played against. It
/// is always the bundled Stockfish with its default options, so the user's
/// engine settings never change how it plays.
pub struct Opponent(Engine);

/// The key of the opponent's session.
const OPPONENT_ID: &str = "opponent";

impl Opponent {
    pub fn new() -> Self {
        Opponent(Engine::with_config(OPPONENT))
    }

    fn target() -> Target<'static> {
        Target {
            id: OPPONENT_ID,
            spec: LaunchSpec {
                program: Program::Bundled,
                values: BTreeMap::new(),
            },
            engines: None,
        }
    }

    /// Starts the engine if needed and describes it.
    pub async fn info<R: Runtime>(&self, app: &AppHandle<R>) -> Result<EngineInfo, String> {
        self.0.session_info(app, &Self::target()).await
    }

    /// Picks a move for the position after `moves` from `fen`, at `strength`
    /// and under `clock` (or briefly without one). The move arrives in the
    /// `done` event; the search can be stopped like any other.
    #[allow(clippy::too_many_arguments)]
    pub async fn play<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        fen: String,
        moves: Vec<String>,
        strength: Strength,
        clock: Option<Clock>,
        new_game: bool,
        channel: Channel<EngineEvent>,
    ) -> Result<(), String> {
        let root = AnalysisRoot::from_fen_and_moves(&fen, &moves).map_err(|e| e.to_string())?;
        let info = self.info(app).await?;
        let request = Request {
            fen,
            root,
            multipv: 1,
            go: clock.map_or(Go::MoveTime(UNTIMED_MOVE_TIME), Go::Clock),
            strength: strength.clamped(&info),
            new_game,
            channel,
        };
        self.0.submit(app, &Self::target(), request).await
    }

    /// Stops the current search. Does not start the engine.
    pub async fn stop(&self) {
        self.0.stop(OPPONENT_ID).await;
    }

    /// Asks the engine to quit and waits briefly for it.
    pub async fn shutdown(&self) {
        self.0.shutdown().await;
    }
}

impl Default for Opponent {
    fn default() -> Self {
        Opponent::new()
    }
}

/// A session to use: its key, how to start it and, for engines from the
/// registry, where to record what the engine reports.
struct Target<'a> {
    id: &'a str,
    spec: LaunchSpec,
    engines: Option<&'a Engines>,
}

impl<'a> Target<'a> {
    fn from_registry<R: Runtime>(
        app: &AppHandle<R>,
        engines: &'a Engines,
        id: &'a str,
    ) -> Result<Target<'a>, String> {
        Ok(Target {
            id,
            spec: engines.entry(app, id)?.launch_spec(),
            engines: Some(engines),
        })
    }
}

struct Session {
    commands: mpsc::UnboundedSender<Command>,
    info: EngineInfo,
    /// What the session was started with; a changed setup starts a new one.
    spec: LaunchSpec,
}

enum Command {
    Analyze(Box<Request>),
    Stop,
    Quit(oneshot::Sender<()>),
}

struct Request {
    fen: String,
    root: AnalysisRoot,
    multipv: u32,
    go: Go,
    strength: Strength,
    /// Sends `ucinewgame` first, so the engine forgets the last game.
    new_game: bool,
    channel: Channel<EngineEvent>,
}

impl Request {
    fn analysis(
        fen: String,
        root: AnalysisRoot,
        multipv: u32,
        go: Go,
        channel: Channel<EngineEvent>,
    ) -> Self {
        Request {
            fen,
            root,
            multipv,
            go,
            strength: Strength::Full,
            new_game: false,
            channel,
        }
    }

    fn send_done(&self, complete: bool, bestmove: Option<String>) {
        // A closed channel means the frontend moved on.
        let _ = self.channel.send(EngineEvent::Done { complete, bestmove });
    }
}

impl Default for Engine {
    fn default() -> Self {
        Engine::with_config(ANALYSIS)
    }
}

impl Engine {
    fn with_config(config: Config) -> Self {
        Engine {
            sessions: Mutex::new(HashMap::new()),
            config,
        }
    }

    /// Starts the engine `id` if needed and describes it.
    pub async fn info<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        engines: &Engines,
        id: &str,
    ) -> Result<EngineInfo, String> {
        let target = Target::from_registry(app, engines, id)?;
        self.session_info(app, &target).await
    }

    /// Searches `fen` with engine `id` to `depth`, or until told otherwise
    /// without one, replacing that engine's current search.
    #[allow(clippy::too_many_arguments)]
    pub async fn analyze<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        engines: &Engines,
        id: &str,
        fen: String,
        multipv: u32,
        depth: Option<u32>,
        channel: Channel<EngineEvent>,
    ) -> Result<(), String> {
        let root = AnalysisRoot::from_fen(&fen).map_err(|e| e.to_string())?;
        let go = depth.map_or(Go::Infinite, |d| Go::Depth(d.clamp(1, MAX_DEPTH)));
        let request = Request::analysis(fen, root, multipv.clamp(1, MAX_MULTIPV), go, channel);
        let target = Target::from_registry(app, engines, id)?;
        self.submit(app, &target, request).await
    }

    /// Stops the current search of engine `id`. Does not start the engine.
    pub async fn stop(&self, id: &str) {
        if let Some(session) = self.sessions.lock().await.get(id) {
            let _ = session.commands.send(Command::Stop);
        }
    }

    /// Quits engine `id`, so that it starts afresh with its current setup when
    /// next used.
    pub async fn restart(&self, id: &str) {
        let session = self.sessions.lock().await.remove(id);
        if let Some(session) = session {
            quit(session).await;
        }
    }

    /// Asks every engine to quit and waits briefly for them.
    pub async fn shutdown(&self) {
        let sessions: Vec<Session> = self.sessions.lock().await.drain().map(|(_, s)| s).collect();
        for session in sessions {
            quit(session).await;
        }
    }

    async fn session_info<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        target: &Target<'_>,
    ) -> Result<EngineInfo, String> {
        let mut sessions = self.sessions.lock().await;
        Ok(ensure_session(&mut sessions, app, target, self.config)
            .await?
            .info
            .clone())
    }

    /// Hands a request to a session, starting the engine if needed.
    async fn submit<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        target: &Target<'_>,
        request: Request,
    ) -> Result<(), String> {
        let mut command = Command::Analyze(Box::new(request));
        let mut sessions = self.sessions.lock().await;
        // A second attempt covers an engine that died since the last request.
        for _ in 0..2 {
            match ensure_session(&mut sessions, app, target, self.config)
                .await?
                .commands
                .send(command)
            {
                Ok(()) => return Ok(()),
                Err(mpsc::error::SendError(returned)) => {
                    sessions.remove(target.id);
                    command = returned;
                }
            }
        }
        Err("the engine stopped unexpectedly".into())
    }
}

async fn quit(session: Session) {
    let (done, exited) = oneshot::channel();
    if session.commands.send(Command::Quit(done)).is_ok() {
        let _ = timeout(QUIT_TIMEOUT * 2, exited).await;
    }
}

/// Returns the running session of `target`, spawning the engine if there is
/// none, the last one died or its setup changed since it started.
async fn ensure_session<'a, R: Runtime>(
    sessions: &'a mut HashMap<String, Session>,
    app: &AppHandle<R>,
    target: &Target<'_>,
    config: Config,
) -> Result<&'a Session, String> {
    let stale = sessions
        .get(target.id)
        .is_some_and(|s| s.commands.is_closed() || s.spec != target.spec);
    if stale && let Some(old) = sessions.remove(target.id) {
        quit(old).await;
    }
    if !sessions.contains_key(target.id) {
        let (session, handshake) = spawn_session(app, target.spec.clone(), config).await?;
        if let Some(engines) = target.engines {
            engines.discovered(app, target.id, &handshake);
        }
        sessions.insert(target.id.to_owned(), session);
    }
    Ok(sessions.get(target.id).expect("session was just set"))
}

fn command<R: Runtime>(app: &AppHandle<R>, program: &Program) -> Result<ShellCommand, String> {
    match program {
        Program::Bundled => app
            .shell()
            .sidecar(SIDECAR)
            .map_err(|e| format!("could not locate the engine: {e}")),
        Program::Path(path) => {
            if !path.is_file() {
                return Err(format!("{} no longer exists", path.display()));
            }
            let mut command = app.shell().command(path);
            // Engines look for their networks and books next to themselves.
            if let Some(dir) = path.parent() {
                command = command.current_dir(dir);
            }
            Ok(command)
        }
    }
}

/// Reads the engine's `uci` answer: its name, author and options.
async fn handshake(
    events: &mut Receiver<CommandEvent>,
    child: &mut CommandChild,
) -> Result<Handshake, String> {
    send(child, "uci")?;
    let mut name = None;
    let mut author = None;
    let mut options = Vec::new();
    loop {
        let line = next_line(events).await?;
        if let Some(value) = uci::parse_id_name(&line) {
            name = Some(value.to_owned());
        } else if let Some(value) = uci::parse_id_author(&line) {
            author = Some(value.to_owned());
        } else if let Some(option) = uci::parse_option(&line) {
            options.push(option);
        } else if line == "uciok" {
            break;
        }
    }
    Ok(Handshake {
        name: name.ok_or("the engine sent `uciok` without `id name`")?,
        author,
        options,
    })
}

/// Starts a program, checks that it is a UCI engine and quits it again.
pub async fn probe<R: Runtime>(app: &AppHandle<R>, program: &Program) -> Result<Handshake, String> {
    let (mut events, mut child) = command(app, program)?
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("could not start the engine: {e}"))?;
    let handshake = timeout(HANDSHAKE_TIMEOUT, handshake(&mut events, &mut child))
        .await
        .map_err(|_| {
            "this doesn't look like a UCI engine: it never answered `uci`".to_string()
        })??;
    let _ = send(&mut child, "quit");
    Ok(handshake)
}

/// The value to set for each option at startup: the user's choice, or for
/// `Threads`, `Hash` and `Move Overhead` what `config` asks for.
fn startup_values(
    options: &[UciOption],
    chosen: &BTreeMap<String, String>,
    config: Config,
) -> Vec<(UciOption, String)> {
    let threads = if config.all_cores {
        // Leave a core for the UI.
        std::thread::available_parallelism().map_or(1, |n| n.get().saturating_sub(1).max(1))
    } else {
        1
    };
    options
        .iter()
        .filter(|option| !MANAGED_OPTIONS.contains(&option.name.as_str()))
        .filter_map(|option| {
            let value = match (chosen.get(&option.name), option.name.as_str()) {
                (Some(value), _) => option.normalize(value).ok()?,
                (None, "Threads") => option.normalize(&threads.to_string()).ok()?,
                (None, "Hash") => option.normalize(&config.hash_mb.to_string()).ok()?,
                (None, "Move Overhead") => option
                    .normalize(&config.move_overhead_ms?.to_string())
                    .ok()?,
                (None, _) => return None,
            };
            Some((option.clone(), value))
        })
        .collect()
}

/// The value a spin option ends up with: set at startup, or the engine's default.
fn effective_value(handshake: &Handshake, set: &[(UciOption, String)], name: &str) -> Option<u32> {
    let option = handshake.options.iter().find(|o| o.name == name)?;
    if !matches!(option.kind, OptionKind::Spin { .. }) {
        return None;
    }
    set.iter()
        .find(|(o, _)| o.name == name)
        .map(|(_, value)| value.clone())
        .or_else(|| option.default_value())?
        .parse()
        .ok()
}

async fn spawn_session<R: Runtime>(
    app: &AppHandle<R>,
    spec: LaunchSpec,
    config: Config,
) -> Result<(Session, Handshake), String> {
    let (mut events, mut child) = command(app, &spec.program)?
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("could not start the engine: {e}"))?;

    let (handshake, set) = timeout(HANDSHAKE_TIMEOUT, async {
        let handshake = handshake(&mut events, &mut child).await?;
        let set = startup_values(&handshake.options, &spec.values, config);
        for (option, value) in &set {
            send(&mut child, &option.set_command(value))?;
        }
        send(&mut child, "isready")?;
        while next_line(&mut events).await? != "readyok" {}
        Ok::<_, String>((handshake, set))
    })
    .await
    .map_err(|_| "the engine did not get ready in time".to_string())??;

    let info = EngineInfo {
        name: handshake.name.clone(),
        threads: effective_value(&handshake, &set, "Threads"),
        hash_mb: effective_value(&handshake, &set, "Hash"),
        elo: StrengthRange::of(&handshake.options, ELO_OPTION),
        skill: StrengthRange::of(&handshake.options, SKILL_OPTION),
    };
    let (commands, receiver) = mpsc::unbounded_channel();
    async_runtime::spawn(Actor::new(child, events).run(receiver));
    Ok((
        Session {
            commands,
            info,
            spec,
        },
        handshake,
    ))
}

fn send(child: &mut CommandChild, command: &str) -> Result<(), String> {
    child.send_line(command)
}

/// Where the actor writes UCI commands. Tests replace the engine process.
trait EngineInput: Send + 'static {
    fn send_line(&mut self, line: &str) -> Result<(), String>;
}

impl EngineInput for CommandChild {
    fn send_line(&mut self, line: &str) -> Result<(), String> {
        self.write(format!("{line}\n").as_bytes())
            .map_err(|e| format!("could not write to the engine: {e}"))
    }
}

/// The next line the engine prints, or an error once it is gone.
async fn next_line(events: &mut Receiver<CommandEvent>) -> Result<String, String> {
    loop {
        match events.recv().await {
            Some(CommandEvent::Stdout(bytes)) => {
                return Ok(String::from_utf8_lossy(&bytes).trim().to_owned());
            }
            Some(CommandEvent::Error(e)) => return Err(format!("engine I/O error: {e}")),
            Some(CommandEvent::Terminated(status)) => {
                return Err(format!(
                    "the engine exited unexpectedly (code {:?})",
                    status.code
                ));
            }
            Some(_) => {}
            None => return Err("the engine closed its output".into()),
        }
    }
}

enum State {
    Idle,
    Searching(Search),
    /// `stop` was sent; waiting for the old search's `bestmove`.
    Stopping {
        since: Instant,
        next: Option<Request>,
    },
}

struct Search {
    request: Request,
    /// Indexed by MultiPV rank - 1.
    lines: Vec<Option<Line>>,
    depth: u32,
    seldepth: u32,
    nodes: u64,
    nps: u64,
    time_ms: u64,
    dirty: bool,
    /// Stockfish prints lines 1..N back to back; a snapshot taken halfway would
    /// mix iterations and could show the same move twice.
    rest_of_burst: bool,
    /// N: fewer than MultiPV when the position has fewer legal moves.
    lines_per_burst: u32,
}

impl Search {
    fn new(request: Request) -> Self {
        let legal_moves = request
            .root
            .legal_move_count()
            .try_into()
            .unwrap_or(u32::MAX);
        Search {
            lines_per_burst: request.multipv.min(legal_moves),
            rest_of_burst: false,
            request,
            lines: Vec::new(),
            depth: 0,
            seldepth: 0,
            nodes: 0,
            nps: 0,
            time_ms: 0,
            dirty: false,
        }
    }

    fn apply(&mut self, info: Info) {
        self.nodes = info.nodes.unwrap_or(self.nodes);
        self.nps = info.nps.unwrap_or(self.nps);
        self.time_ms = info.time_ms.unwrap_or(self.time_ms);
        let Some(score) = info.score else { return };
        let moves = self.request.root.line_to_san(&info.pv);
        if moves.is_empty() {
            return;
        }

        let multipv = info.multipv.unwrap_or(1).max(1);
        let depth = info.depth.unwrap_or(0);
        if multipv == 1 {
            self.depth = depth;
            self.seldepth = info.seldepth.unwrap_or(depth);
        }
        let (uci, san) = moves
            .into_iter()
            .map(|LineMove { uci, san }| (uci, san))
            .unzip();
        let index = multipv as usize - 1;
        if self.lines.len() <= index {
            self.lines.resize(index + 1, None);
        }
        self.lines[index] = Some(Line {
            multipv,
            depth,
            score: self.request.root.white_score(score).into(),
            san,
            uci,
        });
        self.rest_of_burst = multipv < self.lines_per_burst;
        self.dirty = true;
    }

    /// Sends the final snapshot of a search that ran its course, and its move.
    fn finish(mut self, bestmove: Option<&str>) {
        // The engine is done printing, so the last burst is as complete as it gets.
        self.rest_of_burst = false;
        self.flush();
        self.request.send_done(true, bestmove.map(str::to_owned));
    }

    /// Sends a snapshot if anything changed since the last one.
    fn flush(&mut self) {
        if self.rest_of_burst || !mem::take(&mut self.dirty) {
            return;
        }
        let update = AnalysisUpdate {
            fen: self.request.fen.clone(),
            depth: self.depth,
            seldepth: self.seldepth,
            nodes: self.nodes,
            nps: self.nps,
            time_ms: self.time_ms,
            lines: self.lines.iter().flatten().cloned().collect(),
            outcome: None,
        };
        // A closed channel means the frontend moved on; the search ends with the next request.
        let _ = self.request.channel.send(EngineEvent::Update(update));
    }
}

/// Owns the engine process and runs one search at a time.
struct Actor<I> {
    input: I,
    events: Receiver<CommandEvent>,
    state: State,
    multipv: u32,
    strength: Strength,
}

impl<I: EngineInput> Actor<I> {
    fn new(input: I, events: Receiver<CommandEvent>) -> Self {
        Actor {
            input,
            events,
            state: State::Idle,
            // The engine's defaults.
            multipv: 1,
            strength: Strength::Full,
        }
    }

    async fn run(mut self, mut commands: mpsc::UnboundedReceiver<Command>) {
        let mut ticker = tokio::time::interval(UPDATE_INTERVAL);
        ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

        let outcome: Result<Option<oneshot::Sender<()>>, String> = loop {
            let step = tokio::select! {
                command = commands.recv() => match command {
                    Some(Command::Quit(done)) => {
                        // Whoever waits for the running search hears that it is over.
                        if let State::Searching(search) = &self.state {
                            search.request.send_done(false, None);
                        }
                        break Ok(Some(done));
                    }
                    // The app dropped its state: shut down quietly.
                    None => break Ok(None),
                    Some(command) => self.handle(command),
                },
                event = self.events.recv() => match event {
                    Some(CommandEvent::Stdout(bytes)) => {
                        self.on_line(String::from_utf8_lossy(&bytes).trim())
                    }
                    Some(CommandEvent::Error(e)) => Err(format!("engine I/O error: {e}")),
                    Some(CommandEvent::Terminated(status)) => Err(format!(
                        "the engine exited unexpectedly (code {:?})",
                        status.code
                    )),
                    Some(_) => Ok(()),
                    None => Err("the engine closed its output".into()),
                },
                _ = ticker.tick() => self.tick(),
            };
            if let Err(message) = step {
                break Err(message);
            }
        };
        // Make further requests fail fast so the next one starts a fresh engine.
        commands.close();

        match outcome {
            Ok(done) => {
                self.quit().await;
                if let Some(done) = done {
                    let _ = done.send(());
                }
            }
            Err(message) => {
                eprintln!("engine: {message}");
                self.report(message);
            }
        }
        // Dropping `self.input` kills the process if it is still running.
    }

    fn handle(&mut self, command: Command) -> Result<(), String> {
        match command {
            Command::Analyze(request) => {
                let request = *request;
                if let Some(outcome) = request.root.final_outcome() {
                    send_final(&request, outcome);
                    return self.stop_search();
                }
                match mem::replace(&mut self.state, State::Idle) {
                    State::Idle => self.start(request)?,
                    State::Searching(search) => {
                        search.request.send_done(false, None);
                        self.send("stop")?;
                        self.state = State::Stopping {
                            since: Instant::now(),
                            next: Some(request),
                        };
                    }
                    State::Stopping { since, next } => {
                        if let Some(replaced) = next {
                            replaced.send_done(false, None);
                        }
                        self.state = State::Stopping {
                            since,
                            next: Some(request),
                        };
                    }
                }
                Ok(())
            }
            Command::Stop => self.stop_search(),
            Command::Quit(_) => unreachable!("handled by the run loop"),
        }
    }

    fn stop_search(&mut self) -> Result<(), String> {
        self.state = match mem::replace(&mut self.state, State::Idle) {
            State::Idle => State::Idle,
            State::Searching(search) => {
                search.request.send_done(false, None);
                self.send("stop")?;
                State::Stopping {
                    since: Instant::now(),
                    next: None,
                }
            }
            State::Stopping { since, next } => {
                if let Some(dropped) = next {
                    dropped.send_done(false, None);
                }
                State::Stopping { since, next: None }
            }
        };
        Ok(())
    }

    fn start(&mut self, request: Request) -> Result<(), String> {
        // Options may only change while the engine is idle, which it is here.
        if request.multipv != self.multipv {
            self.send(&format!("setoption name MultiPV value {}", request.multipv))?;
            self.multipv = request.multipv;
        }
        if request.strength != self.strength {
            for option in request.strength.options() {
                self.send(&option)?;
            }
            self.strength = request.strength;
        }
        if request.new_game {
            self.send("ucinewgame")?;
        }
        self.send(&request.root.uci_position())?;
        self.send(&request.go.command())?;
        self.state = State::Searching(Search::new(request));
        Ok(())
    }

    fn on_line(&mut self, line: &str) -> Result<(), String> {
        if uci::is_bestmove(line) {
            match mem::replace(&mut self.state, State::Idle) {
                State::Stopping {
                    next: Some(request),
                    ..
                } => self.start(request)?,
                // The search reached its limit.
                State::Searching(search) => search.finish(uci::parse_bestmove(line)),
                State::Stopping { next: None, .. } | State::Idle => {}
            }
        } else if let State::Searching(search) = &mut self.state
            && let Some(info) = uci::parse_info(line)
        {
            search.apply(info);
        }
        // Lines of a search that is being stopped are dropped here.
        Ok(())
    }

    fn tick(&mut self) -> Result<(), String> {
        match &mut self.state {
            State::Searching(search) => search.flush(),
            State::Stopping { since, .. } if since.elapsed() > STOP_TIMEOUT => {
                return Err("the engine did not stop its search".into());
            }
            _ => {}
        }
        Ok(())
    }

    fn send(&mut self, command: &str) -> Result<(), String> {
        self.input.send_line(command)
    }

    /// Tells whoever is waiting for a search that the engine failed.
    fn report(&mut self, message: String) {
        let request = match mem::replace(&mut self.state, State::Idle) {
            State::Searching(search) => Some(search.request),
            State::Stopping { next, .. } => next,
            State::Idle => None,
        };
        if let Some(request) = request {
            let _ = request.channel.send(EngineEvent::Error { message });
        }
    }

    async fn quit(&mut self) {
        if self.send("quit").is_ok() {
            let _ = timeout(QUIT_TIMEOUT, async {
                while let Some(event) = self.events.recv().await {
                    if matches!(event, CommandEvent::Terminated(_)) {
                        break;
                    }
                }
            })
            .await;
        }
    }
}

/// Answers a request for a position without legal moves.
fn send_final(request: &Request, outcome: KnownOutcome) {
    let update = AnalysisUpdate {
        fen: request.fen.clone(),
        depth: 0,
        seldepth: 0,
        nodes: 0,
        nps: 0,
        time_ms: 0,
        lines: Vec::new(),
        outcome: Some(outcome.as_str()),
    };
    let _ = request.channel.send(EngineEvent::Update(update));
    request.send_done(true, None);
}

#[cfg(test)]
mod tests {
    //! Drives the actor with a scripted engine instead of Stockfish.

    use serde_json::{Value, json};
    use tauri::ipc::InvokeResponseBody;
    use tauri_plugin_shell::process::TerminatedPayload;

    use super::*;

    const ITALIAN: &str = "r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2P2N2/PP1P1PPP/RNBQK2R w KQkq - 1 5";
    const START: &str = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    const AFTER_E4: &str = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
    const FOOLS_MATE: &str = "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3";
    const WAIT: Duration = Duration::from_secs(2);

    struct FakeInput(mpsc::UnboundedSender<String>);

    impl EngineInput for FakeInput {
        fn send_line(&mut self, line: &str) -> Result<(), String> {
            self.0.send(line.to_owned()).map_err(|_| "closed".into())
        }
    }

    struct Harness {
        commands: mpsc::UnboundedSender<Command>,
        written: mpsc::UnboundedReceiver<String>,
        stdout: async_runtime::Sender<CommandEvent>,
    }

    impl Harness {
        fn start() -> Self {
            let (input, written) = mpsc::unbounded_channel();
            let (stdout, events) = async_runtime::channel(64);
            let (commands, receiver) = mpsc::unbounded_channel();
            async_runtime::spawn(Actor::new(FakeInput(input), events).run(receiver));
            Harness {
                commands,
                written,
                stdout,
            }
        }

        fn analyze(&self, fen: &str, multipv: u32) -> mpsc::UnboundedReceiver<Value> {
            self.request(fen, multipv, None)
        }

        fn analyze_to_depth(&self, fen: &str, depth: u32) -> mpsc::UnboundedReceiver<Value> {
            self.request(fen, 1, Some(depth))
        }

        fn request(
            &self,
            fen: &str,
            multipv: u32,
            depth: Option<u32>,
        ) -> mpsc::UnboundedReceiver<Value> {
            let (channel, events) = test_channel();
            let go = depth.map_or(Go::Infinite, Go::Depth);
            let root = AnalysisRoot::from_fen(fen).unwrap();
            let request = Request::analysis(fen.to_owned(), root, multipv, go, channel);
            assert!(
                self.commands
                    .send(Command::Analyze(Box::new(request)))
                    .is_ok()
            );
            events
        }

        fn play(
            &self,
            moves: &[&str],
            strength: Strength,
            clock: Option<Clock>,
            new_game: bool,
        ) -> mpsc::UnboundedReceiver<Value> {
            let (channel, events) = test_channel();
            let request = Request {
                fen: START.to_owned(),
                root: AnalysisRoot::from_fen_and_moves(START, moves).unwrap(),
                multipv: 1,
                go: clock.map_or(Go::MoveTime(UNTIMED_MOVE_TIME), Go::Clock),
                strength,
                new_game,
                channel,
            };
            assert!(
                self.commands
                    .send(Command::Analyze(Box::new(request)))
                    .is_ok()
            );
            events
        }

        async fn say(&self, line: &str) {
            let event = CommandEvent::Stdout(format!("{line}\n").into_bytes());
            self.stdout.send(event).await.unwrap();
        }

        async fn expect_written(&mut self, expected: &[&str]) {
            for line in expected {
                let written = timeout(WAIT, self.written.recv()).await.unwrap().unwrap();
                assert_eq!(written, *line);
            }
        }

        async fn expect_nothing_written(&mut self) {
            tokio::time::sleep(UPDATE_INTERVAL * 3).await;
            assert_eq!(self.written.try_recv().ok(), None);
        }
    }

    /// A Tauri channel whose messages arrive on the returned receiver.
    fn test_channel() -> (Channel<EngineEvent>, mpsc::UnboundedReceiver<Value>) {
        let (sender, events) = mpsc::unbounded_channel();
        let channel = Channel::new(move |body| {
            if let InvokeResponseBody::Json(json) = body {
                let _ = sender.send(serde_json::from_str(&json).unwrap());
            }
            Ok(())
        });
        (channel, events)
    }

    /// Waits for an event matching `accept`, skipping earlier ones.
    async fn next_event(
        events: &mut mpsc::UnboundedReceiver<Value>,
        accept: impl Fn(&Value) -> bool,
    ) -> Value {
        next_event_within(WAIT, events, accept).await
    }

    async fn next_event_within(
        wait: Duration,
        events: &mut mpsc::UnboundedReceiver<Value>,
        accept: impl Fn(&Value) -> bool,
    ) -> Value {
        timeout(wait, async {
            loop {
                let event = events.recv().await.expect("channel closed");
                if accept(&event) {
                    return event;
                }
            }
        })
        .await
        .expect("no matching event")
    }

    fn drain(events: &mut mpsc::UnboundedReceiver<Value>) -> Vec<Value> {
        std::iter::from_fn(|| events.try_recv().ok()).collect()
    }

    fn normalized(fen: &str) -> String {
        AnalysisRoot::from_fen(fen).unwrap().fen()
    }

    #[test]
    fn streams_lines_in_san() {
        async_runtime::block_on(async {
            let mut h = Harness::start();
            let mut events = h.analyze(ITALIAN, 2);
            h.expect_written(&[
                "setoption name MultiPV value 2",
                &format!("position fen {}", normalized(ITALIAN)),
                "go infinite",
            ])
            .await;

            h.say("info depth 12 seldepth 18 multipv 1 score cp 35 nodes 90000 nps 450000 time 200 pv d2d4 e5d4 c3d4 c5b4")
                .await;
            // Half a MultiPV burst is held back.
            tokio::time::sleep(UPDATE_INTERVAL * 3).await;
            assert!(drain(&mut events).is_empty());
            h.say("info depth 12 seldepth 15 multipv 2 score cp 22 lowerbound nodes 91000 nps 455000 time 201 pv d2d3")
                .await;
            let update = next_event(&mut events, |_| true).await;
            assert_eq!(
                update,
                json!({
                    "type": "update",
                    "fen": ITALIAN,
                    "depth": 12,
                    "seldepth": 18,
                    "nodes": 91000,
                    "nps": 455000,
                    "timeMs": 201,
                    "outcome": null,
                    "lines": [
                        {
                            "multipv": 1,
                            "depth": 12,
                            "score": { "cp": 35 },
                            "san": ["d4", "exd4", "cxd4", "Bb4+"],
                            "uci": ["d2d4", "e5d4", "c3d4", "c5b4"],
                        },
                        {
                            "multipv": 2,
                            "depth": 12,
                            "score": { "cp": 22 },
                            "san": ["d3"],
                            "uci": ["d2d3"],
                        },
                    ],
                })
            );
        });
    }

    #[test]
    fn switching_positions_waits_for_bestmove_and_keeps_only_the_latest() {
        async_runtime::block_on(async {
            let mut h = Harness::start();
            let mut first = h.analyze(START, 1);
            h.expect_written(&[&format!("position fen {START}"), "go infinite"])
                .await;
            h.say("info depth 8 score cp 20 pv e2e4").await;
            next_event(&mut first, |e| e["depth"] == 8).await;

            let mut skipped = h.analyze(ITALIAN, 1);
            h.expect_written(&["stop"]).await;
            let mut latest = h.analyze(AFTER_E4, 1);
            // Still the first search's output: it must not reach anyone.
            h.say("info depth 9 score cp 25 pv e2e4 e7e5").await;
            h.expect_nothing_written().await;

            h.say("bestmove e2e4 ponder e7e5").await;
            h.expect_written(&[
                &format!("position fen {}", normalized(AFTER_E4)),
                "go infinite",
            ])
            .await;
            // Black to move: the engine's view is flipped to White's.
            h.say("info depth 5 score mate 3 pv e7e5").await;
            let update = next_event(&mut latest, |e| e["depth"] == 5).await;
            assert_eq!(update["fen"], AFTER_E4);
            assert_eq!(update["lines"][0]["score"], json!({ "mate": -3 }));
            assert_eq!(update["lines"][0]["san"], json!(["e5"]));

            let first = drain(&mut first);
            assert!(first.iter().all(|e| e["depth"] != 9));
            assert_eq!(
                first.last(),
                Some(&json!({ "type": "done", "complete": false }))
            );
            // Replaced before it started: it only hears that it is over.
            assert_eq!(
                drain(&mut skipped),
                vec![json!({ "type": "done", "complete": false })]
            );
        });
    }

    #[test]
    fn depth_limited_searches_report_when_they_are_done() {
        async_runtime::block_on(async {
            let mut h = Harness::start();
            let mut events = h.analyze_to_depth(ITALIAN, 12);
            h.expect_written(&[
                &format!("position fen {}", normalized(ITALIAN)),
                "go depth 12",
            ])
            .await;
            h.say("info depth 11 score cp 30 pv d2d4").await;
            h.say("info depth 12 score cp 41 pv d2d4 e5d4").await;
            h.say("bestmove d2d4 ponder e5d4").await;
            // The final line arrives even if the throttle has not fired yet.
            let update = next_event(&mut events, |e| e["depth"] == 12).await;
            assert_eq!(update["lines"][0]["score"], json!({ "cp": 41 }));
            let done = next_event(&mut events, |e| e["type"] == "done").await;
            assert_eq!(done["complete"], true);

            // The engine is idle again, so the next search starts right away.
            let mut events = h.analyze_to_depth(START, 12);
            h.expect_written(&[&format!("position fen {START}"), "go depth 12"])
                .await;
            h.commands.send(Command::Stop).ok();
            h.expect_written(&["stop"]).await;
            let done = next_event(&mut events, |e| e["type"] == "done").await;
            assert_eq!(done["complete"], false);
        });
    }

    #[test]
    fn plays_moves_at_a_limited_strength() {
        async_runtime::block_on(async {
            let mut h = Harness::start();
            let clock = Clock {
                white_ms: 180_000,
                black_ms: 175_500,
                white_inc_ms: 2000,
                black_inc_ms: 2000,
            };
            let mut events = h.play(&["e2e4"], Strength::Elo(1500), Some(clock), true);
            h.expect_written(&[
                "setoption name UCI_LimitStrength value true",
                "setoption name UCI_Elo value 1500",
                "ucinewgame",
                &format!("position fen {START} moves e2e4"),
                "go wtime 180000 btime 175500 winc 2000 binc 2000",
            ])
            .await;
            h.say("info depth 6 score cp -30 pv c7c5 g1f3").await;
            h.say("bestmove c7c5 ponder g1f3").await;
            let done = next_event(&mut events, |e| e["type"] == "done").await;
            assert_eq!(
                done,
                json!({ "type": "done", "complete": true, "bestmove": "c7c5" })
            );

            // Options are only sent when they change.
            let mut events = h.play(&["e2e4", "c7c5", "g1f3"], Strength::Elo(1500), None, false);
            h.expect_written(&[
                &format!("position fen {START} moves e2e4 c7c5 g1f3"),
                "go movetime 1000",
            ])
            .await;
            h.say("bestmove d7d6").await;
            // Wait for the move, or the analysis below could arrive first and stop the search.
            next_event(&mut events, |e| e["type"] == "done").await;

            // Analysis afterwards gets the engine back at full strength.
            let _events = h.analyze(START, 1);
            h.expect_written(&[
                "setoption name UCI_LimitStrength value false",
                "setoption name Skill Level value 20",
                &format!("position fen {START}"),
                "go infinite",
            ])
            .await;
        });
    }

    #[test]
    fn clamps_strengths_to_what_the_engine_supports() {
        let info = EngineInfo {
            name: "Stockfish".into(),
            threads: Some(1),
            hash_mb: Some(16),
            elo: Some(StrengthRange {
                min: 1320,
                max: 3190,
                default: 1320,
            }),
            skill: None,
        };
        assert_eq!(Strength::Elo(800).clamped(&info), Strength::Elo(1320));
        assert_eq!(Strength::Elo(2000).clamped(&info), Strength::Elo(2000));
        assert_eq!(Strength::Skill(99).clamped(&info), Strength::Skill(99));
        assert_eq!(Strength::Full.clamped(&info), Strength::Full);
    }

    #[test]
    fn finished_games_are_answered_without_searching() {
        async_runtime::block_on(async {
            let mut h = Harness::start();
            let _first = h.analyze(START, 1);
            h.expect_written(&[&format!("position fen {START}"), "go infinite"])
                .await;

            let mut events = h.analyze(FOOLS_MATE, 1);
            let update = next_event(&mut events, |_| true).await;
            assert_eq!(update["outcome"], "0-1");
            assert_eq!(update["lines"], json!([]));
            let done = next_event(&mut events, |_| true).await;
            assert_eq!(done["complete"], true);
            // The running search is stopped and nothing new starts after it.
            h.expect_written(&["stop"]).await;
            h.say("bestmove e2e4").await;
            h.expect_nothing_written().await;
        });
    }

    #[test]
    fn engine_crashes_are_reported() {
        async_runtime::block_on(async {
            let mut h = Harness::start();
            let mut events = h.analyze(START, 1);
            h.expect_written(&[&format!("position fen {START}"), "go infinite"])
                .await;
            let crash = TerminatedPayload {
                code: Some(1),
                signal: None,
            };
            h.stdout
                .send(CommandEvent::Terminated(crash))
                .await
                .unwrap();
            let event = next_event(&mut events, |e| e["type"] == "error").await;
            assert!(event["message"].as_str().unwrap().contains("exited"));
            // The session is marked dead so the next request respawns the engine.
            timeout(WAIT, h.commands.closed()).await.unwrap();
        });
    }

    /// Stdin of a real engine process.
    struct ProcessInput(std::process::ChildStdin);

    impl EngineInput for ProcessInput {
        fn send_line(&mut self, line: &str) -> Result<(), String> {
            use std::io::Write;
            writeln!(self.0, "{line}").map_err(|e| e.to_string())
        }
    }

    /// The real Stockfish, through the same actor. `tauri-build` refuses to
    /// build without the sidecar, so it is always there when this runs.
    #[test]
    fn analyses_with_the_bundled_stockfish() {
        use std::io::BufRead;
        use std::process::{Command as Process, Stdio};

        let binary = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(format!("{SIDECAR}-{}", env!("TARGET_TRIPLE")))
            .with_extension(std::env::consts::EXE_EXTENSION);

        async_runtime::block_on(async {
            let mut child = Process::new(binary)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .spawn()
                .unwrap();
            let mut input = ProcessInput(child.stdin.take().unwrap());
            let stdout = child.stdout.take().unwrap();
            let (sender, events) = async_runtime::channel(256);
            std::thread::spawn(move || {
                for line in std::io::BufReader::new(stdout).lines() {
                    let event = CommandEvent::Stdout(line.unwrap().into_bytes());
                    if sender.blocking_send(event).is_err() {
                        break;
                    }
                }
                let exit = TerminatedPayload {
                    code: Some(0),
                    signal: None,
                };
                let _ = sender.blocking_send(CommandEvent::Terminated(exit));
            });
            input.send_line("setoption name Hash value 16").unwrap();

            let (commands, receiver) = mpsc::unbounded_channel();
            async_runtime::spawn(Actor::new(input, events).run(receiver));
            let h = Harness {
                commands,
                written: mpsc::unbounded_channel().1,
                stdout: async_runtime::channel(1).0,
            };
            let patience = Duration::from_secs(20);

            let mut events = h.analyze(ITALIAN, 3);
            let update = next_event_within(patience, &mut events, |e| {
                e["depth"].as_u64() >= Some(10) && e["lines"].as_array().unwrap().len() == 3
            })
            .await;
            for line in update["lines"].as_array().unwrap() {
                assert!(!line["san"].as_array().unwrap().is_empty());
            }

            // Switch while searching: only the new position's lines come back.
            let mut events = h.analyze(AFTER_E4, 2);
            let update =
                next_event_within(patience, &mut events, |e| e["depth"].as_u64() >= Some(8)).await;
            assert_eq!(update["fen"], AFTER_E4);
            let first_move = &update["lines"][0]["uci"][0];
            assert!(first_move.as_str().unwrap().chars().nth(1) == Some('7'));

            // A depth-limited search runs to its depth and says so.
            let mut events = h.analyze_to_depth(ITALIAN, 10);
            let done = next_event_within(patience, &mut events, |e| e["type"] == "done").await;
            assert_eq!(done["complete"], true);
            let updates = drain(&mut events);
            assert!(updates.is_empty(), "nothing follows `done`: {updates:?}");

            // A limited-strength move under the clock comes back as `bestmove`.
            let clock = Clock {
                white_ms: 5000,
                black_ms: 5000,
                white_inc_ms: 0,
                black_inc_ms: 0,
            };
            let mut events = h.play(&["e2e4"], Strength::Elo(1500), Some(clock), true);
            let done = next_event_within(patience, &mut events, |e| e["type"] == "done").await;
            assert_eq!(done["complete"], true);
            let reply = done["bestmove"].as_str().unwrap();
            assert_eq!(reply.chars().nth(1), Some('7'), "Black replies: {reply}");

            let (done, exited) = oneshot::channel();
            assert!(h.commands.send(Command::Quit(done)).is_ok());
            timeout(Duration::from_secs(5), exited)
                .await
                .unwrap()
                .unwrap();
            assert!(child.wait().unwrap().success());
        });
    }
}
