# Ticket 21a acceptance report

**Ready for acceptor review.** Baseline: `12fa278`, *Live verification 2026-09-08: all three
compaction tiers, the post-compaction boundary and catchup batching on a real Pi session*, read with
`git log -1 --oneline` before implementation. The initial working tree was clean; HEAD is unchanged,
nothing is staged and nothing is committed — every change below is in the working tree. No
pre-existing file under `.scratch/v1/issues/` was touched; only this report is new there.

**Both `core/prompts/*.md` files changed, so both prompt hashes move** (full list under
**Documentation**): `consolidation.md` `c42db300ad1b…` → `4e2598f406bf…`, `noting.md`
`2703264817a3…` → `b9496194925d…`. The 19a fork gate was **re-run against the updated prompt and tool
schema**, not assumed; result under **Fork gate**.

No live provider was used: deterministic tests only, the fake Pi host, the real-SDK native fixture,
public SDK, no credentials.

---

## Verification

Every command ran in the foreground on Node 24.6.0 with an explicit timeout; no background waits.

| Check | Before | After |
|---|---:|---:|
| `npm test` | 539 passed, 28 files | 553 passed, 28 files |
| `npm run typecheck` | Passed | Passed (also after every probe restoration) |
| `npm run smoke:pi` | Passed | Passed: one native Noting run and one fact |
| `git diff --check` | Clean | Clean |
| Revert probes | Not applicable | Three applied, each red on named tests, each restored byte-for-byte |
| HEAD / staged / commits by this slice | `12fa278` / none / none | `12fa278` / none / none |

Fifteen new cases, all titled **21a 2026-09-08…**: six in `core/api/consolidation.test.ts`, six in
`core/api/memory.test.ts`, two in `core/api/rulings.test.ts`, one in `hosts/pi/entries.test.ts`, one
in `hosts/pi/native.test.ts`. One pre-existing case was rewritten in place rather than added —
`because addresses are resolved but do not satisfy accounting` became **21a 2026-09-08: an address
written in a reason adds no support and satisfies no accounting** — so 539 − 1 + 15 = 553.

Three pre-existing case titles changed because the ruling they pin lost one of its two fields; they
are listed under **Existing tests that moved**.

## Scenario-to-test mapping

