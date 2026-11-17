# EnPawssant

A cat-themed chess analysis app for macOS and Windows, built with Tauri 2, SolidJS and Stockfish.

> Early foundation: the board is fully playable, the bundled Stockfish (or any UCI engine) analyses
> every position live, games can be imported and exported as PGN, kept in a local game database and
> explored by position, you can play against Stockfish with a clock or on lichess.org, and there are
> puzzles from the Lichess puzzle database.

## The board

The board is written from scratch, with no chess or UI libraries. Move generation (castling,
en passant, promotion, check and SAN) lives in `src/chess/rules.ts`.

- Drag pieces or click a piece and then its target. Legal moves are shown as dots and capture rings.
- Pieces lift under the pointer, glide between squares and land with a little squash and ripple.
  Captures burst, promotions sparkle, a checked king wobbles and a checkmated one tips over.
- Right-click or right-drag to draw circles and arrows (hold Shift, Alt or both for other colours).
- Sounds are synthesised with Web Audio (wooden knocks, a collar-bell "ting" for check, chimes for
  promotion and mate), timed to the moment a piece lands. Mute them from the board toolbar.
- Animations respect the system's reduced-motion setting.

## Live analysis

Stockfish runs as one long-lived process for the whole session and analyses whatever position is on
the board (`go infinite`, three lines with MultiPV). Rust parses its output, converts the lines to
SAN with `chess-core` (shakmaty) and streams snapshots, at most ten per second and with scores from
White's point of view, to the frontend over a Tauri channel. They drive the eval bar, the top lines,
the arrows, depth and speed, and the eval graph for every ply analysed so far.

Moving to another position stops the running search, waits for the engine to finish it and only
then starts the new one, so stale lines never reach the board. Checkmate and stalemate are answered
without asking the engine.

## Play

The **Play** section in the side rail starts every kind of game: against Stockfish on this machine,
against the Lichess AI, or against people on lichess.org. Each game opens in its own tab, with the
clocks, players and controls above the move list. The clock button in the board toolbar is a
shortcut to a game against Stockfish.

### Against Stockfish

- Pick your colour (or a random one), the engine's strength as an **Elo** (Stockfish's
  `UCI_LimitStrength`, 1320–3190) or a **skill level** (0–20, where 20 is full strength), and a time
  control: untimed, a preset such as 5+3, or your own minutes and increment. Games can start from
  the starting position or from the position on the board. The dialog remembers your last choices.
- The opponent is a second Stockfish process with one thread, so its strength settings never touch
  the analysis engine. It gets the whole game as moves (so it sees repetitions) and both clocks with
  `go wtime … btime …`, keeping 100 ms per move in reserve for the trip to the UI. Untimed games give
  it about a second per move.
- The clocks run in the app and keep running while another tab is open. Checkmate, stalemate,
  threefold repetition, the fifty-move rule and dead positions end the game automatically; running
  out of time loses unless the other side has nothing left to mate with. Resigning takes two clicks.

### On Lichess

