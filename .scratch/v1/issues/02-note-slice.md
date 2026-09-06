# 02 — Note slice: raw in, facts out, traceable

**What to build:** Feed a fixture conversation (turns with tool calls) into the façade; a note run renders the raw since the watermark with the standard structured cuts, builds the note input (rendered raw, recent facts by freshness, active entries, range), calls `runAgent`, validates the batch array, resolves `$n` handles, and commits facts, relations, the run record, the advanced watermark, and a pending delivery in one transaction. `trace T<n>` shows the rendered turn with `tool=`, `full`, `cap=`; `trace F<n>` shows the fact line with source, inbound and outbound relations.

**Blocked by:** 01 — Store and façade skeleton.

**Status:** ready-for-agent

- [ ] One renderer produces the turn text used for note input and for `trace T`; cuts carry omission markers with counts; a fixed metadata line per tool call (ordinal, tool, status, omitted flag)
- [ ] Note run freezes session, branch, range end, and read entry revisions at start; commits advance the watermark only to that end
- [ ] A turn arriving while `runAgent` is pending is not included and is picked up by the next trigger (behaviour test)
- [ ] Invalid model output (bad category, unknown `F` id, bad `$n`, id in text, event without prefix) bounces with a problem list; nothing is committed except the run record
- [ ] `runAgent` failure or cancellation commits only the run record; a repeated trigger while a run is in flight is dropped
- [ ] `trace T`, `trace F` render per CONTEXT.md line formats; receipts (omitted calls, expand addresses) come after the content
- [ ] Golden tests for turn rendering and fact lines from a fixture cut from the simulation data
