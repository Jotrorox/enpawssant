# Features

A tour of what EnPawssant does and how each part works. For building and running the app, see the
[README](../README.md).

## The board

The board is written from scratch, with no chess or UI libraries. Move generation (castling,
en passant, promotion, check and SAN) lives in `src/chess/rules.ts`.

- Drag pieces or click a piece and then its target. Legal moves are shown as dots and capture rings.
- Pieces lift under the pointer, glide between squares and land with a little squash and ripple.
  Captures burst, promotions sparkle, a checked king wobbles and a checkmated one tips over.
- Right-click or right-drag to draw circles and arrows (hold Shift, Alt or both for other colours).
  They belong to the position they were drawn on and are saved with the game (see
  [Annotating](#annotating)); drawing the same shape again removes it.
- Sounds are synthesised with Web Audio (wooden knocks, a collar-bell "ting" for check, chimes for
  promotion and mate), timed to the moment a piece lands. Mute them from the board toolbar.
- Animations respect the system's reduced-motion setting.

## Live analysis

Stockfish runs as one long-lived process for the whole session and analyses whatever position is on
the board (`go infinite`, three lines with MultiPV by default; one to five in the settings). Rust
parses its output, converts the lines to
SAN with `chess-core` (shakmaty) and streams snapshots, at most ten per second and with scores from
White's point of view, to the frontend over a Tauri channel. They drive the eval bar, the top lines,
the arrows, depth and speed, and the eval graph for every ply analysed so far.

Moving to another position stops the running search, waits for the engine to finish it and only
then starts the new one, so stale lines never reach the board. Checkmate and stalemate are answered
without asking the engine.

## Game review

**Analyze full game** (board toolbar) searches every position of the main line to depth 16, with
progress in the button; click it again to stop.

- Results are written into the game as they come in: each position's evaluation (with its depth,
  exported as `[%eval 0.31,16]`) and the engine's best move. A stopped analysis keeps what it found,
  also across tabs and restarts, and the button then offers to **resume** it. Positions imported
  with an `[%eval]` at least that deep are not searched again.
- **Accuracy** per player is computed from the evaluations with lichess's formula (winning chances
  lost per move, weighted by how volatile the game was), so the numbers are comparable to lichess.
- Moves that lose 5, 10 or 15 percentage points of winning chances are marked as inaccuracies
  (`?!`), mistakes (`?`) and blunders (`??`). The marks are ordinary NAGs: they show in the notation,
  are exported in the PGN and are dotted on the eval graph. A move you annotated yourself keeps your
  annotation.
- On a marked move, the notation shows the engine's best move instead, and **Add as variation**
  plays it as a variation in one click.
