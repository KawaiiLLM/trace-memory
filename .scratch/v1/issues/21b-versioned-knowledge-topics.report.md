# Ticket 21b acceptance report

**Ready for acceptor review.** Baseline: `3d0f150`, *Ticket 21a: one supports list is a knowledge
commit's evidence, with a reason as its message*, read with `git log -1 --oneline` before
implementation. The initial working tree was clean; HEAD is unchanged, nothing is staged and nothing
is committed — every change below is in the working tree. No pre-existing file under
`.scratch/v1/issues/` was touched; only this report is new there.

**One `core/prompts/*.md` file changed**, so one prompt hash moves: `consolidation.md`
`4e2598f406bf…` → `a4a72246d384…`. `noting.md` is untouched (`b9496194925d…`) — the Noter cannot
write knowledge and its shared addressing paragraph names no operation field. The 19a fork gate was
**re-run against the updated prompt and tool schema**, not assumed; result under **Fork gate**.

No live provider was used: deterministic tests only, the fake Pi host, the real-SDK native fixture,
public SDK, no credentials.

---

## Verification

Every command ran in the foreground on Node 24.6.0 with an explicit timeout; no background waits.

| Check | Before | After |
|---|---:|---:|
| `npm test` | 553 passed, 28 files | 562 passed, 28 files |
| `npm run typecheck` | Passed | Passed (also after every probe restoration) |
| `npm run smoke:pi` | Passed | Passed: one native Noting run and one fact |
| `git diff --check` | Clean | Clean |
| Revert probes | Not applicable | Three applied, each red on named tests, each restored byte-for-byte |
| HEAD / staged / commits by this slice | `3d0f150` / none / none | `3d0f150` / none / none |

Nine new cases, all titled **21b 2026-09-08…**: three in `core/api/memory.test.ts`, two in
`core/api/read.test.ts`, two in `core/api/rulings.test.ts`, two in `core/render/material.test.ts`
(553 + 9 = 562). No existing case was renamed or deleted. One existing case was **extended**: the 21a
fork-gate case in `hosts/pi/native.test.ts` now also asserts the child's `topics` schema, as the
acceptance list requires.

Existing operation literals across the test tree gained `topics` (required for create, update and
merge); that is the bulk of the non-production diff and changed no assertion.

## Scenario-to-test mapping

