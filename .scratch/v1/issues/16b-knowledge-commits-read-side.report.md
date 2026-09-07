# Ticket 16b acceptance report

**Ready for acceptor review; live run remains with the acceptor.** All other ticket items are implemented and verified. Baseline: `48e82f4018f75b5962e8c3041ba881b1a52595d0`. The initial working tree was clean; changes remain unstaged and uncommitted.

## Verification

| Check | Before | After |
|---|---:|---:|
| `npm test` | 335 passed, 14 files | 343 passed, 14 files |
| `npm run typecheck` | — | Passed |
| `git diff --check` | — | Passed |
| Existing named ruling declarations | 30 | All retained, names and dates unchanged |

Eight tests were added: seven core ruling tests and one Pi host test. Existing trace expectations and goldens now use complete commit addresses and parent/child metadata. Two simulation loaders remap historical source addresses into their fixture databases; the source JSON fixtures remain unchanged.

## Acceptance evidence

| Ticket item | Implementation and verification |
|---|---|
| Address grammar / missing commits | The façade is the single knowledge-address validator used by `checkAddress`. Full same-identity diffs accept siblings, reverse order and equal endpoints. Old abbreviated ranges, mixed identities and unsafe IDs are rejected. Nonexistent commits report `does not exist`, including through the tool. |
| Rendering | Knowledge lines already emitted `[K1@57]` in 16a and retain that format. Trace adds parents, children, path current, applicable history and other branches' tips. Unbound identity reads label tips newest-created and do not claim a current winner. `K1..` renders all identity commits and their graph edges. |
| Search / injection / compaction | Search annotates current, superseded, another-branch and archived hits relative to the supplied path. Superseding tips follow parent and merge edges, including cross-identity merges. Knowledge/episodic XML shapes stay intact. Pi passes the actual head on injection and refreshes injection after a tree switch. |
| User marks | `/trace mark K1@57 verified|flagged|clear` targets that commit; bare `K1` uses the restored session head. Core coverage rejects ambiguous bare marks and tests unrestricted explicit marks. |
| Prompts / tool description | Both prompts gain one identities/commits/citation/base-rejection paragraph. Recording explicitly excludes knowledge, deliveries, compaction and carry from fact sources. The memory tool describes whole-batch base-commit rejection and rereading. |
| Branch carry / raw sources | One escaped XML block, exact fixed reminder, path facts, commits selected by local evidence and unrecorded raw. Host output equality is tested. A note citing only an injected compaction message is rejected for lacking a raw source. Manual note also rejects sibling raw. |
| Commit vocabulary | `baseCommit`, `intoBaseCommit`, `from_commit`, `to_commit`, `fromCommit`, `toCommit`, `commit` and `readKnowledgeCommits` replace the legacy field vocabulary throughout producers, consumers and tests. No aliases or migrations added. Remaining literal `rev` occurrences are negative assertions that the old field is absent. |
| Revert probes | All three required probes below independently turned their named tests red, were restored byte-for-byte, and passed after restoration. |
| Live run | Not performed, as requested; acceptor owns the fork / other-branch / ancestor live sequence. |

## Design choices

- **Carry selection:** branch-label membership versus raw-evidence ancestry. Evidence ancestry was recommended and implemented. Every raw source of a same-session fact must be on the leaving path; first-source time attribution is preserved. Commits qualify when applicable on that path and citing at least one of its facts through supports or because. Shared commits without local branch evidence are not attributed to the leaving branch.
- **Diff direction:** numeric forward-only intervals versus any two commits of one identity. The latter follows the ruling. Endpoint text is compared directly; metadata lists identity commits unique to either endpoint's ancestry, so an unrelated sibling created between their IDs is not mistaken for a transition.
- **XML:** raw interpolation versus escaped payload. Escaping preserves one boundary even when raw contains `</branch_carry>`; omission receipts stay inside the wrapper.
- **Evidence reuse:** carry-only filtering versus shared fact-path validation. Review found that a fact sourcing an ancestor and a descendant could leak into ancestor carry and become citable there. `factOnPath` now serves carry, knowledge applicability and citation validation; the regression covers ancestors and siblings.

## Production line delta

Counts compare the working tree with the baseline using `git diff --numstat`; blank lines and comments count. Runtime TypeScript, prompt Markdown and the updated core README are included. Tests, snapshots and this report are excluded.

| File | Before | After | Added | Removed | Net |
|---|---:|---:|---:|---:|---:|
| `core/README.md` | 308 | 304 | +24 | -28 | -4 |
| `core/api/index.ts` | 226 | 242 | +34 | -18 | +16 |
| `core/api/read.ts` | 138 | 151 | +25 | -12 | +13 |
| `core/api/tools.ts` | 179 | 175 | +10 | -14 | -4 |
| `core/integration/commit.ts` | 108 | 108 | +3 | -3 | +0 |
| `core/integration/index.ts` | 139 | 139 | +8 | -8 | +0 |
| `core/integration/memory.ts` | 60 | 60 | +1 | -1 | +0 |
| `core/model/index.ts` | 314 | 314 | +2 | -2 | +0 |
| `core/prompts/integration.md` | 119 | 121 | +5 | -3 | +2 |
| `core/prompts/recording.md` | 88 | 92 | +4 | -0 | +4 |
| `core/recording/index.ts` | 127 | 127 | +5 | -5 | +0 |
| `core/render/index.ts` | 207 | 206 | +11 | -12 | -1 |
| `core/store/index.ts` | 1049 | 1071 | +62 | -40 | +22 |
| `hosts/pi/index.ts` | 406 | 406 | +4 | -4 | +0 |
| Total | 3468 | 3516 | +198 | -150 | +48 |

