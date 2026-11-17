# Starter puzzles

`starter.csv` is a sample of the [Lichess puzzle database](https://database.lichess.org/#puzzles),
which is dedicated to the public domain under
[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). It was taken from the export of
2026-11-01 and keeps the original columns except `DailyDate`.

It holds the 100 most played puzzles of every 100-point rating band from 600 to 2800 among puzzles
with a popularity of at least 85, at least 500 plays and a rating deviation of at most 85, so the
app has puzzles of every strength before the full database is downloaded. `cargo test -p chess-core`
checks that every puzzle parses and that its moves are legal.
