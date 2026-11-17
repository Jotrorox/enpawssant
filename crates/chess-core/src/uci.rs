//! Parsing of the engine-to-GUI side of the UCI protocol.

use serde::{Deserialize, Serialize};

/// An engine score as UCI reports it.
///
/// Whose point of view it is from depends on context: the engine reports scores
/// for the side to move, see [`crate::AnalysisRoot::white_score`].
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum Score {
    /// Centipawns.
    Cp(i32),
    /// Moves (not plies) to mate; negative when the side is getting mated.
    Mate(i32),
}

impl Score {
    /// The same score from the other side's point of view.
    #[must_use]
    pub fn flip(self) -> Score {
        match self {
            Score::Cp(cp) => Score::Cp(-cp),
            Score::Mate(moves) => Score::Mate(-moves),
        }
    }
}

/// The fields of a UCI `info` line that the analysis needs. Missing fields are `None`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Info {
    pub depth: Option<u32>,
    pub seldepth: Option<u32>,
    /// 1-based rank of the line; engines leave it out when MultiPV is 1.
    pub multipv: Option<u32>,
    pub score: Option<Score>,
    pub nodes: Option<u64>,
    pub nps: Option<u64>,
    pub time_ms: Option<u64>,
    /// Principal variation as UCI moves such as `e2e4` or `e7e8q`.
    pub pv: Vec<String>,
}

/// Keywords that can follow `info`. Anything else is treated as an argument of
/// the keyword before it.
const INFO_KEYWORDS: &[&str] = &[
    "depth",
    "seldepth",
    "time",
    "nodes",
    "pv",
    "multipv",
    "score",
    "currmove",
    "currmovenumber",
    "hashfull",
    "nps",
    "tbhits",
    "sbhits",
    "cpuload",
    "string",
    "refutation",
    "currline",
    "wdl",
];

/// Parses a UCI `info` line. Returns `None` for any other kind of line, or when
/// a known field has a malformed value.
pub fn parse_info(line: &str) -> Option<Info> {
    let mut tokens = line.split_whitespace().peekable();
    if tokens.next()? != "info" {
        return None;
    }

    let mut info = Info::default();
    while let Some(keyword) = tokens.next() {
        match keyword {
            "depth" => info.depth = Some(tokens.next()?.parse().ok()?),
            "seldepth" => info.seldepth = Some(tokens.next()?.parse().ok()?),
            "multipv" => info.multipv = Some(tokens.next()?.parse().ok()?),
            "nodes" => info.nodes = Some(tokens.next()?.parse().ok()?),
            "nps" => info.nps = Some(tokens.next()?.parse().ok()?),
            "time" => info.time_ms = Some(tokens.next()?.parse().ok()?),
            "score" => {
                let kind = tokens.next()?;
                let value = tokens.next()?.parse().ok()?;
                info.score = Some(match kind {
                    "cp" => Score::Cp(value),
                    "mate" => Score::Mate(value),
                    _ => return None,
                });
                // A bound means the score is only a lower or upper limit. It is
                // still the engine's freshest opinion, so it is kept as is.
                tokens.next_if(|t| matches!(*t, "lowerbound" | "upperbound"));
            }
            "pv" => {
                while let Some(mv) = tokens.next_if(|t| !INFO_KEYWORDS.contains(t)) {
                    info.pv.push(mv.to_owned());
                }
            }
            // Free text runs to the end of the line.
            "string" => break,
            // Fields the analysis doesn't use: skip their arguments.
            _ => while tokens.next_if(|t| !INFO_KEYWORDS.contains(t)).is_some() {},
        }
    }
    Some(info)
}

/// Extracts the value of an `id name <value>` line.
pub fn parse_id_name(line: &str) -> Option<&str> {
    let mut tokens = line.splitn(3, char::is_whitespace);
    match (tokens.next(), tokens.next(), tokens.next()) {
        (Some("id"), Some("name"), Some(value)) if !value.trim().is_empty() => Some(value.trim()),
        _ => None,
    }
}

/// Whether the line is the `bestmove` that ends a search.
pub fn is_bestmove(line: &str) -> bool {
    line.split_whitespace().next() == Some("bestmove")
}

/// An option an engine offers in its `option` lines, e.g. `Hash` or `Skill Level`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UciOption {
    pub name: String,
    #[serde(flatten)]
    pub kind: OptionKind,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum OptionKind {
    Check {
        default: bool,
    },
    Spin {
        default: i64,
        min: i64,
        max: i64,
    },
    Combo {
        default: String,
        choices: Vec<String>,
    },
    /// Triggers an action, e.g. `Clear Hash`; it has no value.
    Button,
    String {
        default: String,
    },
}

impl UciOption {
    /// The default value as it would be sent with `setoption`, or `None` for buttons.
    pub fn default_value(&self) -> Option<String> {
        match &self.kind {
            OptionKind::Check { default } => Some(default.to_string()),
            OptionKind::Spin { default, .. } => Some(default.to_string()),
            OptionKind::Combo { default, .. } | OptionKind::String { default } => {
                Some(default.clone())
            }
            OptionKind::Button => None,
        }
    }

