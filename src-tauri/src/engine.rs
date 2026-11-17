//! UCI engine sessions: the bundled Stockfish sidecar and engines the user
//! added (see `engines.rs`). Only Rust spawns engines; the frontend has no
//! shell permissions.
//!
//! Every engine runs as one long-lived session, started on first use, and
//! several engines can run side by side. A task (the [`Actor`]) owns each
//! process and receives `analyze`/`stop` commands through a channel. Each `analyze` comes with its own Tauri channel, and the
//! actor streams throttled snapshots of that search to it with every line in
//! SAN and every score from White's point of view.
//!
//! A search runs until it is replaced or stopped, or to a fixed depth when the
//! request asks for one (full-game analysis does). Either way its channel ends
//! with a `done` event that says whether the search ran its course.
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
use serde::Serialize;
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
const HASH_MB: u32 = 256;
const MAX_MULTIPV: u32 = 5;
const MAX_DEPTH: u32 = 99;

/// What the frontend shows about a running engine.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    name: String,
    /// The `Threads` and `Hash` settings, for engines that have them.
    threads: Option<u32>,
    hash_mb: Option<u32>,
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

/// A message on the channel of an `analyze` request.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum EngineEvent {
    Update(AnalysisUpdate),
    /// The search is over. `complete` is false when it was replaced or stopped
    /// before reaching its depth; searches without a depth never complete.
    Done {
        complete: bool,
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

/// Tauri state holding the running engine sessions, by engine ID.
#[derive(Default)]
pub struct Engine {
    sessions: Mutex<HashMap<String, Session>>,
}

struct Session {
    commands: mpsc::UnboundedSender<Command>,
    info: EngineInfo,
    /// What the session was started with; a changed setup starts a new one.
    spec: LaunchSpec,
}

enum Command {
    Analyze(Request),
    Stop,
    Quit(oneshot::Sender<()>),
}

struct Request {
    fen: String,
    root: AnalysisRoot,
    multipv: u32,
    /// Search to this depth instead of until told otherwise.
    depth: Option<u32>,
    channel: Channel<EngineEvent>,
}

impl Request {
    fn send_done(&self, complete: bool) {
        // A closed channel means the frontend moved on.
        let _ = self.channel.send(EngineEvent::Done { complete });
    }
}

impl Engine {
    /// Starts the engine `id` if needed and describes it.
    pub async fn info<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        engines: &Engines,
        id: &str,
    ) -> Result<EngineInfo, String> {
        let mut sessions = self.sessions.lock().await;
        Ok(ensure_session(&mut sessions, app, engines, id)
            .await?
            .info
            .clone())
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
        let mut command = Command::Analyze(Request {
            fen,
            root,
            multipv: multipv.clamp(1, MAX_MULTIPV),
            depth: depth.map(|d| d.clamp(1, MAX_DEPTH)),
            channel,
        });
        let mut sessions = self.sessions.lock().await;
        // A second attempt covers an engine that died since the last request.
        for _ in 0..2 {
            match ensure_session(&mut sessions, app, engines, id)
                .await?
                .commands
                .send(command)
            {
                Ok(()) => return Ok(()),
                Err(mpsc::error::SendError(returned)) => {
                    sessions.remove(id);
                    command = returned;
                }
            }
        }
        Err("the engine stopped unexpectedly".into())
    }

    /// Stops the current search of engine `id`. Does not start the engine.
    pub async fn stop(&self, id: &str) {
        if let Some(session) = self.sessions.lock().await.get(id) {
            let _ = session.commands.send(Command::Stop);
        }
    }

    /// Quits engine `id`, so that it starts afresh with its current setup when next used.
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
}

async fn quit(session: Session) {
    let (done, exited) = oneshot::channel();
    if session.commands.send(Command::Quit(done)).is_ok() {
        let _ = timeout(QUIT_TIMEOUT * 2, exited).await;
    }
}