| Ticket checkbox | Implementation | Named test |
|---|---|---|
| Scenario 1: all four operations accept valid supports and reason; archive keeps nonempty supports of its own; omitted, wrongly typed or empty required values reject the whole batch | `prepareMemory` requires `reason` and nonempty `supports` on every op (`core/consolidation/commit.ts`); the archive branch of `applyKnowledgeOperation` stores them and inherits category/scope (`core/store/index.ts`) | **21a 2026-09-08: create, update, merge and archive all carry nonempty supports and a reason** and **21a 2026-09-08: an omitted, wrongly typed or empty reason or supports rejects the whole batch** (`core/api/memory.test.ts`) |
| Scenario 2: a commit-level `because` is rejected by name, also beside valid new fields; `skipped[].because` still works | the named-key branch in the operation key loop (`commit.ts`); the skipped validator is untouched | **21a 2026-09-08: a commit-level because is rejected by name, also beside a valid reason** (`core/api/memory.test.ts`) — the same test commits a `skipped[].because` entry through the two-submission protocol |
| Scenario 3: an update needs evidence for its complete result; correction and withdrawal facts among supports are not contradictory; addresses inside a reason add no supports | one `supports` list, no agreement check between cited facts; nothing reads `reason` | **21a 2026-09-08: one supports list holds both the text's grounds and the fact that prompted the change** (`core/api/memory.test.ts`) and **21a 2026-09-08: an address written in a reason adds no support and satisfies no accounting** (`core/api/consolidation.test.ts`) |
| Scenario 4: an archive on an A-only fact retires on A while B and the shared ancestor keep the former commit, with several source entries in one Turn | `commitApplies` reads one `supports` list, so an archive is judged by its own evidence and its concrete source entries (`core/store/index.ts`) | **21a 2026-09-08: an archive citing a sibling-entry fact retires knowledge on that path only** (`hosts/pi/entries.test.ts`, fake Pi host, two branches inside one Turn) |
| Scenario 5: session/project/global citation rules apply to every new support including archives; reason text cannot bypass them | the single `store.citationProblem` call now runs over `supports` for every op, archive scope taken from the parent revision | **21a 2026-09-08: an archive's supports face the same session/project/global table as any other commit** (`core/api/rulings.test.ts`), whose last assertion names the foreign fact in the reason and is still rejected |
| Scenarios 6 and 7: two-submission review and batch atomicity unchanged; one bad reason or support commits nothing; stale-base rejection still holds | validation runs over the whole batch before any write; `baseProblem` untouched | **21a 2026-09-08: one malformed reason among valid operations commits nothing** (`core/api/consolidation.test.ts`) and **21a 2026-09-08: a reason-only update on a stale base is rejected like any other commit** (`core/api/memory.test.ts`); the unchanged protocol stays pinned by `2026-09-07: second submission commits, first does not` and `a target that moved on bounces the whole batch` |
| Scenario 8: archival accounting; a rejected or candidate-only archive, an address in a reason, or a matching label gives no coverage | `accounting` takes this batch's committed ops and adds the supports of archives that applied (`commit.ts`, `core/consolidation/memory.ts`) | **21a 2026-09-08: a range fact cited by a committed archive is accounted for without a skipped entry** and **21a 2026-09-08: a candidate-only archive and an address inside a reason give no accounting coverage** (`core/api/consolidation.test.ts`) |
| Scenario 9: reason appears in trace, history and diffs and never as conclusion evidence; a reason-only change is visible; the numeric diagnostic never runs on the reason | `commitLine`, `renderKnowledgeDiff` and `renderRun` (`core/render/index.ts`); `renderKnowledge` — the compact automatic line — is unchanged | **21a 2026-09-08: reason shows in commit history, diffs and the run, never in the knowledge line or the numeric diagnostic** (`core/api/memory.test.ts`) |
| Reason half of scenario 17: no added maintenance system | no new tool, no new table, no fact field | **21a 2026-09-08: the two-array write shape and the empty-supports archive are superseded by supports plus reason** (`core/api/rulings.test.ts`) pins the memory schema and that the fact schema gained nothing; `2026-09-07: four tools, no other model-facing surface` still pins the surface |
| Review cues (ticket 21): NEAR/CLOSER stay on knowledge text and facts | `candidates()` and the reminder walk still read `text` and `revision.supports` | **21a 2026-09-08: NEAR compares knowledge text, never the commit message** (`core/api/consolidation.test.ts`) |
| The fork gate passes with the updated prompt and tool schema | no change to `verifyForkRequest` | **21a 2026-09-08: the memory schema the child re-registers requires reason, offers no because, and still passes the gate** (`hosts/pi/native.test.ts`, real SDK child) |
| Revert probes | — | see **Probes** |

## The schema diff

`knowledge_revisions` (`core/store/index.ts`), per the 2026-09-08 amendment — the column is replaced,
not added beside the old one, and no migration exists:

```
   op TEXT NOT NULL CHECK (op IN ('create','update','merge','archive')),
-  because TEXT,
+  reason TEXT NOT NULL,
```

`supports` is unchanged and now also carries an archive's own evidence. `KnowledgeRevision.because:
number[] | null` becomes `reason: string`; all four `KnowledgeOperationInput` variants take
`reason: string`, and the archive variant gains `supports: number[]`. The INSERT writes `op.reason`
and the real `supports` for every operation. Store-level guards, beside the existing
`supports must not be empty` (now applied to archives too), gained one line:

```ts
if (typeof op.reason !== "string" || !op.reason.trim()) return { ok: false, reason: "reason must be a non-empty commit message" };
```

A database written by the earlier schema is not read and is never deleted (v1 new-database policy);
`core/store/index.test.ts`'s duplicate-row probe copies the new column list.

## The tool-schema diff

`memoryOperationSchema` (`core/api/tools.ts`):

```
   supports: { type: "array", items: factId, minItems: 1 },