| Ticket checkbox | Implementation | Named test |
|---|---|---|
| Scenario 10: several labels, empty arrays, whitespace, duplicates, malformed arrays and empty labels follow the declared normalization; reordering the same set renders the same metadata | the `labels()` helper beside `facts()` in `prepareMemory` (`core/consolidation/commit.ts`); `topics` in the per-op `keys` list for create/update/merge only | **21b 2026-09-08: labels are trimmed, deduplicated and code-point ordered, and a bad label rejects the whole batch** and **21b 2026-09-08: reordering the same label set renders the same metadata, and an empty array renders none** (`core/api/memory.test.ts`) |
| Scenario 11: a topic-only update is an ordinary update with a reason; old commits keep old labels; clearing is explicit; merge supplies the full set; archive inherits | `topics` on the revision row (`knowledge_revisions`), the archive branch of `applyKnowledgeOperation` copying `prior!.topics` (`core/store/index.ts`), the `topics:` transition line in `renderKnowledgeDiff` | **21b 2026-09-08: a topic-only update is an ordinary update; old commits keep their labels, clearing is explicit, merge states the survivor's set and archive inherits** (`core/api/memory.test.ts`) |
| Scenario 12: one topic across categories and one commit under two topics; structured reads group both without cloning; search by a label absent from the text finds the commit once | `topicGroups` on the read façade (`core/api/read.ts`); the `json_each` branch of the knowledge search (`core/store/index.ts`) | **21b 2026-09-08: one topic spans categories, one commit joins two groups, and a label absent from the text finds that commit once** (`core/api/read.test.ts`) |
| Scenario 13: labels with Chinese, spaces, percent, underscore, quotes or backslashes match literally, not as JSON syntax; empty topics hide nothing | the same escaping helper as the text branch, applied to `json_each(topics).value` | **21b 2026-09-08: labels match literally, never as JSON syntax, and empty topics hide nothing** (`core/api/read.test.ts`) |
| Scenario 14: matching labels on sibling-only, historical, archived and multi-tip knowledge change no applicability; injection excludes inapplicable revisions; grouping picks no largest id | nothing reads `topics` in `commitApplies`, `citationProblem`, `baseProblem`, `currentSet` or `accounting`; `topicGroups` projects the same path-selected set `inject` uses | **21b 2026-09-08: a shared label alters no applicability, keeps its history labels and never collapses two applicable tips** (`core/api/rulings.test.ts`, over the existing `commitPaths()` two-branch fixture) |
| Scenario 15: all four consumers render topics through the one core renderer; labels count in the knowledge budget; a multi-topic item appears once; identical selected revisions and topics give identical leading bytes | `renderKnowledge` alone emits the labels, so 20a's shared block and 20b's `budgetKnowledge` see one representation | **21b 2026-09-08: all four consumers render topics through the one knowledge renderer, and a multi-topic item appears once** and **21b 2026-09-08: rendered labels are charged to the knowledge cap, and the leading block stays byte-identical across tasks** (`core/render/material.test.ts`) |
| Scenario 17 (topic half): facts and `note` gain no topics field; no new duty; four tools; no catalog; no model called for storage | no fact column, no note field, no new tool, no injected block | **21b 2026-09-08: topics are revision metadata only — no fact or note field, no fifth tool and no injected catalog** (`core/api/rulings.test.ts`) |
| The fork gate passes with the updated prompt and tool schema | no change to `verifyForkRequest` | **21a 2026-09-08: the memory schema the child re-registers requires reason, offers no because, and still passes the gate** (`hosts/pi/native.test.ts`), extended with the `topics` property, the archive branch and the new description text |
| Revert probes | — | see **Probes** |

## The schema diff

`knowledge_revisions` (`core/store/index.ts`) — one column, the storage the user ruled on
2026-09-08 (a JSON column, as `supports` already is; no topics table, no migration, v1
new-database policy):

```
   op TEXT NOT NULL CHECK (op IN ('create','update','merge','archive')),
   reason TEXT NOT NULL,
+  topics TEXT NOT NULL DEFAULT '[]',
   run_id INTEGER REFERENCES runs(id),
```

`KnowledgeRevision` gains `topics: string[]` (parsed in `toKnowledgeRevision`); the create, update
and merge variants of `KnowledgeOperationInput` gain `topics: string[]`, the archive variant does
not. The INSERT writes one more argument, and it is the only place archive inheritance lives:

```ts
      // 21b: labels belong to this immutable revision; an archive inherits its parent's, as it does category and scope.
      op.reason, JSON.stringify(op.op === "archive" ? prior!.topics : op.topics), runId, op.createdAt);
```

Knowledge-layer search (`searchAddresses`):

```
   const knowledge = scope === "facts" ? [] : (this.db.prepare(`SELECT knowledge_id, id FROM knowledge_revisions
-    WHERE text LIKE ? ESCAPE '\' ORDER BY knowledge_id, id`)
-    .all(pattern) as …
+    WHERE text LIKE ? ESCAPE '\' OR EXISTS (SELECT 1 FROM json_each(topics) WHERE value LIKE ? ESCAPE '\')
+    ORDER BY knowledge_id, id`)
+    .all(pattern, pattern) as …
```

`EXISTS` (not a join) is what makes one commit one row however many labels match, and `json_each`
compares label *values*, so the serialized array's punctuation and escapes are unmatchable. The
pattern is the existing `%…%` with `[\\%_]` escaped — the same helper expression the text branch uses.

## The tool-schema diff

`memoryOperationSchema` (`core/api/tools.ts`):

```
   reason: { type: "string", minLength: 1 },
+  topics: { type: "array", items: { type: "string", minLength: 1 } }
   }, ["op", "supports", "reason"]), allOf: [
   …
-  { if: { … op: "archive" }, then: { not: { anyOf: ["text", "category", "scope"].map(…) } }, else: { required: ["text", "category", "scope"] } },
+  { if: { … op: "archive" }, then: { not: { anyOf: ["text", "category", "scope", "topics"].map(…) } }, else: { required: ["text", "category", "scope", "topics"] } },
```