/// Returns the running session of engine `id`, spawning the engine if there is
/// none, the last one died or its setup changed since it started.
async fn ensure_session<'a, R: Runtime>(
    sessions: &'a mut HashMap<String, Session>,
    app: &AppHandle<R>,
    engines: &Engines,
    id: &str,
) -> Result<&'a Session, String> {
    let entry = engines.entry(app, id)?;
    let spec = entry.launch_spec();
    let stale = sessions
        .get(id)
        .is_some_and(|s| s.commands.is_closed() || s.spec != spec);
    if stale && let Some(old) = sessions.remove(id) {
        quit(old).await;
    }
    if !sessions.contains_key(id) {
        let (session, handshake) = spawn_session(app, spec).await?;
        engines.discovered(app, id, &handshake);
        sessions.insert(id.to_owned(), session);
    }
    Ok(sessions.get(id).expect("session was just set"))
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
/// `Threads` and `Hash` a default that suits analysis better than the engine's.
fn startup_values(
    options: &[UciOption],
    chosen: &BTreeMap<String, String>,
) -> Vec<(UciOption, String)> {
    // Leave a core for the UI.
    let threads =
        std::thread::available_parallelism().map_or(1, |n| n.get().saturating_sub(1).max(1));
    options
        .iter()
        .filter(|option| !MANAGED_OPTIONS.contains(&option.name.as_str()))
        .filter_map(|option| {
            let value = match (chosen.get(&option.name), option.name.as_str()) {
                (Some(value), _) => option.normalize(value).ok()?,
                (None, "Threads") => option.normalize(&threads.to_string()).ok()?,
                (None, "Hash") => option.normalize(&HASH_MB.to_string()).ok()?,
                (None, _) => return None,
            };
            Some((option.clone(), value))
        })
        .collect()
}

/// The value an option ends up with: set at startup, or the engine's default.
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
) -> Result<(Session, Handshake), String> {
    let (mut events, mut child) = command(app, &spec.program)?
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("could not start the engine: {e}"))?;

    let (handshake, set) = timeout(HANDSHAKE_TIMEOUT, async {
        let handshake = handshake(&mut events, &mut child).await?;
        let set = startup_values(&handshake.options, &spec.values);
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

    /// Sends the final snapshot of a search that ran its course.
    fn finish(mut self) {
        // The engine is done printing, so the last burst is as complete as it gets.
        self.rest_of_burst = false;
        self.flush();
        self.request.send_done(true);
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
}

impl<I: EngineInput> Actor<I> {
    fn new(input: I, events: Receiver<CommandEvent>) -> Self {
        Actor {
            input,
            events,
            state: State::Idle,
            multipv: 1,
        }
    }

    async fn run(mut self, mut commands: mpsc::UnboundedReceiver<Command>) {
        let mut ticker = tokio::time::interval(UPDATE_INTERVAL);
        ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

        let outcome: Result<Option<oneshot::Sender<()>>, String> = loop {
            let step = tokio::select! {
                command = commands.recv() => match command {
                    Some(Command::Quit(done)) => {
                        if let State::Searching(search) = &self.state {
                            search.request.send_done(false);
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
                if let Some(outcome) = request.root.final_outcome() {
                    send_final(&request, outcome);
                    return self.stop_search();
                }
                match mem::replace(&mut self.state, State::Idle) {
                    State::Idle => self.start(request)?,
                    State::Searching(search) => {
                        search.request.send_done(false);
                        self.send("stop")?;
                        self.state = State::Stopping {
                            since: Instant::now(),
                            next: Some(request),
                        };
                    }
                    State::Stopping { since, next } => {
                        if let Some(replaced) = next {
                            replaced.send_done(false);
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
                search.request.send_done(false);
                self.send("stop")?;
                State::Stopping {
                    since: Instant::now(),
                    next: None,
                }
            }
            State::Stopping { since, next } => {
                if let Some(dropped) = next {
                    dropped.send_done(false);
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
        self.send(&format!("position fen {}", request.root.fen()))?;
        match request.depth {
            Some(depth) => self.send(&format!("go depth {depth}"))?,
            None => self.send("go infinite")?,
        }
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
                // The search reached its depth.
                State::Searching(search) => search.finish(),
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
    request.send_done(true);
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
            let (sender, events) = mpsc::unbounded_channel();
            let channel = Channel::new(move |body| {
                if let InvokeResponseBody::Json(json) = body {
                    let _ = sender.send(serde_json::from_str(&json).unwrap());
                }
                Ok(())
            });
            let request = Request {
                fen: fen.to_owned(),
                root: AnalysisRoot::from_fen(fen).unwrap(),
                multipv,
                depth,
                channel,
            };
            assert!(self.commands.send(Command::Analyze(request)).is_ok());
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
