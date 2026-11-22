# Strategy — site-generator-speed-01-run-20261122

## Goal

Beat makefun-site 1.0.0, the house baseline, on CPU time while answering
exactly as it does on every case. Only identical answers are timed, so
correctness comes first and speed second.

## Approach

Re-implement makefun-site's own rules from its README and reference code
(front matter, template dialect, Markdown subset, slug rule, report) in a
single dependency-free `solve.js`, then remove the reference's hot spots:

- **One pass over each source's lines**, shared by front matter and
  Markdown — no split/join round trip between the two.
- **Inline rendering by regex scan**: plain text runs are found by one
  `/[\\`*[]/g` scan and copied whole; the reference escapes every
  character with a regex replace of its own.
- **Slugify fast path**: NFKD is the identity on ASCII, so ASCII titles
  skip `normalize()`; results are memoised per build (titles, tags and
  headings repeat across a site).
- **Link resolution memoised** per (directory, target) within a build.
- **Templates compiled** to straight-line functions with inlined scope
  lookup; if compilation is ever unavailable, the same node tree renders
  through the tree walker, so the answer is identical either way.
- **Cards computed once** per source and reused by the layout.
- **No caching across cases**: every memo lives inside one `run()` call,
  as the rules require.

## Validation

- Practice set: 3/3 cases byte-identical to the oracle (md5 of
  `answers.json` matches the baseline's).
- 10 freshly drawn instances from the kit's generator (30 cases):
  identical to the baseline and to the expected answers on every case.
- Fallback path (template compilation disabled) also verified identical
  on the practice set and on a fresh seed.

## Measured speed (this machine, median of 7 runs, CPU time)

- This entry: ~1.06 s for the 3 practice cases.
- House baseline (makefun-site 1.0.0): ~1.73 s.
- Speedup: ~1.64x.
