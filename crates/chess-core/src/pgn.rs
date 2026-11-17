//! PGN import and export.
//!
//! Games are represented the way PGN writes them: a line is a list of moves, and each move carries
//! the variations that could have been played instead of it. Unlike a parent-pointer tree this keeps
//! nesting proportional to the depth of variations rather than the length of the game, so it stays
//! cheap to (de)serialise.

use std::io::Read;
use std::ops::ControlFlow;

use pgn_reader::{Nag, Outcome, RawComment, RawTag, Reader, SanPlus, Skip, Visitor};
use serde::{Deserialize, Serialize};
use shakmaty::fen::Fen;
use shakmaty::san::San;
use shakmaty::{CastlingMode, Chess, Color, EnPassantMode, Position, PositionError};

/// The FEN of the standard starting position.
pub const STARTING_FEN: &str = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

/// Tags that PGN requires, in the order it requires them.
const SEVEN_TAG_ROSTER: [(&str, &str); 7] = [
    ("Event", "?"),
    ("Site", "?"),
    ("Date", "????.??.??"),
    ("Round", "?"),
    ("White", "?"),
    ("Black", "?"),
    ("Result", "*"),
];

/// Movetext lines are wrapped before this many characters, as the PGN standard recommends.
const LINE_WIDTH: usize = 80;

/// A game with its tags and its tree of moves.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Game {
    /// Tag pairs in the order they appeared.
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    /// The position before the first move.
    pub start_fen: String,
    /// A comment about the starting position, written before the first move.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
    /// The main line.
    #[serde(default)]
    pub moves: Vec<Move>,
}

/// A move in a line, with the alternatives to it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Move {
    /// Standard algebraic notation, e.g. `Nxf7+`.
    pub san: String,
    /// UCI notation, e.g. `e1g1` for castling or `e7e8q` for a promotion.
    pub uci: String,
    /// The position after the move.
    pub fen: String,
    /// Numeric annotation glyphs, e.g. `1` for `!`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub nags: Vec<u8>,
    /// A comment before the move. Only written for the first move of a variation; before the
    /// first move of the main line it is the game's [`Game::comment`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub starting_comment: Option<String>,
    /// The comment after the move, without the `[%eval]` command.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
    /// The evaluation from a `[%eval]` command, from White's point of view.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub eval: Option<Score>,
    /// Lines that could have been played instead of this move.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub variations: Vec<Vec<Move>>,
}

/// An evaluation from White's point of view. Serialises like the engine's scores (`{"cp": 30}` or
/// `{"mate": -3}`), so the frontend treats both alike.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Score {
    /// Centipawns.
    Cp(i32),
    /// Moves until mate; negative when Black mates.
    Mate(i32),
}

/// A game read from a PGN file, with anything that had to be skipped.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedGame {
    #[serde(flatten)]
    pub game: Game,
    /// Human-readable notes about moves that could not be read, e.g. illegal moves.
    pub warnings: Vec<String>,
}

/// The result of reading a PGN file.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedPgn {
    pub games: Vec<ImportedGame>,
    /// Games that could not be read at all.
    pub errors: Vec<String>,
    /// Whether reading stopped early because the file has more games than requested.
    pub truncated: bool,
}

/// Reads up to `max_games` games from PGN text.
pub fn parse(reader: impl Read, max_games: usize) -> std::io::Result<ParsedPgn> {
    let mut parsed = ParsedPgn::default();
    let more = read_games(reader, |result| {
        if parsed.games.len() + parsed.errors.len() >= max_games {
            return ControlFlow::Break(());
        }
        match result {
            Ok(game) => parsed.games.push(game),
            Err(error) => parsed.errors.push(error),
        }
        ControlFlow::Continue(())
    })?;
    parsed.truncated = more;
    Ok(parsed)
}