    /// Checks a value for this option and brings it into the form engines expect: spins are
    /// clamped to their range and combo values take the engine's spelling.
    pub fn normalize(&self, value: &str) -> Result<String, String> {
        let value = value.trim();
        match &self.kind {
            OptionKind::Check { .. } => match value.to_ascii_lowercase().as_str() {
                "true" => Ok("true".into()),
                "false" => Ok("false".into()),
                _ => Err(format!("{} must be true or false", self.name)),
            },
            OptionKind::Spin { min, max, .. } => value
                .parse::<i64>()
                .map(|n| n.clamp(*min, (*max).max(*min)).to_string())
                .map_err(|_| format!("{} must be a whole number", self.name)),
            OptionKind::Combo { choices, .. } => choices
                .iter()
                .find(|choice| choice.eq_ignore_ascii_case(value))
                .cloned()
                .ok_or_else(|| format!("{value} is not a choice for {}", self.name)),
            // A line break would end the `setoption` command and start another one.
            OptionKind::String { .. } if value.contains(['\n', '\r']) => {
                Err(format!("{} must fit on one line", self.name))
            }
            OptionKind::String { .. } => Ok(value.to_owned()),
            OptionKind::Button => Err(format!("{} has no value", self.name)),
        }
    }

    /// The `setoption` command that sets this option to `value`, which must be normalised.
    pub fn set_command(&self, value: &str) -> String {
        match self.kind {
            OptionKind::Button => format!("setoption name {}", self.name),
            // UCI has no way to send an empty string, so `<empty>` stands for one.
            OptionKind::String { .. } if value.is_empty() => {
                format!("setoption name {} value <empty>", self.name)
            }
            _ => format!("setoption name {} value {value}", self.name),
        }
    }
}

/// Words that start a new field in an `option` line.
const OPTION_KEYWORDS: &[&str] = &["name", "type", "default", "min", "max", "var"];

/// Parses an `option` line. Returns `None` for any other line and for options that are malformed
/// or of an unknown type.
pub fn parse_option(line: &str) -> Option<UciOption> {
    let mut tokens = line.split_whitespace().peekable();
    if tokens.next()? != "option" || tokens.next()? != "name" {
        return None;
    }
    // Names may contain spaces, so they run up to `type`.
    let mut name = Vec::new();
    while let Some(token) = tokens.next_if(|t| *t != "type") {
        name.push(token);
    }
    tokens.next()?;
    let kind = tokens.next()?;

    let mut default: Option<String> = None;
    let mut min = None;
    let mut max = None;
    let mut choices = Vec::new();
    while let Some(keyword) = tokens.next() {
        let mut words = Vec::new();
        while let Some(word) = tokens.next_if(|t| !OPTION_KEYWORDS.contains(t)) {
            words.push(word);
        }
        let value = words.join(" ");
        match keyword {
            "default" => default = Some(value),
            "min" => min = Some(value.parse().ok()?),
            "max" => max = Some(value.parse().ok()?),
            "var" => choices.push(value),
            _ => {}
        }
    }
    let default_text = || match default.as_deref() {
        None | Some("<empty>") => String::new(),
        Some(text) => text.to_owned(),
    };

    let kind = match kind {
        "check" => OptionKind::Check {
            default: default.as_deref()?.eq_ignore_ascii_case("true"),
        },
        "spin" => OptionKind::Spin {
            default: default.as_deref()?.parse().ok()?,
            min: min?,
            max: max?,
        },
        "combo" => OptionKind::Combo {
            default: default_text(),
            choices,
        },
        "button" => OptionKind::Button,
        "string" => OptionKind::String {
            default: default_text(),
        },
        _ => return None,
    };
    let name = name.join(" ");
    (!name.is_empty()).then_some(UciOption { name, kind })
}

/// Extracts the value of an `id author <value>` line.
pub fn parse_id_author(line: &str) -> Option<&str> {
    let mut tokens = line.splitn(3, char::is_whitespace);
    match (tokens.next(), tokens.next(), tokens.next()) {
        (Some("id"), Some("author"), Some(value)) if !value.trim().is_empty() => Some(value.trim()),
        _ => None,
    }
}

