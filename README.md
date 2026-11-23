# Fleet — a faster makefun-site

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/Biose-dot/site-generator-speed-01-run-20261122-r2/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/Biose-dot/site-generator-speed-01-run-20261122-r2/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A faster drop-in replacement for make.fun's own **makefun-site 1.0.0**,
built for the make.fun competition
[`site-generator-speed-01-run-20261122`](https://make.fun/bounty/site-generator-speed-01-run-20261122)
("Build a static site faster", $100, entries close 25 November 2026 03:00 WIB).

`run(input)` in `solve.js` returns, for every input, exactly the output
tree makefun-site 1.0.0's `build` returns — every page's `index.html`, the
index and tag pages, `build-report.txt` and each static file, byte for
byte — at **2.37× the speed** of the reference on the practice set
(3 cases, 200–600 Markdown sources each): median CPU time of `run()` over
the 3 cases, 11 repetitions interleaved with the baseline (0.234 s vs
0.555 s), with the kit's own scorer confirming `passed: 1` (3/3 cases
identical). Two runs over the same input are byte-identical.

## How it works

makefun-site's dialect is its own — front matter, template language,
Markdown subset, slug rule and report — so `solve.js` reimplements those
semantics exactly, in one dependency-free ES module, with the hot paths
rewritten:

- **The Markdown lexer classifies lines with direct character checks**
  (fences, headings, breaks, list markers) instead of a battery of
  regular expressions per line, and lexing and rendering run in one pass
  with no token objects.
- **The inline renderer writes plain runs as whole segments** instead of
  character by character, and HTML escaping is a single scan.
- **slugify, long dates and link resolutions are memoised per run** —
  titles, tag names and headings repeat constantly, and each is a pure
  function of its inputs. Nothing is cached across runs, so each case is
  still answered alone.
- **Each page's card is computed once** and shared by its layout, the
  index pages, the tag pages and `recent`; template `for` loops reuse one
  scope object per loop instead of allocating one per iteration.
- **Front matter parsing splits only the lines up to the closing `---`**;
  the body is a single slice of the source.

Correctness was checked beyond the practice set: outputs were compared
against the reference implementation on a dozen additional generated
sites from the kit's own case generator (different seeds, all size
bands) — identical on every one.

## Layout

- `solve.js` — the entry: an ES module exporting `run(input)`.
- `main.ts` — the harness driver: reads `/input/cases.json`, answers
  each case with `run`, writes `/output/answers.json`. Outside a
  container, `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR` stand in for
  `/input` and `/output`.
- `package.json` — `{ "type": "module" }`; nothing is installed.

Runtime: Node 22, standard library only — no WebAssembly, no native
addons, no network.

## License

MIT — see `LICENSE`.