Games on lichess.org are played through the [Board API](https://lichess.org/api#tag/Board) and
need a free Lichess account. Signing in asks for permission to play games and to send and answer
challenges (`board:play`, `challenge:read`, `challenge:write`). Accounts signed in before playing
was supported are asked to sign in once more; the old token is revoked.

- **Lichess AI**: Stockfish on lichess.org at levels 1 to 8, at 5+3 up to 30+20 or unlimited.
- **Play a person**: rapid, classical or correspondence games (the speeds Lichess lets apps play
  people at), rated or casual. **Seek a game** finds anyone looking for the same game; a real-time
  seek lasts until a game starts or you cancel it, and a correspondence seek stays up on Lichess
  until someone takes it. **Challenge** sends a challenge to one player.
- **Challenges** to you show up as they arrive (with a toast, and a badge on the Play icon) to
  accept or decline; your own can be cancelled.
- In a game, Lichess has the final word: the board shows your move straight away and takes it back
  if Lichess refuses it. You can abort until both players have moved, resign (two clicks), offer or
  accept a draw, ask for or accept a takeback, and claim the game when your opponent leaves.
  Games against people have a chat.
- **Reconnecting**: a game's tab reconnects by itself when the connection drops. Real-time games
  still in progress reopen when the app starts (Lichess reports them as soon as it connects), and
  open game tabs pick up where the game is now.
- **Ongoing games** lists your real-time and correspondence games, whose turn it is and the time
  left. Correspondence games stay there between moves; click one to open it. The Play icon counts
  the correspondence games waiting for your move.

Everything goes through Rust (`src-tauri/src/board.rs`): the token never reaches the frontend, and
game IDs, moves and usernames are checked before they become part of a request. Streams (the
account's events, each open game and real-time seeks) run as long as they're needed and are
stopped when their tab closes or the seek is cancelled.

### Fair play

While any game is in progress the whole app plays fair, not just the game's tab. Live analysis
(including an engine running alongside), the eval bar and graph, arrows, the opening explorer and
full-game analysis are off in every tab, and so is every way of getting the position out: Copy FEN,
Export PGN and the database's **Board position** button. Other tabs say where the game is and take
you back to it. Everything returns as soon as the game ends. An open correspondence game counts as
in progress, so close its tab to analyse other games between moves.

You can step back through the moves during a game; the board takes your move again once you're
back at the end. A game's result and time control go into the PGN headers.

### After the game

**Analyse this game** appears on the play card once any game is over, against Stockfish or on
Lichess. It opens the game in a new, ordinary tab with live analysis, the explorer and everything
else, and starts the full-game analysis there straight away (unless another game is still on). The
game's own tab keeps its clocks and result.

## Games

Each game tab holds a move tree (`src/chess/tree.ts`), so trying a different move never throws the
game away: it becomes a variation.

- Playing a move that differs from the next one in the game starts a variation; playing the same
  move just follows the game. Variations can nest.
- Click any move, including moves in variations, to jump to it. Arrow keys step through the current
  line (stepping back and forward stays in a variation), ↑/↓ switch between alternatives to the
  current move, and Home/End jump to the start or end of the line.
- Right-click a move to make its line the main line or to delete it and everything after it.
- **Import PGN** (board toolbar) reads pasted text or a `.pgn` file; each game opens in its own tab.
  Files with several games show a picker. Variations, comments, NAGs and lichess-style
  `[%eval]` scores are kept, and illegal moves are skipped with a warning. Imported scores fill
  the eval bar and graph for positions the engine hasn't analysed yet.
- **Export PGN** shows the game as PGN to copy or save, including variations, comments and NAGs.
- Open tabs are saved as you go (games, variations, comments and the current position) and reopen
  on the next launch. With nothing to restore, the app starts on an empty board.

PGN parsing and writing happen in Rust (`crates/chess-core/src/pgn.rs`, built on `shakmaty` and
`pgn-reader`). File dialogs are opened from Rust too, so the frontend needs no file system or dialog
permissions.

## Opening explorer

The explorer card names the opening of the current position and lists the moves played from it,
with how often each was played and how those games ended.

- **Opening names** come from the [lichess `chess-openings`](https://github.com/lichess-org/chess-openings)
  tables (CC0), bundled in `crates/chess-core/data/openings`. They are looked up by position, so
  transpositions are named too, and positions past the book keep the last name on the line.
- **Masters** (over-the-board games between strong players) and **Lichess** (blitz, rapid and
  classical games by players rated 1600 and up) come from the [Lichess explorer API](https://lichess.org/api#tag/Opening-Explorer).
  Click a move to play it; moves already in the game tree are highlighted.
- Lichess only answers signed-in requests, so the explorer asks you to **sign in with Lichess**
  once. This uses OAuth with PKCE: lichess.org opens in your browser and redirects back to a
  one-shot listener on `127.0.0.1`. The token, which also lets you play (see
  [On Lichess](#on-lichess)), is kept in the macOS Keychain or Windows Credential Manager and never
  reaches the frontend. **Sign out** revokes it.
- Results are cached for the session, and requests wait until you stop stepping through moves.
  After Lichess rate limits the app, requests pause for a minute.
- **My games** shows the same statistics for the games in your local database, no account needed.

## Files

The **Files** section lists recently opened PGN files and has a folder browser that shows only
folders and `.pgn` files. Choosing a file lists its games: open one, open them all, or add the whole
file to the game database. PGN files can be dropped anywhere on the window: they open (with a game
picker for several games), or are imported when the Database section is showing. The browser goes
through Rust commands that only list folders and PGN files and only read `.pgn` files.

## Game database

Games live in SQLite (`games.sqlite` in the app data folder), with every main-line position keyed by
its Zobrist hash (`crates/chess-core/src/index.rs`). That makes "every game that reached this
position" a single index lookup, and transpositions count as the same position.

- **Import PGN…** (or drop files) streams games in batches with progress, so files of any size work;
  duplicates are skipped and an import can be stopped. **Add board game** and the database button in
  the board toolbar save the game on the board.
- Search by any text (players, event, site, opening; every word must match), player, opening or ECO,
  result and position. **Board position** fills in the current FEN. Results open in a new tab, at the
  searched position for position searches.
- The title-bar search box (⌘K / Ctrl K) searches the database; a FEN searches by position.
- Games without an `Opening` tag are named from the opening tables.

## Engines

The **Engines** section manages UCI engines: the bundled Stockfish plus any engine binary you add
(it is started once to check that it speaks UCI and to read its options). For each engine:

- every UCI option is editable (spins, checks, combos, strings); the engine restarts with new values.
  `Threads` and `Hash` default to all cores but one and 256 MB unless you change them. Options the
  app sets per search (`MultiPV` and friends) are not offered.
- **Use for analysis** makes it the engine behind the lines, eval bar, arrows and full-game analysis.
  The engine card on the board also has a menu to switch.
- **Run alongside** starts a second engine on the same positions; its lines show under the main
  engine's.

The setup is kept in `engines.json` in the app config folder. Engines are only ever started from
Rust; the frontend refers to them by ID and picks binaries through the native file dialog.

## Purrzles

Puzzles from the [Lichess puzzle database](https://database.lichess.org/#puzzles) (CC0). A starter
pack of about 2,200 puzzles across every rating band is bundled
(`crates/chess-core/data/puzzles`), so puzzles work offline right away. **Download all puzzles**
fetches the full database (about 300 MB) and keeps the well-liked, often played ones (about
1.3 million, similar size on disk).

- **Rated**: puzzles near your puzzle rating, which moves (Elo) after the first try at each puzzle.
  Wrong moves can be retried but count as a miss, as do hints (first the piece, then the move) and
  the solution. Filter by theme, such as forks or mate in 2.
- **Streak**: puzzles get harder with every solve; one mistake ends the run. Your best run is kept.
- Any checkmate counts as the final move of a mating puzzle. **Analyze on the board** opens the
  puzzle and its solution in a tab.
- Progress lives in `puzzles.sqlite` in the app data folder; **Reset progress** forgets it.

## Prerequisites

- **[rustup](https://rustup.rs/)**: the toolchain, components (`rustfmt`, `clippy`) and macOS targets
  are pinned in `rust-toolchain.toml` and installed automatically on first use.
- **[mise](https://mise.jdx.dev/)**: manages Node and pnpm (see `mise.toml`) and runs all project tasks.
- Platform requirements for Tauri: Xcode Command Line Tools on macOS; the MSVC build tools and
  WebView2 on Windows. See the [Tauri prerequisites](https://tauri.app/start/prerequisites/).

## Getting started

```sh
mise install    # installs the pinned Node and pnpm
mise run dev    # installs JS deps, downloads Stockfish, starts the app
```

The first `dev`/`build`/`check`/`test` run downloads the latest official Stockfish release for your
machine into `src-tauri/binaries/` (git-ignored). Later runs reuse it; run
`mise run fetch-engine --force` to update it. Set `GITHUB_TOKEN` if you hit GitHub API rate limits.

## Tasks

| Task                    | What it does                                                           |
| ----------------------- | ---------------------------------------------------------------------- |
| `mise run dev`          | Start the app in development mode                                      |
| `mise run build`        | Build a release bundle                                                 |
| `mise run check`        | `cargo clippy` (warnings as errors), `cargo fmt --check`, `tsc`, Biome |
| `mise run fmt`          | Format Rust (rustfmt) and TypeScript (Biome)                           |
| `mise run test`         | Run the Rust test suite                                                |
| `mise run fetch-engine` | Download the Stockfish sidecar for this host                           |
| `mise run install`      | Install JS dependencies (run automatically by the tasks above)         |

## Project layout

```
.
├── Cargo.toml              # Cargo workspace (src-tauri + crates/*)
├── rust-toolchain.toml     # Rust toolchain pin (rustup)
├── mise.toml               # Node/pnpm versions and project tasks
├── biome.json              # TS/JSON lint + format config
├── crates/
│   └── chess-core/         # Chess logic, PGN, opening names, position keys and puzzles, independent of Tauri
├── scripts/
│   └── fetch-stockfish.mjs # Downloads Stockfish as a Tauri sidecar
├── src/                    # SolidJS + TypeScript frontend
│   ├── assets/pieces/      # cburnett piece SVGs (BSD, see README there)
│   ├── chess/              # Board helpers, rules, game endings, move tree, PGN, engines, database, puzzles
│   ├── components/         # Board, panels and the side-rail sections (Play, Database, Engines, …)
│   └── game/               # Game sessions, games against Stockfish and on Lichess, clocks
└── src-tauri/              # Tauri app (Rust backend)
    ├── binaries/           # Stockfish sidecar (downloaded, git-ignored)
    ├── capabilities/       # Frontend permissions (no shell access)
    ├── src/
    │   ├── board.rs        # Playing on Lichess: event, game and seek streams, moves, challenges
    │   ├── database.rs     # Game database: import, search, position index, "My games" explorer
    │   ├── engine.rs       # UCI engine sessions: analysis engines and the opponent you play against
    │   ├── engines.rs      # Engine setup: added engines, options, analysis roles
    │   ├── explorer.rs     # Opening explorer and opening name commands
    │   ├── files.rs        # File browser: places, folder listings, reading PGN files
    │   ├── lichess.rs      # Lichess sign-in (OAuth PKCE), keychain token, API requests
    │   ├── pgn.rs          # PGN import/export commands and file dialogs
    │   ├── puzzles.rs      # Puzzles: starter pack, rating, streaks, full database download
    │   ├── store.rs        # SQLite files in the app data folder
    │   └── lib.rs          # Tauri setup and commands
    └── tauri.conf.json
```

The engine is only ever spawned from Rust; the frontend has no shell permissions and talks to the
backend through Tauri commands such as `engine_analyze` and `pgn_parse`.

## License

BSD 3-Clause, see [LICENSE](LICENSE). Stockfish is downloaded separately and is licensed under the GPLv3.
The opening names come from [lichess-org/chess-openings](https://github.com/lichess-org/chess-openings)
(CC0) and the puzzles from the [Lichess puzzle database](https://database.lichess.org/#puzzles) (CC0). The chess pieces are Colin M.L. Burnett's "cburnett" set, used under the BSD license; see
[src/assets/pieces/README.md](src/assets/pieces/README.md).
