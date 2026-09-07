# 09 — `note` tool: Noting writes facts through one atomic batch

**What to build:** The `note` write tool replaces the Noter's JSON text output. The façade exposes `tools(context)` returning the four definitions (`trace`, `search`, `note`, `memory`; `memory` may reject everything with "ticket 10" here). A Noting run receives them; the model submits one `note({facts})` batch; every fact is validated and the batch commits atomically or the result lists per-item outcomes and nothing is written. The main agent's binding commits at once as a `manual` run. The Noting prompt describes the tool; the text-JSON parsing path is deleted.

**Blocked by:** 08 — Vocabulary rename.

**Status:** ready-for-agent

Spec section "Write tools" carries the rules; quote them in tests. Ruling (user, 2026-09-07): four tools, main agent allowed but not prompted.

- [ ] `tools(context)` returns four definitions with name, description, JSON-schema parameters and `execute`; bound to a Noting run (frozen range, session, branch) or to a main-agent session; descriptions say the runs are the normal writers
- [ ] `note` validates each fact with the existing shape rules (categories, actor, no ids in text, `$n` only to an earlier fact of the same batch, `F<id>` to existing facts, sources `T<id>#user` / `T<id>#assistant` / `T<id>#t<n>` inside the frozen range or the calling session) and returns per item `ok` / `rejected: <reason>`; any rejection means nothing is written; a second submission of the corrected batch commits and the result then lists each fact's `F<id>`
- [ ] `status` (completed | reported | dispatched | attempted) is a fact field: required when category is `event`, rejected otherwise; the text carries no prefix; the renderer prints `<status>: ` before an event's text so goldens and readers see the same line as before; the store gains a `status` column
- [ ] The model writes no timestamp: `created_at` is the `started_at` of the turn of the fact's first source; the renderer shows it as before; the field is removed from the prompt, the validator and the schema
- [ ] Outcomes: a run whose model stops normally without submitting is a success with zero facts and the watermark advances; a run whose last submission was rejected and not corrected is `bounced`, the rejected batch and reasons stay in the run record, the watermark does not move; length, cancellation and provider errors are `failure` / `cancelled`; pin all three in tests
- [ ] `trace` takes `{address, tool, full, cursor, cap}`: `tool` and `full` move out of the address string, the per-output `cap=` flag is removed, expansion hints in rendered output name the parameter form; `search` takes `{query, layer, cursor, cap}` with `layer` = facts | knowledge | raw | all; tool descriptions state the visibility binding and that `F<n>..` is navigation only
- [ ] A run commits at most one batch; a later `note` call in the same run is rejected with "already committed"; the run record, watermark and pending delivery commit in the same transaction as the batch
- [ ] A run that stops without a committed batch records success, advances the watermark, queues no delivery
- [ ] A main-agent `note` call commits immediately as a run of kind `manual` (session, branch, turn, request = input, response = result); its facts appear in `listBranchFacts` and Consolidation ranges
- [ ] The run record's `request` is the last provider request reported by the host and `response` holds the tool-call sequence with results; `fetched` remains for `trace` calls
- [ ] The fake runAgent exercises the loop through one seam: it receives the definitions and calls `execute` itself; no test imports below the façade
- [ ] noting.md Output section rewritten for the tool (source example includes `T<id>#assistant`; negate defined as "this fact opposes or invalidates the target's claim, strength is the noter's confidence"; relation model unchanged per ruling T181); the JSON validator and parsing removed; rulings tests pin "four tools, no other model-facing surface", "a rejected item writes nothing", "one batch per run", "bounced is not empty"
- [ ] Report the core line delta: the deleted JSON path against the tool layer