`topics` therefore rides the existing conditional branch: required exactly where `text`, `category`
and `scope` are required, and rejected exactly where they are rejected. The unconditional `required`
list is unchanged, because an archive takes no labels. Core's own validator produces the same result
without the provider's schema check: `topics` is in the per-operation `keys` list only for
create/update/merge, so an archive carrying it gets the existing `topics: inapplicable field` error.

The `memory` description now ends: *"Create, update and merge also submit the complete resulting
text/category/scope and topics (subject labels; the complete replacement set, empty when
unclassified); an archive inherits its parent's topics."*

## The normalization rule

One helper, `labels()`, beside the existing `facts()` helper in `prepareMemory`:

1. Not an array → `topics: expected an array of subject labels` (the whole batch rejects).
2. A non-string item → `topics: expected string labels`.
3. Trim surrounding whitespace; empty after trimming → `topics: a label must not be empty`.
4. Exact duplicates (after trimming) collapse to one.
5. The resulting set is sorted by code point (`a < b` on the raw strings), which is the deterministic
   order the ruling asks for. The observable rule is the one the test pins: **reordering the same set
   renders the same metadata**; `["storage", "auth"]` and `[" auth ", "storage"]` produce the same
   stored array and the same rendered line.

Nothing else happens to a label: no case folding, no translation, no synonym merge, no hierarchy read
out of `/` or `:`, and no primary-topic meaning attached to position. `topics` is not read by
`citationProblem`, `commitApplies`, `baseProblem`, `accounting`, the numeric diagnostic, NEAR/CLOSER
or any scope check — a label is never evidence and never changes where a commit applies.

## Design choices

**Reuse, not new machinery.** No new module, table, registry, worker, tool or command. The validator
gained one helper and two list entries; the store gained one column, one parse and one INSERT
argument; the renderer gained one metadata segment and one diff line; the façade gained one read
projection. Production delta is +70/−14 over seven files.

**Own choice: the labels ride the metadata line, not the conclusion line.** `renderKnowledge` emits
`  supports: F1, F2 · topics: auth, storage`, and nothing at all when the array is empty. The ruling
requires labels to be *clearly metadata, not appended into the conclusion as new factual prose*; the
`supports:` line is already the metadata line, so a label cannot be misread as a continuation of the
text, and the conclusion line stays byte-identical to what 21a shipped. One renderer means the
budget, the search index, trace, the four consumers and the branch-carry block all see the same
bytes.

**Own choice: `topicGroups` is a façade read, not a fifth tool.** `topicGroups(sessionId,
headTurnId?, branch?)` returns `{topics: [{topic, commits}], unclassified}` over exactly the
path-selected set `inject` uses; a "commit" is the `{knowledgeId, commit}` reference of the revision
it was read from, never a copy of the record. A multi-topic commit appears in each of its groups, two
divergent applicable tips of one identity stay two entries, and topics are ordered by code point so
the projection is stable. The model-facing surface is untouched: no new tool, no slash command, no
topic browser.

**Own choice: `renderCommitHistory` does not print labels; the diff does.** The ruling asks that a
knowledge diff report topic changes even when the text is unchanged, and `renderKnowledgeDiff` now
prints `topics: a, b -> a, c` (with `none` for an empty side) beside the existing `reason:` line. The
per-commit history line was left alone: a revision's labels are already visible on its own rendered
knowledge line in `trace`, and repeating them on every history line would grow the block that
ticket 20 charges without adding information.

**Archive inheritance lives in one place.** The store copies `prior!.topics` in the INSERT, exactly
as it copies `prior!.category` and `prior!.scope`. The validator never builds an archive's labels, so
there is no second inheritance path to drift.

**No `ponytail:` corner was added by this slice.** Nothing here was knowingly left half-built. The
one pre-existing marker in `core/store/index.ts` (per-read DAG scan) is untouched; `topicGroups`
rides that same read, so it inherits that cost and adds no new scan.

