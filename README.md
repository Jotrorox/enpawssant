# EnPawssant

A cat-themed chess analysis app for macOS and Windows, built with Tauri 2, SolidJS and Stockfish.

> Early foundation: the game view UI is in place and the board is fully playable, but the game,
> analysis and explorer are placeholder data; only the engine name comes from the bundled Stockfish.

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
│   └── chess-core/         # Chess logic (shakmaty), independent of Tauri
├── scripts/
│   └── fetch-stockfish.mjs # Downloads Stockfish as a Tauri sidecar
├── src/                    # SolidJS + TypeScript frontend
│   ├── assets/pieces/      # cburnett piece SVGs (BSD, see README there)
│   └── chess/              # Board helpers, move rules, piece images, move sounds
└── src-tauri/              # Tauri app (Rust backend)
    ├── binaries/           # Stockfish sidecar (downloaded, git-ignored)
    ├── capabilities/       # Frontend permissions (no shell access)
    ├── src/
    │   ├── engine.rs       # Spawns Stockfish and talks UCI
    │   └── lib.rs          # Tauri setup and commands
    └── tauri.conf.json
```

The engine is only ever spawned from Rust; the frontend has no shell permissions and talks to the
backend through Tauri commands such as `engine_info`.

## License

BSD 3-Clause, see [LICENSE](LICENSE). Stockfish is downloaded separately and is licensed under the GPLv3.
The chess pieces are Colin M.L. Burnett's "cburnett" set, used under the BSD license; see
[src/assets/pieces/README.md](src/assets/pieces/README.md).