/// Reads games one at a time and hands each to `each`, without keeping them, so files of any size
/// can be read. Empty games are skipped. Returns whether `each` stopped reading before the end.
pub fn read_games(
    reader: impl Read,
    mut each: impl FnMut(Result<ImportedGame, String>) -> ControlFlow<()>,
) -> std::io::Result<bool> {
    let mut reader = Reader::new(reader);
    let mut builder = GameBuilder { index: 0 };
    while let Some(result) = reader.read_game(&mut builder)? {
        // A chunk without tags or moves, such as a file comment before the first game, isn't one.
        if matches!(&result, Ok(game) if game.game.headers.is_empty() && game.game.moves.is_empty())
        {
            continue;
        }
        if each(result).is_break() {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Reads up to `max_games` games from a PGN string.
pub fn parse_str(pgn: &str, max_games: usize) -> ParsedPgn {
    parse(pgn.as_bytes(), max_games).expect("reading from memory cannot fail")
}

fn parse_fen(fen: &str) -> Result<Chess, String> {
    let fen: Fen = fen
        .parse()
        .map_err(|e| format!("invalid FEN `{fen}`: {e}"))?;
    // Tolerate stale castling rights and en passant squares, as other PGN tools do.
    fen.into_position(CastlingMode::Standard)
        .or_else(PositionError::ignore_invalid_castling_rights)
        .or_else(PositionError::ignore_invalid_ep_square)
        .map_err(|e| format!("illegal position in FEN: {e}"))
}

fn fen_of(pos: &Chess) -> String {
    Fen::from_position(pos, EnPassantMode::Legal).to_string()
}

/// `5.` for White's 5th move, `5...` for Black's.
fn move_number(pos: &Chess) -> String {
    match pos.turn() {
        Color::White => format!("{}.", pos.fullmoves()),
        Color::Black => format!("{}...", pos.fullmoves()),
    }
}

// --- Import -------------------------------------------------------------------------------------

struct GameBuilder {
    /// 1-based number of the game being read, for messages.
    index: usize,
}

struct Tags {
    headers: Vec<(String, String)>,
    start: Result<Chess, String>,
}

/// A line being read: the main line, or a variation inside parentheses.
struct Frame {
    moves: Vec<Move>,
    /// The position after the last move of the line.
    pos: Chess,
    /// The position before the last move of the line, where variations of that move start.
    before_last: Chess,
    /// A comment seen before the line's next move.
    pending_comment: Option<String>,
    /// Set after an unreadable move: the rest of the line is ignored.
    broken: bool,
}

impl Frame {
    fn new(pos: Chess) -> Self {
        Frame {
            moves: Vec::new(),
            before_last: pos.clone(),
            pos,
            pending_comment: None,
            broken: false,
        }
    }
}

struct Movetext {
    headers: Vec<(String, String)>,
    start_fen: String,
    /// The main line at the bottom, then one frame per open variation.
    stack: Vec<Frame>,
    /// Depth of variations opened inside a broken line, which are skipped.
    skipped_depth: usize,
    warnings: Vec<String>,
}

impl Movetext {
    fn frame(&mut self) -> &mut Frame {
        self.stack
            .last_mut()
            .expect("the main line is never popped")
    }
}

impl Visitor for GameBuilder {
    type Tags = Tags;
    type Movetext = Movetext;
    type Output = Result<ImportedGame, String>;

    fn begin_tags(&mut self) -> ControlFlow<Self::Output, Self::Tags> {
        self.index += 1;
        ControlFlow::Continue(Tags {
            headers: Vec::new(),
            start: Ok(Chess::default()),
        })
    }

    fn tag(
        &mut self,
        tags: &mut Self::Tags,
        name: &[u8],
        value: RawTag<'_>,
    ) -> ControlFlow<Self::Output> {
        let name = String::from_utf8_lossy(name).into_owned();
        let value = value.decode_utf8_lossy().into_owned();
        if name == "FEN" {
            tags.start = parse_fen(&value);
        }
        tags.headers.push((name, value));
        ControlFlow::Continue(())
    }

    fn begin_movetext(&mut self, tags: Self::Tags) -> ControlFlow<Self::Output, Self::Movetext> {
        let start = match tags.start {
            Ok(start) => start,
            Err(error) => return ControlFlow::Break(Err(format!("Game {}: {error}", self.index))),
        };
        let mut warnings = Vec::new();
        if let Some((_, variant)) = tags.headers.iter().find(|(name, _)| name == "Variant") {
            let standard = ["standard", "chess", "from position", ""];
            if !standard.contains(&variant.to_lowercase().as_str()) {
                warnings.push(format!(
                    "The {variant} variant isn't supported; moves are read as standard chess."
                ));
            }
        }
        ControlFlow::Continue(Movetext {
            headers: tags.headers,
            start_fen: fen_of(&start),
            stack: vec![Frame::new(start)],
            skipped_depth: 0,
            warnings,
        })
    }

    fn san(
        &mut self,
        movetext: &mut Self::Movetext,
        san_plus: SanPlus,
    ) -> ControlFlow<Self::Output> {
        let main = movetext.stack.len() == 1;
        let frame = movetext.frame();
        if frame.broken {
            return ControlFlow::Continue(());
        }
        match san_plus.san.to_move(&frame.pos) {
            Ok(m) => {
                let before = frame.pos.clone();
                let uci = m.to_uci(CastlingMode::Standard).to_string();
                let san = SanPlus::from_move_and_play_unchecked(&mut frame.pos, m).to_string();
                frame.moves.push(Move {
                    san,
                    uci,
                    fen: fen_of(&frame.pos),
                    nags: Vec::new(),
                    starting_comment: frame.pending_comment.take(),
                    comment: None,
                    eval: None,
                    variations: Vec::new(),
                });
                frame.before_last = before;
            }
            Err(error) => {
                frame.broken = true;
                let at = format!("{} {san_plus}", move_number(&frame.pos));
                let line = if main { "main line" } else { "a variation" };
                movetext
                    .warnings
                    .push(format!("Skipped the rest of {line} at {at} ({error})."));
            }
        }
        ControlFlow::Continue(())
    }

    fn nag(&mut self, movetext: &mut Self::Movetext, nag: Nag) -> ControlFlow<Self::Output> {
        let frame = movetext.frame();
        if frame.broken {
            return ControlFlow::Continue(());
        }
        if let Some(last) = frame.moves.last_mut()
            && !last.nags.contains(&nag.0)
        {
            last.nags.push(nag.0);
        }
        ControlFlow::Continue(())
    }

    fn comment(
        &mut self,
        movetext: &mut Self::Movetext,
        comment: RawComment<'_>,
    ) -> ControlFlow<Self::Output> {
        let frame = movetext.frame();
        if frame.broken {
            return ControlFlow::Continue(());
        }
        let text = String::from_utf8_lossy(comment.as_bytes());
        let (text, eval) = extract_eval(&text);
        match frame.moves.last_mut() {
            Some(last) => {
                if eval.is_some() {
                    last.eval = eval;
                }
                append_comment(&mut last.comment, &text);
            }
            None => append_comment(&mut frame.pending_comment, &text),
        }
        ControlFlow::Continue(())
    }

    fn begin_variation(
        &mut self,
        movetext: &mut Self::Movetext,
    ) -> ControlFlow<Self::Output, Skip> {
        let frame = movetext.frame();
        // A variation replaces the previous move, so there must be one to replace.
        let start = (!frame.broken && !frame.moves.is_empty()).then(|| frame.before_last.clone());
        let Some(start) = start.filter(|_| movetext.skipped_depth == 0) else {
            movetext.skipped_depth += 1;
            return ControlFlow::Continue(Skip(true));
        };
        movetext.stack.push(Frame::new(start));
        ControlFlow::Continue(Skip(false))
    }

    fn end_variation(&mut self, movetext: &mut Self::Movetext) -> ControlFlow<Self::Output> {
        if movetext.skipped_depth > 0 {
            movetext.skipped_depth -= 1;
            return ControlFlow::Continue(());
        }
        // Ignore a `)` without a matching `(`.
        if movetext.stack.len() > 1 {
            let variation = movetext.stack.pop().expect("checked above");
            if let Some(last) = movetext.frame().moves.last_mut()
                && !variation.moves.is_empty()
            {
                last.variations.push(variation.moves);
            }
        }
        ControlFlow::Continue(())
    }

    fn outcome(
        &mut self,
        movetext: &mut Self::Movetext,
        outcome: Outcome,
    ) -> ControlFlow<Self::Output> {
        // The movetext result wins over a missing or placeholder `Result` tag.
        let result = outcome.to_string();
        match movetext
            .headers
            .iter_mut()
            .find(|(name, _)| name == "Result")
        {
            Some((_, value)) if value == "*" || value.is_empty() => *value = result,
            Some(_) => {}
            None => movetext.headers.push(("Result".into(), result)),
        }
        ControlFlow::Continue(())
    }

    fn end_game(&mut self, mut movetext: Self::Movetext) -> Self::Output {
        // Close variations left open by a missing `)`.
        while movetext.stack.len() > 1 {
            let _ = self.end_variation(&mut movetext);
        }
        let mut main = movetext.stack.pop().expect("the main line is never popped");
        // A comment before the first move (or in a game without moves) is about the starting
        // position.
        let comment = match main.moves.first_mut() {
            Some(first) => first.starting_comment.take(),
            None => main.pending_comment.take(),
        };
        Ok(ImportedGame {
            game: Game {
                headers: movetext.headers,
                start_fen: movetext.start_fen,
                comment,
                moves: main.moves,
            },
            warnings: movetext.warnings,
        })
    }
}

fn append_comment(target: &mut Option<String>, text: &str) {
    if text.is_empty() {
        return;
    }
    match target {
        Some(existing) => {
            existing.push(' ');
            existing.push_str(text);
        }
        None => *target = Some(text.to_owned()),
    }
}

/// Splits an `[%eval …]` command out of a comment, returning the remaining text and the score.
fn extract_eval(comment: &str) -> (String, Option<Score>) {
    let Some(start) = comment.find("[%eval") else {
        return (normalize_space(comment), None);
    };
    let Some(len) = comment[start..].find(']') else {
        return (normalize_space(comment), None);
    };
    let body = comment[start + "[%eval".len()..start + len].trim();
    // The value may be followed by a search depth, as in `[%eval 0.31,22]`.
    let value = body.split(',').next().unwrap_or("").trim();
    let score = match value.strip_prefix('#') {
        Some(mate) => mate.parse().ok().map(Score::Mate),
        // `[%eval]` gives pawns; anything beyond an `i32` of centipawns is nonsense.
        None => value
            .parse::<f64>()
            .ok()
            .map(|pawns| (pawns * 100.0).round())
            .filter(|cp| cp.abs() <= f64::from(i32::MAX))
            .map(|cp| Score::Cp(cp as i32)),
    };
    let rest = format!("{} {}", &comment[..start], &comment[start + len + 1..]);
    (normalize_space(&rest), score)
}

fn normalize_space(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

// --- Export -------------------------------------------------------------------------------------

/// Writes a game as PGN. Fails if a move is illegal in its position.
pub fn write(game: &Game) -> Result<String, String> {
    let start = parse_fen(&game.start_fen)?;
    let mut out = String::new();

    let tag = |name: &str| {
        game.headers
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    };
    let custom_start = fen_of(&start) != STARTING_FEN;
    for (name, default) in SEVEN_TAG_ROSTER {
        write_tag(
            &mut out,
            name,
            tag(name).filter(|v| !v.is_empty()).unwrap_or(default),
        );
    }
    if custom_start {
        write_tag(&mut out, "SetUp", "1");
        write_tag(&mut out, "FEN", &game.start_fen);
    }
    for (name, value) in &game.headers {
        let reserved =
            SEVEN_TAG_ROSTER.iter().any(|(n, _)| n == name) || name == "SetUp" || name == "FEN";
        if !reserved && is_tag_name(name) {
            write_tag(&mut out, name, value);
        }
    }
    out.push('\n');

    let mut text = MovetextWriter::default();
    if let Some(comment) = &game.comment {
        text.comment(comment);
    }
    write_line(&mut text, &start, &game.moves)?;
    text.token(tag("Result").filter(|v| !v.is_empty()).unwrap_or("*"));
    out.push_str(&text.out);
    out.push('\n');
    Ok(out)
}

fn is_tag_name(name: &str) -> bool {
    !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn write_tag(out: &mut String, name: &str, value: &str) {
    let value = value.replace('\\', "\\\\").replace('"', "\\\"");
    out.push_str(&format!("[{name} \"{value}\"]\n"));
}

fn write_line(text: &mut MovetextWriter, start: &Chess, line: &[Move]) -> Result<(), String> {
    let mut pos = start.clone();
    // Black's moves need a number at the start of a line and after a comment or variation.
    let mut needs_number = true;
    for m in line {
        if let Some(comment) = &m.starting_comment {
            needs_number |= text.comment(comment);
        }
        if pos.turn() == Color::White || needs_number {
            text.token(&move_number(&pos));
        }

        let before = pos.clone();
        let parsed = m
            .san
            .parse::<San>()
            .map_err(|e| format!("could not read move `{}`: {e}", m.san))?;
        let played = parsed
            .to_move(&pos)
            .map_err(|e| format!("{} {} is not legal: {e}", move_number(&pos), m.san))?;
        let san = SanPlus::from_move_and_play_unchecked(&mut pos, played);

        let mut token = san.to_string();
        for &nag in &m.nags {
            match nag_glyph(nag) {
                Some(glyph) => token.push_str(glyph),
                None => {
                    text.token(&token);
                    token = Nag(nag).to_string();
                }
            }
        }
        text.token(&token);

        let mut comment = m.eval.map(eval_command).unwrap_or_default();
        if let Some(c) = &m.comment {
            if !comment.is_empty() {
                comment.push(' ');
            }
            comment.push_str(c);
        }
        needs_number = text.comment(&comment);

        for variation in &m.variations {
            if variation.is_empty() {
                continue;
            }
            text.token("(");
            write_line(text, &before, variation)?;
            text.token(")");
            needs_number = true;
        }
    }
    Ok(())
}

/// The suffix form of the move-quality NAGs, which PGN allows directly after the move.
fn nag_glyph(nag: u8) -> Option<&'static str> {
    match nag {
        1 => Some("!"),
        2 => Some("?"),
        3 => Some("!!"),
        4 => Some("??"),
        5 => Some("!?"),
        6 => Some("?!"),
        _ => None,
    }
}

fn eval_command(score: Score) -> String {
    match score {
        Score::Cp(cp) => format!("[%eval {:.2}]", f64::from(cp) / 100.0),
        Score::Mate(moves) => format!("[%eval #{moves}]"),
    }
}

/// Joins movetext tokens with spaces, wrapping lines at [`LINE_WIDTH`].
#[derive(Default)]
struct MovetextWriter {
    out: String,
    line_len: usize,
}

impl MovetextWriter {
    fn token(&mut self, token: &str) {
        let glue = self.out.is_empty() || self.out.ends_with('(') || token == ")";
        if !glue {
            if self.line_len + 1 + token.len() >= LINE_WIDTH {
                self.out.push('\n');
                self.line_len = 0;
            } else {
                self.out.push(' ');
                self.line_len += 1;
            }
        }
        self.out.push_str(token);
        self.line_len += token.len();
    }

    /// Writes `{ comment }`, returning whether anything was written.
    fn comment(&mut self, comment: &str) -> bool {
        // `}` would end the comment early and PGN has no escape for it.
        let comment = comment.replace('}', ")");
        let mut words = comment.split_whitespace().peekable();
        if words.peek().is_none() {
            return false;
        }
        self.token("{");
        for word in words {
            self.token(word);
        }
        self.token("}");
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"[Event "Casual game"]
[White "Whiskers"]
[Black "Mochi"]
[Result "*"]

{ A quiet start. } 1. e4 { [%eval 0.3] } e5 2. Nf3 Nc6 3. Bc4 Bc5! { [%eval 0.30,21] Solid. }
(3... Nf6 4. Ng5 d5 (4... Bc5 5. Bxf7+) 5. exd5 Na5?! { The Two Knights is sharper. })
(3... Be7 $6) 4. c3 Nf6 *
"#;

    fn sans(line: &[Move]) -> Vec<&str> {
        line.iter().map(|m| m.san.as_str()).collect()
    }

    fn only_game(pgn: &str) -> ImportedGame {
        let mut parsed = parse_str(pgn, 10);
        assert!(parsed.errors.is_empty(), "{:?}", parsed.errors);
        assert_eq!(parsed.games.len(), 1);
        parsed.games.remove(0)
    }

    #[test]
    fn reads_moves_variations_and_annotations() {
        let ImportedGame { game, warnings } = only_game(SAMPLE);
        assert!(warnings.is_empty(), "{warnings:?}");
        assert_eq!(game.start_fen, STARTING_FEN);
        assert_eq!(
            sans(&game.moves),
            ["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "c3", "Nf6"]
        );

        assert_eq!(game.comment.as_deref(), Some("A quiet start."));
        let e4 = &game.moves[0];
        assert_eq!(e4.starting_comment, None);
        assert_eq!(e4.eval, Some(Score::Cp(30)));
        assert_eq!(e4.comment, None);
        assert_eq!(e4.uci, "e2e4");
        assert_eq!(
            e4.fen,
            "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"
        );

        let bc5 = &game.moves[5];
        assert_eq!(bc5.nags, [1]);
        assert_eq!(bc5.eval, Some(Score::Cp(30)));
        assert_eq!(bc5.comment.as_deref(), Some("Solid."));
        assert_eq!(bc5.variations.len(), 2);

        let two_knights = &bc5.variations[0];
        assert_eq!(sans(two_knights), ["Nf6", "Ng5", "d5", "exd5", "Na5"]);
        assert_eq!(two_knights[4].nags, [6]);
        assert_eq!(sans(&two_knights[2].variations[0]), ["Bc5", "Bxf7+"]);
        assert_eq!(bc5.variations[1][0].nags, [6]);
    }

    #[test]
    fn reads_custom_start_and_castling() {
        let pgn = r#"[FEN "r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 3 30"]

30... O-O-O 31. O-O 1-0"#;
        let ImportedGame { game, warnings } = only_game(pgn);
        assert!(warnings.is_empty());
        assert_eq!(game.moves[0].uci, "e8c8");
        assert_eq!(game.moves[1].uci, "e1g1");
        assert_eq!(game.moves[1].fen, "2kr3r/8/8/8/8/8/8/R4RK1 b - - 5 31");
        assert!(game.headers.contains(&("Result".into(), "1-0".into())));
    }

    #[test]
    fn keeps_moves_before_an_illegal_one() {
        let ImportedGame { game, warnings } = only_game("1. e4 e5 2. Ke3 Nc6 (2... Nf6) 3. Bb5 *");
        assert_eq!(sans(&game.moves), ["e4", "e5"]);
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("2. Ke3"), "{}", warnings[0]);
    }

    #[test]
    fn reports_games_with_a_broken_fen() {
        let parsed = parse_str("[FEN \"nonsense\"]\n\n1. e4 *\n\n1. d4 *", 10);
        assert_eq!(parsed.games.len(), 1);
        assert_eq!(parsed.errors.len(), 1);
        assert!(parsed.errors[0].starts_with("Game 1:"));
    }

    #[test]
    fn stops_after_max_games() {
        let parsed = parse_str("1. e4 *\n\n1. d4 *\n\n1. c4 *", 2);
        assert_eq!(parsed.games.len(), 2);
        assert!(parsed.truncated);
        assert!(!parse_str("1. e4 *\n\n1. d4 *", 2).truncated);
    }

    #[test]
    fn reads_mate_scores() {
        let game = only_game("1. e4 { [%eval #-3] [%clk 0:03:00] } *").game;
        assert_eq!(game.moves[0].eval, Some(Score::Mate(-3)));
        assert_eq!(game.moves[0].comment.as_deref(), Some("[%clk 0:03:00]"));
    }

    #[test]
    fn writes_what_it_reads() {
        let game = only_game(SAMPLE).game;
        let written = write(&game).expect("sample game should be writable");
        assert_eq!(
            written,
            r#"[Event "Casual game"]
[Site "?"]
[Date "????.??.??"]
[Round "?"]
[White "Whiskers"]
[Black "Mochi"]
[Result "*"]

{ A quiet start. } 1. e4 { [%eval 0.30] } 1... e5 2. Nf3 Nc6 3. Bc4 Bc5! {
[%eval 0.30] Solid. } (3... Nf6 4. Ng5 d5 (4... Bc5 5. Bxf7+) 5. exd5 Na5?! {
The Two Knights is sharper. }) (3... Be7?!) 4. c3 Nf6 *
"#
        );
        // Reading it back gives the same moves; only the missing roster tags were added.
        let reread = only_game(&written).game;
        assert_eq!(reread.moves, game.moves);
        assert_eq!(reread.headers.len(), SEVEN_TAG_ROSTER.len());
    }

    #[test]
    fn writes_custom_start_tags_and_black_move_numbers() {
        let fen = "r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 3 30";
        let game = only_game(&format!("[FEN \"{fen}\"]\n\n30... O-O-O 31. O-O *")).game;
        let written = write(&game).unwrap();
        assert!(written.contains("[SetUp \"1\"]\n[FEN \"r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 3 30\"]"));
        assert!(written.ends_with("\n30... O-O-O 31. O-O *\n"), "{written}");
    }

    #[test]
    fn refuses_illegal_moves_on_export() {
        let mut game = only_game("1. e4 e5 *").game;
        game.moves[1].san = "Ke7".into();
        assert!(write(&game).unwrap_err().contains("1... Ke7"));
    }

    #[test]
    fn keeps_comments_and_shapes_on_the_starting_position() {
        let game = only_game("{ [%cal Ge2e4] Start here. } *").game;
        assert!(game.moves.is_empty());
        assert_eq!(game.comment.as_deref(), Some("[%cal Ge2e4] Start here."));
        let written = write(&game).unwrap();
        assert!(
            written.ends_with("\n{ [%cal Ge2e4] Start here. } *\n"),
            "{written}"
        );
        assert_eq!(only_game(&written).game.comment, game.comment);
    }

    #[test]
    fn round_trips_through_json() {
        let game = only_game(SAMPLE).game;
        let json = serde_json::to_string(&game).unwrap();
        assert!(json.contains(r#""startFen":"#));
        assert!(json.contains(r#""eval":{"cp":30}"#));
        assert_eq!(serde_json::from_str::<Game>(&json).unwrap(), game);
    }
}