/// The move of a `bestmove` line, or `None` for other lines and for
/// `bestmove (none)`, which engines send when there is no legal move.
pub fn parse_bestmove(line: &str) -> Option<&str> {
    let mut tokens = line.split_whitespace();
    match (tokens.next(), tokens.next()) {
        (Some("bestmove"), Some(mv)) if mv != "(none)" => Some(mv),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_multipv_line() {
        let line = "info depth 24 seldepth 33 multipv 2 score cp -17 nodes 4198231 nps 1739735 \
                    hashfull 523 tbhits 0 time 2413 pv e7e5 g1f3 b8c6";
        assert_eq!(
            parse_info(line),
            Some(Info {
                depth: Some(24),
                seldepth: Some(33),
                multipv: Some(2),
                score: Some(Score::Cp(-17)),
                nodes: Some(4_198_231),
                nps: Some(1_739_735),
                time_ms: Some(2413),
                pv: vec!["e7e5".into(), "g1f3".into(), "b8c6".into()],
            })
        );
    }

    #[test]
    fn parses_mate_scores_and_bounds() {
        let info = parse_info("info depth 9 score mate -3 lowerbound nodes 10 pv h7h8q").unwrap();
        assert_eq!(info.score, Some(Score::Mate(-3)));
        assert_eq!(info.nodes, Some(10));
        assert_eq!(info.pv, ["h7h8q"]);
    }

    #[test]
    fn skips_unused_fields_and_strings() {
        let info = parse_info("info depth 5 currmove e2e4 currmovenumber 1 wdl 10 980 10").unwrap();
        assert_eq!(info.depth, Some(5));
        assert!(info.pv.is_empty());

        let info = parse_info("info string NNUE evaluation using nn-1111.nnue depth 3").unwrap();
        assert_eq!(info, Info::default());
    }

    #[test]
    fn rejects_other_and_malformed_lines() {
        assert_eq!(parse_info("bestmove e2e4 ponder e7e5"), None);
        assert_eq!(parse_info("info depth deep"), None);
        assert_eq!(parse_info("info score wdl 1 2 3"), None);
    }

    #[test]
    fn parses_id_name() {
        assert_eq!(parse_id_name("id name Stockfish 19"), Some("Stockfish 19"));
        assert_eq!(parse_id_name("id author the Stockfish developers"), None);
        assert_eq!(parse_id_name("id name"), None);
        assert_eq!(parse_id_name("uciok"), None);
    }

    #[test]
    fn recognises_bestmove() {
        assert!(is_bestmove("bestmove e2e4 ponder e7e5"));
        assert!(is_bestmove("bestmove (none)"));
        assert!(!is_bestmove("info string bestmove"));
    }

    #[test]
    fn parses_options() {
        assert_eq!(
            parse_option("option name Hash type spin default 16 min 1 max 33554432"),
            Some(UciOption {
                name: "Hash".into(),
                kind: OptionKind::Spin {
                    default: 16,
                    min: 1,
                    max: 33_554_432
                },
            })
        );
        assert_eq!(
            parse_option("option name Clear Hash type button"),
            Some(UciOption {
                name: "Clear Hash".into(),
                kind: OptionKind::Button,
            })
        );
        assert_eq!(
            parse_option("option name Ponder type check default false"),
            Some(UciOption {
                name: "Ponder".into(),
                kind: OptionKind::Check { default: false },
            })
        );
        assert_eq!(
            parse_option("option name Debug Log File type string default <empty>"),
            Some(UciOption {
                name: "Debug Log File".into(),
                kind: OptionKind::String {
                    default: String::new()
                },
            })
        );
        assert_eq!(
            parse_option(
                "option name Style type combo default Normal var Solid var Normal var Risky Play"
            ),
            Some(UciOption {
                name: "Style".into(),
                kind: OptionKind::Combo {
                    default: "Normal".into(),
                    choices: vec!["Solid".into(), "Normal".into(), "Risky Play".into()],
                },
            })
        );
        assert_eq!(parse_option("option name Broken type spin default x"), None);
        assert_eq!(parse_option("option name Odd type colour"), None);
        assert_eq!(parse_option("id name Stockfish"), None);
    }

    #[test]
    fn normalizes_option_values() {
        let threads =
            parse_option("option name Threads type spin default 1 min 1 max 1024").unwrap();
        assert_eq!(threads.normalize(" 4 ").unwrap(), "4");
        assert_eq!(threads.normalize("5000").unwrap(), "1024");
        assert!(threads.normalize("many").is_err());
        assert_eq!(threads.set_command("4"), "setoption name Threads value 4");

        let check = parse_option("option name Ponder type check default false").unwrap();
        assert_eq!(check.normalize("TRUE").unwrap(), "true");
        assert!(check.normalize("yes").is_err());

        let combo =
            parse_option("option name Style type combo default Normal var Solid var Normal")
                .unwrap();
        assert_eq!(combo.normalize("solid").unwrap(), "Solid");
        assert!(combo.normalize("Wild").is_err());

        let path = parse_option("option name SyzygyPath type string default <empty>").unwrap();
        assert!(path.normalize("a\nquit").is_err());
        assert_eq!(
            path.set_command(""),
            "setoption name SyzygyPath value <empty>"
        );
        assert_eq!(path.default_value().as_deref(), Some(""));
    }

    #[test]
    fn parses_id_author() {
        assert_eq!(
            parse_id_author("id author the Stockfish developers"),
            Some("the Stockfish developers")
        );
        assert_eq!(parse_id_author("id name Stockfish"), None);
    }

    #[test]
    fn parses_bestmove() {
        assert_eq!(parse_bestmove("bestmove e2e4 ponder e7e5"), Some("e2e4"));
        assert_eq!(parse_bestmove("bestmove e7e8q"), Some("e7e8q"));
        assert_eq!(parse_bestmove("bestmove (none)"), None);
        assert_eq!(parse_bestmove("bestmove"), None);
        assert_eq!(parse_bestmove("info pv e2e4"), None);
    }
}
