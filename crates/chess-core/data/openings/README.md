# Opening names

`a.tsv` to `e.tsv` are copied unchanged from
[lichess-org/chess-openings](https://github.com/lichess-org/chess-openings) at commit
`3ba6b20d31b2e6125cb0e6a2e792f400717d9d39`. They are dedicated to the public domain under
[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/).

Each line names the position reached by its moves; `src/openings.rs` indexes them by position. To
update, copy the new files over these and run `cargo test -p chess-core`, which checks that every
line still parses.