## Exact branch-carry fixture

Fixture test: **16b: branch carry fixture uses evidence ancestry, includes commits and raw, and preserves one XML boundary**. C and D fork from the root; C's recording watermark is T2, its unrecorded tail is T4, and another same-label fact after T4 must stay out. The exact returned block is:

```xml
<branch_carry>
this is knowledge from another branch; it must not be written as facts; the Recorder's facts come only from the current branch's conversation, never from messages this plugin injected.
Facts:
[F1] 2026-09-06T00:00:00Z [decision/user] main
  source: T1#user
[F2] 2026-09-06T00:00:00Z [decision/user] C
  source: T2#user
Commits (by evidence):
[K1@1] [constraint/project] Use blue tiles
  supports: F1
[K1@2] [constraint/project] C version
  supports: F2
Unrecorded raw:
[S1/T4] 2026-09-06T00:00:00Z [turn]
[Source entry id: T4#user]
Unrecorded &lt;work&gt; &amp; &lt;/branch_carry&gt;
[Source entry id: T4#assistant]
Pending
</branch_carry>
```

The snapshot file is `core/api/__snapshots__/rulings.test.ts.snap`. Pi's pass-through equality is also asserted in `hosts/pi/index.test.ts`.

## Revert probes

For each mutation, the command was `npx vitest run core/api/rulings.test.ts -t "<exact test name below>"`. Each produced one failed test. The original file bytes were restored in a `finally` block, compared for equality, and the identical command then produced one passed test. The final full suite ran after all restorations.

### 1. path-global-newest

In `core/api/read.ts`, replace the path-visible knowledge input with the context-free tips filtered to each identity's largest allocated commit ID.

```ts
store.listCurrentKnowledge(null, { projectId }).filter(k => k.revision.id === store.listKnowledgeRevisions(k.knowledge.id).at(-1)!.id)
```

Test: **2026-09-07 A: C/D paths see c2/c3, fork ancestor sees c1, D's later commit does not move C** in `core/api/rulings.test.ts`.

```ts
expect(memory.inject(path)).toContain(text)
```

```text
Expected: C version
Received: knowledge block containing [K1@4] D later version
```

Mutation: **1 failed**. Byte-for-byte restoration: **1 passed**. Restored source SHA-256: `dc79431e2a8830756a04bba3d5b23543bf6a7352d833476956a06a4508b1af0c`.
### 2. base-dropped

In `Store.baseProblem`, insert an unconditional early return, disabling the shared preflight and transactional base check.

```ts
return null;
```

Test: **2026-09-07 B: store rechecks every base inside the transaction and rolls back an earlier create** in `core/api/rulings.test.ts`.

```ts
expect(result.ok).toBe(false)
```

```text
Expected: false
Received: true
```

Mutation: **1 failed**. Byte-for-byte restoration: **1 passed**. Restored source SHA-256: `55bfe8ab7dc8f8b3ac64708497c416f3db35cf327291cb309a4f6d9e2e6c77cc`.
### 3. sibling-allowed

In `Store.citationProblem`, remove the same-session path rejection.

```ts
if (!this.factOnPath(fact, path, turns)) return `F${id}: record an adoption fact on this path first`;
```

Test: **2026-09-07 A: sibling-branch facts are readable but supports and because require an adoption fact on this path** in `core/api/rulings.test.ts`.

```ts
expect(rejected.results[0]).toContain("record an adoption fact on this path first")
```

```text
Expected: record an adoption fact on this path first
Received: ok
```

Mutation: **1 failed**. Byte-for-byte restoration: **1 passed**. Restored source SHA-256: `55bfe8ab7dc8f8b3ac64708497c416f3db35cf327291cb309a4f6d9e2e6c77cc`.

## Standards review

No remaining hard standards violations or actionable smell findings. The reviewer identified two stale README descriptions; both were corrected and rechecked.

## Spec review

Ready for acceptor review after the multi-source fact defect was fixed. The reviewer independently reproduced the original counterexample, then confirmed ancestor carry excludes the fact and ancestor citation rejects it after the fix. No remaining major ticket violation was found.

## 验收自查

- [x] Every requested non-live item implemented and tested.
- [x] 335 → 343 tests; typecheck and whitespace checks pass.
- [x] All three named revert probes red, byte-restored, then green.
- [x] Per-file production line delta and exact XML fixture included.
- [x] No dependencies, compatibility aliases, staging or commits.
- [ ] Live run: explicitly reserved for the acceptor.