## Probes

Each probe was applied to production code only, the **full** suite ran in the foreground, and the
file was restored from a copy and re-hashed with `shasum -a 256` against the pre-probe value.

| # | Mutation | Red tests | Result |
|---|---|---|---|
| a | `core/store/index.ts`, after the INSERT: `UPDATE knowledge_revisions SET topics = ? WHERE knowledge_id = ?` — labels as a mutable property of the stable K identity instead of the revision | **21b 2026-09-08: a topic-only update is an ordinary update; old commits keep their labels, clearing is explicit, merge states the survivor's set and archive inherits**; **21b 2026-09-08: a shared label alters no applicability, keeps its history labels and never collapses two applicable tips**; `simulation knowledge and strong negation goldens preserve Chinese memory content` (the Chinese trace golden, whose K1@1 would gain K1@2's label) | 3 failed / 562 |
| b | `core/render/index.ts`, `budgetKnowledge` sizes computed from `item.text.replace(/ · topics: [^\n]*/g, "")` — rendered labels emitted but not charged to the knowledge cap | **21b 2026-09-08: rendered labels are charged to the knowledge cap, and the leading block stays byte-identical across tasks** | 1 failed / 562 |
| c | `core/store/index.ts`, the knowledge search becomes `… WHERE text LIKE ? UNION ALL SELECT … FROM knowledge_revisions, json_each(topics) WHERE value LIKE ?` — one row per matching label instead of one row per revision | **21b 2026-09-08: one topic spans categories, one commit joins two groups, and a label absent from the text finds that commit once** | 1 failed / 562 |

Restoration, byte-for-byte:

```
2a826be158a5c3788e81120044963e1e569f7cf82990454de2c2c97f8ee0ebdf  core/store/index.ts
5fe24cc5f274e1a56a393894a3cfee836b65819b934c9599a9305e3f5004e831  core/render/index.ts
```

identical before the first probe and after the last, with `npm test` green (562) and `npm run
typecheck` clean afterwards. A first attempt at probe c (`LEFT JOIN json_each(topics)`) was discarded
before being reported: it also dropped every unlabelled revision from search, so it reddened twenty
pre-existing cases and would not have isolated the duplicate-hit rule. The reported probe c leaves
unlabelled knowledge exactly as it was and fails only on the duplication.

## Production line delta

```
 core/api/index.ts            |  7 +++++--
 core/api/read.ts             | 21 +++++++++++++++++++++
 core/api/tools.ts            |  6 +++---
 core/consolidation/commit.ts | 18 +++++++++++++++--
 core/model/index.ts          |  3 +++
 core/render/index.ts         |  6 +++++-
 core/store/index.ts          | 23 ++++++++++++++++------
 7 files changed, 70 insertions(+), 14 deletions(-)
```

Whole tree: 31 files, +446/−150; the balance is tests, fixtures, the prompt and documentation.

## Documentation

Every prompt change, since the hash moves with it:

