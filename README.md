# EnPawssant

A cat-themed chess app for macOS, Windows and Linux, built with Tauri 2, SolidJS and Stockfish.

## Features

- **A board written from scratch**: legal-move hints, drawn arrows and circles, animations and
  synthesised sounds. No chess or UI libraries.
- **Live analysis** with the bundled Stockfish or any UCI engine: eval bar, top lines, arrows and an
  eval graph. A second engine can run alongside the first.
- **Game review**: full-game analysis with lichess-style accuracy and inaccuracy, mistake and
  blunder marks. Analysis can be stopped and resumed.
- **Play** against Stockfish at a chosen Elo or skill level with clocks and premoves, or on
  lichess.org against the Lichess AI or other people. While a game is on, the whole app plays fair.
- **Games**: a move tree with variations, PGN and FEN import and export, annotations (comments,
  NAGs, arrows), a board editor, and games fetched from Lichess and Chess.com.
- **Game database**: SQLite with a position index. Search by player, opening or position, and see
  how you score in each position in the "My games" opening explorer.
- **Opening explorer**: opening names, plus the Masters and Lichess databases.
- **Purrzles**: puzzles from the Lichess puzzle database, rated and streak modes, and puzzles built
  from your own blunders.
- **Settings**: light and dark themes, board colours, piece sets, and a native menu bar with
  keyboard shortcuts on macOS.
- **Updates in the app**: EnPawssant checks for a new version at launch and installs it from
  Settings.

See [docs/features.md](docs/features.md) for the full tour.

## Download

Get the latest `.dmg`, `.msi`/`.exe`, `.AppImage` or `.deb` from
[Releases](https://github.com/Jotrorox/enpawssant/releases/latest).

## Getting started

You need:

- **[rustup](https://rustup.rs/)**. The toolchain is pinned in `rust-toolchain.toml` and installs
  on first use.
- **[mise](https://mise.jdx.dev/)**, which provides Node and pnpm (`mise.toml`) and runs the
  project tasks.
- The [Tauri prerequisites](https://tauri.app/start/prerequisites/): Xcode Command Line Tools on
  macOS, the MSVC build tools and WebView2 on Windows, or WebKitGTK and friends on Linux (plus
  `libdbus-1-dev` for the keyring; `.github/actions/setup/action.yml` has the Ubuntu list).

```sh
mise install    # installs the pinned Node and pnpm
mise run dev    # installs JS deps, downloads Stockfish, starts the app
```

The first run downloads the latest official Stockfish for your machine into `src-tauri/binaries/`
(git-ignored). Run `mise run fetch-engine --force` to update it. Set `GITHUB_TOKEN` if you hit GitHub
API rate limits.

## Tasks

| Task                    | What it does                                                           |
| ----------------------- | ---------------------------------------------------------------------- |
| `mise run dev`          | Start the app in development mode                                      |
| `mise run build`        | Build a release bundle                                                 |
| `mise run check`        | `cargo clippy` (warnings as errors), `cargo fmt --check`, `tsc`, Biome |
| `mise run fmt`          | Format Rust (rustfmt) and TypeScript (Biome)                           |
| `mise run test`         | Run the Rust and TypeScript test suites                                |
| `mise run fetch-engine` | Download the Stockfish sidecar for this host                           |
| `mise run release <v>`  | Bump the version everywhere, commit and tag `v<v>` (never pushes)      |

CI runs `check` and `test` on macOS, Windows and Linux. Pushing a `v*` tag builds the installers
into a draft GitHub Release. The release process and signing setup are in
[docs/releasing.md](docs/releasing.md).

## Project layout

```
.
├── crates/chess-core/   # Chess logic, PGN, opening names, position index, puzzles (no Tauri)
├── scripts/             # Stockfish download and release helpers
├── src/                 # SolidJS + TypeScript frontend
│   ├── chess/           # Rules, move tree, PGN, engines, database, puzzles
│   ├── components/      # Board, panels, dialogs and side-rail sections
│   └── game/            # Game sessions, play against Stockfish and on Lichess, clocks
└── src-tauri/           # Tauri app (Rust backend): engines, database, Lichess, files, menus
```

Engines are only ever started from Rust. The frontend has no shell or file system permissions; it
talks to the backend through Tauri commands.

## License

BSD 3-Clause, see [LICENSE](LICENSE). Stockfish is downloaded separately and is licensed under the
GPLv3. Opening names come from [lichess-org/chess-openings](https://github.com/lichess-org/chess-openings)
(CC0) and puzzles from the [Lichess puzzle database](https://database.lichess.org/#puzzles) (CC0).
The piece sets are cburnett (BSD), Chessnut (Apache 2.0), and Fantasy and Spatial (MIT). See
[src/assets/pieces/README.md](src/assets/pieces/README.md).
