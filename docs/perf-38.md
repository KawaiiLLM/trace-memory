# Ticket 38 Noter NEAR performance

## Method

Measured on Node v24.6.0, macOS arm64, with the deterministic `baseline` performance fixture. The runner copies the cached 63.9 MB fixture (1,999 source entries, 14.8 million Raw characters, 647 turns and 132 original facts), then expands the same-session applicable fact pool to 2,000 or 20,000 facts outside the timed section. Each timed sample captures and renders NEAR for 15 proposed facts, including path applicability filtering, character-bigram similarity, the batched relation read and complete feedback rendering. No provider is installed or called.

```sh
npm run perf -- baseline --repeats=5
```

The first sample is cold. “Warm” is the median of the four later samples; p95 is their maximum and is reported for observation, not used as the acceptance metric. Instrumentation counts prepared pool queries independently of Raw-body reads.

## Recorded results

The warm medians below are the acceptance values; both remain below their required bound.

| Applicable facts | Proposed facts | Cold | Warm median | Warm p95 | Pool queries | Required warm bound |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2,000 | 15 | 36.2 ms | 21.3 ms | 23.6 ms | 3 | < 100 ms |
| 20,000 | 15 | 241.2 ms | 223.1 ms | 247.7 ms | 3 | < 1,000 ms |

`tests/perf/run.ts` enforces both warm-median bounds and exactly three pool queries for each scale. Cold and p95 values remain visible to expose startup and sample variation without silently redefining the approved warm acceptance metric. These deterministic fixture results are not a production latency or model-quality claim.