-  because: { type: "array", items: factId } }, ["op", "because"]), allOf: [
+  reason: { type: "string", minLength: 1 } }, ["op", "supports", "reason"]), allOf: [
   …
-  { if: { … op: "archive" }, then: { not: { anyOf: ["text", "category", "scope", "supports"].map(…) } }, else: { required: ["text", "category", "scope", "supports"] } },
+  { if: { … op: "archive" }, then: { not: { anyOf: ["text", "category", "scope"].map(…) } }, else: { required: ["text", "category", "scope"] } },
```

`supports` moved from the two conditional branches into the unconditional `required` list; the
archive branch still rejects `text`, `category` and `scope` as inapplicable fields.
`additionalProperties: false` (from the shared `object()` helper) means a provider that validates the
schema also refuses a stray `because`; core's own validator produces the named error either way, so a
host that does not validate gets the same behaviour. `skipped[].because` is byte-for-byte unchanged.

The `memory` description now reads: *"Every operation, archive included, carries non-empty supports
(this commit's fact evidence) and a reason (the commit message, never evidence). Create, update and
merge also submit the complete resulting text/category/scope."*

## Design choices

**Reuse, not new machinery.** No new module, table, registry or validation framework. The commit
validator, the store write, the façade reads and the existing renderers were evolved in place:
`prepareMemory` keeps its per-operation error list, `applyKnowledgeOperation` keeps its single
`citationProblem` call, `accounting` keeps its one-pass shape. Production delta is +49/−35 lines over
seven files.

**One evidence path, everywhere.** Every reader that used to union `supports` with `because`
(`commitApplies`, the branch-carry commit filter in `core/api/read.ts`) now reads `supports` alone,
which is why archive applicability, scope validation and path selection needed no separate code: the
archive simply stopped being the exception.

**The removed field is named by the key loop, not by a second validator.** One branch inside the
existing unknown-key loop emits `because: removed field; supply "reason" (a string) and "supports"
(the commit's evidence)`. It fires whether or not `reason` is also present, because the loop runs
over the submitted keys, not over what is missing.

**Accounting takes the applied operations, not the submitted batch.** `accounting(…, committed)`
reads the archive revisions the transaction just wrote. A candidate-only or rejected archive never
appears there, so the narrow addition cannot leak into a batch that did not commit it, and no
"was this archive applicable?" recomputation was needed.

**Own choice: the commit-history line shows supports as well as the reason.** The old line printed
`because: F10`; a pure swap to `reason: …` would have removed evidence addresses from history
altogether, exactly when `supports` became the field that decides where a commit applies. The line is
now `K1@2 update <time> supports: F2, F3 reason: <message>`. The compact automatic knowledge line
(`renderKnowledge`) is untouched, so routine injection does not repeat commit messages.

**Own choice: `renderRun`'s created list carries the reason** (`K1@2 (update: <message>)`) to satisfy
"show reason in … run operation results" without changing the `memory` receipt shape that hosts and
the two-submission protocol depend on. `listCommitsByRun` already returns whole revisions, so this
cost one field in a structural parameter type.

**Own choice: `renderKnowledgeDiff` prints a `reason:` transition line** only when the two endpoints
differ, mirroring how `category` and `scope` are already reported. A reason-only change is therefore
visible even when the diffed text is identical.

**No `ponytail:` corner was added by this slice.** Nothing here was knowingly left half-built; the
one pre-existing marker in `core/store/index.ts` (per-read DAG scan) is untouched.

## Probes

Each probe was applied to production code only, the **full** suite ran in the foreground, and the
file was restored from a copy and re-hashed with `shasum -a 256` against the pre-probe value.

| # | Mutation | Red tests | Result |
|---|---|---|---|
| a | `core/store/index.ts`, the INSERT writes `op.op === "archive" ? "[]" : JSON.stringify(supports)` — the superseded "archive has empty supports" | **21a 2026-09-08: create, update, merge and archive all carry nonempty supports and a reason**; **21a 2026-09-08: an archive citing a sibling-entry fact retires knowledge on that path only**; **21a 2026-09-08: a range fact cited by a committed archive is accounted for without a skipped entry**; **21a 2026-09-08: the two-array write shape and the empty-supports archive are superseded by supports plus reason**; `2026-09-07 A: archive has empty text and retires its parent only on its applicable path`; `merged knowledge retain their snapshot and frozen survivor revision; archives show the archive revision` | 6 failed / 552 |
| b | `core/consolidation/commit.ts`, `supports` becomes the union of the submitted list and every existing `F<n>` matched inside `reason` — a reason parsed into citations | **21a 2026-09-08: an address written in a reason adds no support and satisfies no accounting**; **21a 2026-09-08: a candidate-only archive and an address inside a reason give no accounting coverage** | 2 failed / 552 |
| c | `core/consolidation/commit.ts`, `"because"` added to the allowed key list and the named-error branch deleted — a commit-level `because` silently accepted | **21a 2026-09-08: a commit-level because is rejected by name, also beside a valid reason**; `memory rejects malformed items, obsolete fields and invisible evidence without losing ordered results` | 2 failed / 552 |

Restoration, byte-for-byte:

```
8850e1d1d6b76159b2563b81122bb268815f1bdce4c6b46f0c668e2d65d95919  core/store/index.ts
1cd1b41cc8acdd1080f06c6ecfc8787675d314d0cb8a00ad74cff4199d7cf209  core/consolidation/commit.ts
```

identical before the first probe and after the last, with `npm test` green (553) and `npm run
typecheck` clean afterwards. Probes a and c also fail existing pre-21a cases, which is the intended
signal: the old behaviour is now contradicted by tests that predate this slice as well.

## Production line delta

```
 core/api/read.ts             |  2 +-
 core/api/tools.ts            |  6 +++---
 core/consolidation/commit.ts | 30 +++++++++++++++++++-----------
 core/consolidation/memory.ts |  2 +-
 core/model/index.ts          |  5 +++--
 core/render/index.ts         |  8 +++++---
 core/store/index.ts          | 31 +++++++++++++++++--------------
 7 files changed, 49 insertions(+), 35 deletions(-)
```

Whole tree: 32 files, +504/−244, of which the balance is tests, fixtures, prompts and documentation.

## Superseded rulings recorded

Recorded by name and date in `core/api/rulings.test.ts`, above the test
**21a 2026-09-08: the two-array write shape and the empty-supports archive are superseded by supports
plus reason**:

- User, 2026-09-07: *"every operation has one shape: op, id, absorb, text, category, scope, supports,
  because; because is always required"* and *"archive carries only op, id, because"*. Superseded by
  ticket 21 on 2026-09-08.
- User, 2026-09-07: *"an archive commit has empty supports"*. Superseded the same day: an archive
  keeps the evidence it cites, so its applicability comes from the same field as every other commit.
- User, 2026-09-07: *"supports proves only the new text"*. Superseded: supports supplies the commit's
  evidence, including the complete result's basis and the correction or withdrawal that justified it.

## Existing tests that moved

| Test | Why |
|---|---|
| `2026-09-07 A: sibling-branch facts are readable but supports and because require an adoption fact on this path` → `… but supports requires an adoption fact on this path` | the ruling stands; it now has one field to loop over instead of two |
| `2026-09-07: supports and because obey the session/project/global scope table` → `2026-09-07: supports obeys the session/project/global scope table` | same reason |
| `because addresses are resolved but do not satisfy accounting` → `21a 2026-09-08: an address written in a reason adds no support and satisfies no accounting` | the field it tested no longer exists; the case it protects (prose that looks like evidence) moved to `reason` |

`2026-09-07: one operation shape, inapplicable fields rejected` keeps its title but now deletes each
of `reason` and `supports` in turn to prove the required-field rejection, and no longer lists
`supports` among archive's inapplicable fields.

## Documentation

Every prompt change, since the hashes move with them:

`core/prompts/consolidation.md` (7 hunks)
1. Addressing paragraph: *"Supports and because may cite facts only on the writer's own path"* →
   *"Supports may cite facts only on the writer's own path"*.
2. Output list, first bullet: the `because` bullet is replaced by *"Every operation requires
   non-empty `supports` (fact addresses) and a non-empty `reason` (one line)."*
3. Two new bullets define `supports` (this commit's evidence, including corrections/withdrawals,
   full replacement) and `reason` (the commit message; no evidence, scope, applicability or
   accounting; addresses in it are read by nobody).
4. create/update/merge bullet reduced to *"also require the complete resulting `text`, `category`,
   `scope`"*.
5. Archive bullet: *"archive carries only `op`, `id`, `supports`, `reason`; it keeps its parent's
   category and scope."*
6. Accounting paragraph: adds *"cited by an archive this batch committed"* to the covered set.
7. Second-round checklist: *"Keep supports for the resulting text separate from because for this
   change"* → *"Citing only what triggered the change does not ground the resulting text"*; and the
   scope paragraph now says an archive is *"effective only where its own supports apply"*; the
   section heading `### supports [evidence only]` became `### supports [this commit's evidence]`.

`core/prompts/noting.md` (1 hunk): the shared addressing paragraph, *"Supports and because may cite
facts only on the writer's own path"* → *"Supports may cite facts only on the writer's own path"*.
The Noter cannot call `memory`, but a main agent reading this paragraph can, and the field is gone.

Other documents:

- `CONTEXT.md`: two new glossary terms, **Supports** and **Reason**, beside **Knowledge**.
- `.scratch/v1/spec.md`: the `memory` tool contract, the knowledge-commit paragraph, Applicability,
  Citation rule, Archive and merge, the `core/store` module line, the `core/consolidation` accounting
  line and the `knowledge_revisions` schema line.
- `core/README.md`: commit metadata in the trace section, the whole `memory` operation-shape
  paragraph, the supports/citation sentence, the accounting paragraph and the numeric-diagnostic
  sentence.
- `hosts/pi/README.md`: the one sentence describing the `memory` tool now says every operation
  carries its own supports and a reason, and that core owns that schema. No other line in the host
  README mentioned the field.
- `test/fixtures/trace.json`: the simulation knowledge log's `because` arrays became `reason`
  strings ("Initial admission from the map export", "Correction after the mod runtime table was
  re-read"); the Chinese knowledge text, facts and quotes are untouched. Three `trace.test.ts`
  snapshots were regenerated for the new commit-history line.

## Fork gate

`hosts/pi/native.test.ts` was re-run in full after the prompt and schema change: **29 passed**,
including `19a 2026-09-08: the native child's first request passes prefix verification against the
captured parent request` and `19a ruling 2026-09-08: the anthropic-messages child passes the gate
with cache_control stripped from both sides and nothing else`. `verifyForkRequest` and
`verifyNativeRequest` were not touched.

The new gate case **21a 2026-09-08: the memory schema the child re-registers requires reason, offers
no because, and still passes the gate** asserts, on a real SDK child request: `verification.passed`,
`f.sent[1].tools` deep-equal to the captured parent's tools, the operation schema's
`required: ["op", "supports", "reason"]`, no `because` property, `additionalProperties: false`, the
untouched `skipped[].because` string schema, and the new description text. The child re-registers the
parent's definitions byte for byte, so a schema drift between core and the parent registration would
show up as a gate failure, not as a silent difference.

## Honest limits

- **No live provider ran.** The Consolidator has not been observed writing `reason` in a real run;
  the prompt change is verified only by its own hash moving and by the deterministic seams.
- **A pre-21a database is unreadable, by ruling.** `reason TEXT NOT NULL` replaces `because TEXT` with
  no migration, so opening a database written before this slice fails on the missing column. That is
  the amended intent (v1 new-database policy, never delete a user's database), but it is a hard
  cut: an acceptor testing on an existing development database must point the plugin at a new file.
- **`reason` has no quality floor.** Non-whitespace content is the whole rule. A one-character reason
  commits, exactly as ticket 21's Out of Scope requires ("a reason length/quality score" is excluded).
- **Existing `KnowledgeOperationInput` callers must supply a reason.** Every direct
  `commitConsolidationRun` caller in tests now passes one; a host or script that built operations
  itself would fail to typecheck, which is the intended loud failure.
- **`accounting`'s `sessionId` parameter is now unused** (its only use was a project lookup that the
  archival rule made unnecessary). It was kept to avoid churning both call sites; it is dead weight,
  not dead behaviour.
- **The 21a rendering tests read the rendered line, not a structured field.** If a later ticket makes
  commit history structured, those assertions will need rewriting; they are pinned to text on
  purpose, because text is what the model sees.

## What 21b must know

- **Where topics attach.** `KnowledgeRevision` in `core/model/index.ts` is the versioned record —
  add `topics: string[]` beside `supports` and `reason`; the stable `Knowledge` identity must stay
  free of them. In the store, `knowledge_revisions` gains one column, `toKnowledgeRevision` one
  parse, and `applyKnowledgeOperation` one INSERT argument; archive must inherit the parent's array
  the way it already inherits `category` and `scope` (`op.op === "archive" ? prior!.… : op.…`).
- **Where validation goes.** `prepareMemory` in `core/consolidation/commit.ts`: add `"topics"` to the
  `keys` list for create/update/merge (and *not* for archive, so archive keeps rejecting it as an
  inapplicable field), then one normalisation helper beside the existing `facts()` helper. The
  removed-field branch for `because` is the pattern for naming any other retired key.
- **Where renderers change.** `renderKnowledge` (the shared knowledge line, used by every automatic
  consumer through 20a), `commitLine`/`renderCommitHistory`, `renderKnowledgeTrace` and
  `renderKnowledgeDiff` in `core/render/index.ts`. 21a already added a `reason:` transition line to
  the diff; a `topics:` transition line belongs next to it. Note that the automatic line is
  deliberately reason-free — topics, unlike reasons, are ruled to appear there, and they must be
  charged to ticket 20's knowledge cap.
- **Tool schema.** `memoryOperationSchema` in `core/api/tools.ts`; adding `topics` to the base
  `required` list and to the archive branch's `not: { anyOf: [...] }` list mirrors what 21a did with
  `supports` in reverse. The fork gate will need the same re-run: the tool definitions are part of
  the parent body it compares.
- **Search.** Literal knowledge search lives in `store.searchAddresses`; 21a did not touch it, and it
  currently matches text only.
