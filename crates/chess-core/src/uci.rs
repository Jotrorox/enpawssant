//! Parsing of the engine-to-GUI side of the UCI protocol.

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

/// The move of a `bestmove` line, or `None` for other lines and for
/// `bestmove (none)`, which engines send when there is no legal move.
pub fn parse_bestmove(line: &str) -> Option<&str> {
    let mut tokens = line.split_whitespace();
    match (tokens.next(), tokens.next()) {
        (Some("bestmove"), Some(mv)) if mv != "(none)" => Some(mv),
        _ => None,
    }
}

/// A numeric engine option, from an `option name <name> type spin ...` line.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct SpinOption {
    pub default: i64,
    pub min: i64,
    pub max: i64,
}

/// Parses an `option` line declaring a `spin` option. Returns its name and
/// bounds, or `None` for any other line.
pub fn parse_spin_option(line: &str) -> Option<(&str, SpinOption)> {
    let rest = line.strip_prefix("option name ")?;
    // Names may contain spaces, so the name runs up to the `type` keyword.
    let (name, rest) = rest.split_once(" type ")?;
    let mut tokens = rest.split_whitespace();
    if tokens.next()? != "spin" {
        return None;
    }
    let (mut default, mut min, mut max) = (None, None, None);
    while let Some(keyword) = tokens.next() {
        let value = tokens.next()?.parse().ok()?;
        match keyword {
            "default" => default = Some(value),
            "min" => min = Some(value),
            "max" => max = Some(value),
            _ => {}
        }
    }
    Some((
        name.trim(),
        SpinOption {
            default: default?,
            min: min?,
            max: max?,
        },
    ))
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
    fn parses_bestmove() {
        assert_eq!(parse_bestmove("bestmove e2e4 ponder e7e5"), Some("e2e4"));
        assert_eq!(parse_bestmove("bestmove e7e8q"), Some("e7e8q"));
        assert_eq!(parse_bestmove("bestmove (none)"), None);
        assert_eq!(parse_bestmove("bestmove"), None);
        assert_eq!(parse_bestmove("info pv e2e4"), None);
    }

    #[test]
    fn parses_spin_options() {
        assert_eq!(
            parse_spin_option("option name UCI_Elo type spin default 1320 min 1320 max 3190"),
            Some((
                "UCI_Elo",
                SpinOption {
                    default: 1320,
                    min: 1320,
                    max: 3190
                }
            ))
        );
        assert_eq!(
            parse_spin_option("option name Skill Level type spin default 20 min 0 max 20"),
            Some((
                "Skill Level",
                SpinOption {
                    default: 20,
                    min: 0,
                    max: 20
                }
            ))
        );
        assert_eq!(
            parse_spin_option("option name UCI_LimitStrength type check default false"),
            None
        );
        assert_eq!(
            parse_spin_option("option name Clear Hash type button"),
            None
        );
        assert_eq!(parse_spin_option("id name Stockfish 19"), None);
    }
}