`core/prompts/consolidation.md` (4 hunks)
1. "What you receive", the knowledge line: `[K1@57] text · supports: F…` becomes *"`[K1@57]
   [category/scope] text` with a metadata line `supports: F… · topics: subject, subject`. The topics
   are absent when that knowledge has none; what you see is the knowledge selected for this task, not
   every label in the project."* — the second sentence is the "bounded awareness" ruling, stated
   where the Consolidator reads the labels rather than as a separate rule.
2. Output fields, a new bullet after `reason`: *"`topics` is this revision's complete subject label
   set: create, update and merge each supply it in full, and an empty array means unclassified (on an
   update it clears the labels). Labels are trimmed and deduplicated; their case, language and
   spelling are kept, and their order carries no meaning."*
3. The create/update/merge bullet now reads *"also require the complete resulting `text`, `category`,
   `scope`, `topics`"*; the archive bullet *"it keeps its parent's category, scope and topics"*.
4. A new short paragraph before "scope and category are your judgment": **topics are subjects, not
   kinds** — reuse the exact visible label for the same subject, add one only when none names it,
   leave the list empty rather than invent a label, use module names or domain terms and never
   category words or the project's own name, labels grant no scope/evidence/lifecycle/accounting, and
   correcting a label later is an ordinary update with its complete unchanged text and evidence and a
   reason saying so. That one paragraph carries "reuse first", "classification only" and "gradual
   cleanup"; no checklist item, no new duty and no taxonomy step was added.

Other documents:

- `CONTEXT.md`: one new glossary term, **Topic**, beside **Supports** and **Reason**.
- `.scratch/v1/spec.md`: the `memory` tool contract (field list and the replacement/inheritance
  rules), the knowledge-commit paragraph, a new **Topics** bullet under "Knowledge commits and paths"
  (rendering, budget, literal search, `topicGroups`), the archive/merge bullet, the `core/store`
  module line, the `core/api` façade line and the `knowledge_revisions` schema line.
- `core/README.md`: the knowledge display grammar, the diff-metadata paragraph, the whole `memory`
  operation-shape paragraph (including the normalization rule) and the `search` paragraph, plus a new
  paragraph describing `topicGroups`.
- `hosts/pi/README.md`: the one sentence describing the `memory` tool now says create/update/merge
  also carry the revision's complete `topics` label set, and that core owns that schema.
- `test/fixtures/trace.json`: the simulation knowledge log gained Chinese labels (`地形数据`, then
  `地形数据` + `mod 运行时`), so the Chinese trace goldens now exercise labelled rendering and the
  `topics:` diff line. The fixture's Chinese knowledge text, facts and quotes are untouched; three
  `trace.test.ts` snapshots were regenerated for the two added segments.

## Fork gate

`hosts/pi/native.test.ts` was re-run in full after the prompt and schema change: **29 passed**,
including `19a 2026-09-08: the native child's first request passes prefix verification against the
captured parent request` and `19a ruling 2026-09-08: the anthropic-messages child passes the gate
with cache_control stripped from both sides and nothing else`. `verifyForkRequest` and
`verifyNativeRequest` were not touched.

The 21a gate case now also asserts, on the real SDK child's request: `operation.properties.topics`
deep-equals `{ type: "array", items: { type: "string", minLength: 1 } }`, the archive branch's
`else.required` is `["text", "category", "scope", "topics"]`, its `then.not.anyOf` contains
`{ required: ["topics"] }`, and the description carries the new topics sentence — beside the existing
byte-identical `tools` comparison between the two sides of the gate.

## Honest limits

- **No live provider ran.** No Consolidator has been observed choosing labels in a real run; the
  reuse-first paragraph is verified only by its hash moving and by the deterministic seams.
- **A database written before this slice is unreadable, by ruling.** `topics TEXT NOT NULL DEFAULT
  '[]'` is created with the table and there is no migration (v1 new-database policy), so an existing
  development database has no such column and `toKnowledgeRevision` will fail on it. An acceptor
  testing on an older file must point the plugin at a new one — the same hard cut 21a reported.
- **`topicGroups` needs an existing session.** It resolves the project through the session, so the
  project-only projection (`inject({projectId})`'s counterpart, before a session exists) is not
  exposed. Nothing in the ticket asks for it; adding it later is one branch.
- **Label quality has no floor.** Non-empty after trimming is the whole rule: a one-character label,
  a category word used as a subject, or two near-synonyms all commit. That is the ticket's own
  position (no registry, no controlled vocabulary, cleanup is ordinary maintenance), but it means
  vocabulary drift is a real outcome, not a prevented one.
- **Code-point order is not a linguistic order.** `Auth` sorts before `auth`, and Chinese labels sort
  after ASCII ones. The rule the tests pin is determinism and stability, not a reading order.
- **Search matches labels only in the knowledge layer.** `layer: "facts"` and `layer: "raw"` are
  untouched, and a topic is not an address: there is no `topic:` grammar in `trace`.
- **One flaky observation, not caused by this slice.** During one full-suite run under load,
  `hosts/pi/catchup.test.ts` failed once on a timing-sensitive case; it passed in isolation and in
  every later full run (five green full runs, including all three probe runs' 562-total baselines).
  It touches no topic code.