- The game header names the opening from the lichess `chess-openings` tables when the PGN has no
  `Opening` tag, and follows the main line as you play.

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
you back to it. Everything returns as soon as the game ends. Correspondence games can last weeks,
so they only keep their own tab fair: the engine and the explorer stay off there until the game is
over, while other tabs work as usual. (Lichess's rules still forbid engine help in them.)

You can step back through the moves during a game; the board takes your move again once you're
back at the end. A game's result and time control go into the PGN headers.

### Premoves

While your opponent is thinking, against Stockfish or on Lichess, you can queue your next move: drag
or click one of your pieces to wherever it might go once they've moved (your own pieces block,
theirs don't, and pawns may always capture). The squares turn purple, and the move is played the
instant it's your turn, if it's legal by then; otherwise it's dropped. Click elsewhere, right-click
or press Escape to cancel it. Premoves promote to a queen. Lichess has no premoves in its Board API,
so they live in the app and are sent like any other move.

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
- **Import games** also fetches your games from **Lichess** or **Chess.com** (see below).
- **Export PGN** shows the game as PGN to copy or save, including variations, comments and NAGs.
- **Save** (⌘S / Ctrl S) writes the game back to its file: the one it was saved to before, or the
  file it was opened from when that file held only this game. Otherwise, and with **Save As…**
  (⇧⌘S / Ctrl Shift S), it asks where to save. Rust only replaces a file that still holds a single
  game that reads cleanly, so a file with several games is never overwritten with one; if the file
  has changed like that, Save asks where to save instead.
- Open tabs are saved as you go (games, variations, comments, NAGs, drawn arrows, the current
  position, which way the board is turned and the file each game belongs to) and reopen on the next
  launch. With nothing to restore, the app starts on an empty board.

PGN parsing and writing happen in Rust (`crates/chess-core/src/pgn.rs`, built on `shakmaty` and
`pgn-reader`). File dialogs are opened from Rust too, so the frontend needs no file system or dialog
permissions.

## Games from Lichess and Chess.com

The **Lichess** and **Chess.com** tabs of **Import games** (board toolbar, or **From Lichess or
Chess.com…** in the Database section) fetch a player's games: the latest 1–200, or every game
between two dates (up to 200 at a time). Only standard chess is fetched, no variants.

- A single game opens straight away; several show the game picker, where you can open them or
  **add them all to the database**. Games open with the board facing the player's side.
- The username is remembered per site. For Lichess it starts as the signed-in account, if any.
- **Lichess** games come from its [games export](https://lichess.org/api#tag/Games/operation/apiGamesUser).
  It needs no account, but when you're signed in the request uses your token, which Lichess serves
  faster. Games analysed on Lichess bring their `[%eval]` scores, which fill the eval graph.
- **Chess.com** games come from its [public API](https://www.chess.com/news/view/published-data-api),
  which needs no login. It serves games a month at a time, so they are collected month by month,
  newest first, one request after another as Chess.com asks.
- Clock times (`[%clk]`) are kept in the PGN but not shown in the move list.

## Annotating

The **Annotate** panel (next to Analysis) edits the current move:

- a **comment**, written into the PGN after the move. At the starting position it becomes the
  comment before the first move. Commands such as `[%clk]` in imported comments are kept as they are.
- the **move** annotation (!!, !, !?, ?!, ?, ??), one **position** assessment (=, ∞, ⩲, ⩱, ±, ∓,
  +−, −+) and any number of **ideas** (□ only move, N novelty, ⟳ development, ↑ initiative,
  → attack, ⇆ counterplay, =∞ compensation, ∆ with the idea, ⨀ zugzwang, ⊕ time trouble). They
  are stored as standard NAGs; side-specific ones use the code for the side that moved.
- the circles and arrows drawn on the board, stored as `[%csl Gd4]` and `[%cal Ge2e4,Rd7d5]` in the
  comment (green, red, blue and yellow), the format lichess and ChessBase use. Imported games show
  their drawings on the board too.

## Setting up positions

**Edit position** (the pencil in the board toolbar, ⌘E / Ctrl E) opens the board editor on the
current position. Drag pieces around (off the board to remove them), pick a piece to place it with a
click (or by sweeping across squares), use the eraser, or right-click a square to clear it. Set the
side to move, castling rights (only offered when king and rook are at home), the en passant square
(only offered when a capture is possible) and the move number, or paste a FEN. Rust checks the
position with shakmaty (two kings, no pawns on the back ranks, the side not to move isn't in check)
before **Analyse this position** opens it on a new board, or on the current one if it is still empty.

A FEN can also be pasted into **Import PGN or FEN…** (⇧⌘O / Ctrl Shift O).

## Settings

The ⚙ button at the bottom of the side rail (⌘, / Ctrl ,) opens the settings:

- **Theme**: follow the system, or always light or dark.
- **Board**: six colour themes (Blush, Mint, Lavender, Sky, Tabby, Tuxedo).
- **Pieces**: Classic (cburnett), Chessnut, Fantasy or Spatial.
- **Volume** of the move sounds, next to the mute switch the board toolbar also has.
- **Analysis engine**: the number of lines, and the threads and hash of the engine that analyses
  the board. Threads and hash are that engine's options (the Engines section has all of them); the
  others live in local storage.

## Menus and shortcuts

On macOS the app has a native menu bar (File, Edit, Board, View, Window), and File › Open Recent
lists the recently opened files. On Windows the same shortcuts work with Ctrl instead of ⌘.

| Shortcut | Command                   | Shortcut  | Command                  |
| -------- | ------------------------- | --------- | ------------------------ |
| ⌘N       | New board                 | ⇧⌘F       | Flip board               |
| ⌘O       | Open PGN…                 | ⌘E        | Edit position…           |
| ⇧⌘O      | Import PGN or FEN…        | ⌘L        | Engine analysis on/off   |
| ⌘S       | Save                      | ⇧⌘L       | Analyze full game        |
| ⇧⌘S      | Save As…                  | ⌘1 … ⌘6   | Show a side-rail section |
| ⇧⌘E      | Export PGN…               | ⌘K        | Search games             |
| ⌘D       | Save to the game database | ⌘,        | Settings                 |
| ⌘W       | Close tab                 | ⇧⌘[ / ⇧⌘] | Previous / next tab      |
| ⇧⌘C      | Copy FEN                  | ←/→, ↑/↓  | Step through moves       |

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
  Switch to **You as White** or **You as Black** to see how _you_ score from the position: only
  your games with that colour count, and every move shows your score with it. Mochi asks for the
  names you play under the first time (your Lichess username and the most frequent players in the
  database are offered).

## Files

The **Files** section lists recently opened (and saved) PGN files, which macOS also shows under
File › Open Recent, and has a folder browser that shows only
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
- **Your names** (e.g. your Lichess and chess.com usernames) tell Mochi which games are yours:
  **Only my games** filters the search to them, and the explorer and Purrzles use them too. Names
  match without regard to case.

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
- **My blunders**: puzzles from your own games. **Find my blunders** runs your analysis engine over
  every game of yours in the database that it hasn't checked yet, as a separate background process
  with half the cores, so live analysis carries on. A move that gives away 15 percentage points of
  winning chances (a `??` in the game review) becomes a puzzle when the engine's better move was
  clearly the only good one. The solution continues for up to three moves while each next move is
  just as clearly the only good one. You get the opponent's move from the game, then find what you
  missed. These puzzles are unrated: new ones come first, then the ones you missed last time.
  **Open the game** shows the game at that point. The search can be stopped at any time, and it
  keeps what it found and picks up where it stopped.
- Any checkmate counts as the final move of a mating puzzle. **Analyze on the board** opens the
  puzzle and its solution in a tab.
- Progress lives in `puzzles.sqlite` in the app data folder; **Reset progress** forgets it, and
  **Forget them** drops the puzzles from your games so they can be searched for again.
