# 20a — Shared memory material: core-owned assembly and stable ordering

**Parent:** 20 — Shared memory material and bounded compaction (sections "Core and host ownership" and "Material order and cache scope"; acceptance scenarios 1, 2 and the host-stub part of 15).

**What to build:** core owns the host-neutral domain text of every memory consumer. The material types of 19b evolve into one shared contract (rendered knowledge, historical facts, compressed Raw entries with source identity, budget receipts; plus the task-specific parts: frozen range, source index, head reply, pending facts, review cues) and core renders that contract into final text with its own titles, block order and separators, in the ruled order: Noter = Knowledge → historical facts → range → selected Raw → receipts; Consolidator = Knowledge → already-consolidated facts → range → selected pending facts → negation reminders → receipts; initial injection = Knowledge → receipts; compact = Knowledge → historical facts → pending Raw → receipts. Core also exposes the inherited-context increment (instruction, range, head reply, source index; ruling 08:53) from the same frozen task. The Pi host deletes its own layout (`hosts/pi/compose.ts`) and only places core's text into native system/user messages or steering and runs the native child; a host with no Pi message types can execute the note/memory protocol on the same text. The leading knowledge block is byte-identical across two tasks that share the same selected knowledge and differ only in range or Raw: no range, batch entry id, timestamp, run id or omission count inside it.

**User confirmations (2026-09-08):** the 19b ban on core-composed domain text is revised by the user's own ruling — core stays out of provider messages, bodies and model loops, and now owns domain text; no cache hit is claimed from the ordering.

**Blocked by:** None — can start immediately (baseline: the tree after the review repairs, a064860).

**Status:** ready-for-agent

- [ ] Scenario 1: a host stub with no Pi/CC message types receives core-prepared text and completes note and two-submission memory runs; initial injection, compact and both phases use the shared rendering; no host file lays out knowledge/facts/Raw.
- [ ] Scenario 2: two Noter tasks with identical knowledge and different Raw/ranges are byte-identical through the knowledge block; facts precede the range; receipts follow the dynamic material; Consolidation uses its ruled order. A byte-layout test, not a cache test.
- [ ] Inherited-context increment and full material come from one frozen task; the fork appends only the increment and the writable range is identical in both modes.
- [ ] Revert probes: a host re-implementing the block layout, and a range or entry id leaking into the knowledge block, each make a named test fail.
