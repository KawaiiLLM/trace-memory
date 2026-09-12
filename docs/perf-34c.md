# Ticket 34c foreground publication performance

## Method

Measured on Node v24.6.0, macOS arm64, with the repository's deterministic cached performance fixtures. The runner copies each fixture, adds independent applicable current revisions sharing one real Fact, and excludes setup from timing. It then measures the synchronous core publication predicate with either no visible evidence or that shared Fact visible. No provider is installed or called.

```sh
npm run perf -- baseline --repeats=3
npm run perf -- large --repeats=3
```

The first sample is cold; the table reports the median of two warm samples and their p95 (the same value with two warm samples). `reads` is instrumented Raw-body reads, not SQL statement count.

## Results

| Fixture | Added candidates | Visibility | Cold | Warm / p95 | Raw-body reads |
| --- | ---: | --- | ---: | ---: | ---: |
| baseline: 1,999 entries, 132 facts | 250 | no bodies or evidence | 76.8 ms | 67.1 ms | 0 |
| baseline: 1,999 entries, 132 facts | 269 total | every current exact body visible | 3.6 ms | 3.3 ms | 0 |
| baseline: 1,999 entries, 132 facts | 250 | shared support Fact visible | 4.5 ms | 4.5 ms | 0 |
| large: 3,951 entries, 264 facts | 1,000 | no bodies or evidence | 513.7 ms | 405.5 ms | 0 |
| large: 3,951 entries, 264 facts | 1,019 total | every current exact body visible | 8.3 ms | 7.8 ms | 0 |
| large: 3,951 entries, 264 facts | 1,000 | shared support Fact visible | 8.7 ms | 8.7 ms | 0 |

The no-evidence case includes exact-version graph selection, rendering, and whole-item fitting under the 20,000-token cap. The evidence case traverses the same candidate population but suppresses it before rendering bodies. Focused structural tests separately observed four source-related SQL statements for both one and forty candidates, confirming bounded batch work rather than per-candidate source queries.

There is no pre-34c foreground-predicate timing because the predecessor used initial/command-generation gating instead of evaluating every ordinary prompt. The checked-in runner scenario is the reproducible comparison point for later changes.

No real-data result is claimed: this task explicitly prohibited access to the production database and supplied no other authorized real-data copy. Tree-change latency and real-data SQL distributions therefore remain unmeasured rather than being inferred from synthetic fixtures.
