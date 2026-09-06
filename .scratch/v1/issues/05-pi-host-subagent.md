# 05 — Pi host, subagent mode

**What to build:** A Pi extension that wires `agent_settled` (note when ≥5 answered turns or ≥50K tokens since the watermark; settle when unsettled facts reach the count), `session_before_compact` (returns the compaction block, no model call), `before_agent_start` (injects the entries block at session start and any pending note deliveries for this branch), registers the tools `trace`, `search`, `mark` and the read-only `/trace` command, and implements `runAgent` as a fresh call (subagent mode) with the session model by default and a configurable override. Verified by hand in a real Pi session: talk, see a note run, compact, trace.

**Blocked by:** 04 — Read slice.

**Reference:** a vendored Pi source checkout (v0.84.4, upstream 853a80d, 2026-09-01) is at /Users/zhaoqixuan/Projects/action-roleplay/third_party/pi — packages/coding-agent/src/core/extensions/{types,runner}.ts for hook signatures, packages/coding-agent/docs/{extensions,sdk,sessions,compaction}.md, and packages/coding-agent/examples/extensions/ (custom-compaction.ts, handoff.ts) for working patterns. Read it; do not copy it into this repo.

**Status:** ready-for-agent

- [ ] Host code imports the core only through the façade; core has no Pi imports
- [ ] `runAgent` returns the exact provider request it sent; the run record stores it
- [ ] Pending deliveries are injected once, on the branch they belong to, then marked delivered
- [ ] Repeated `agent_settled` while a run is in flight does not start a second run
- [ ] Manual verification transcript recorded (what was said, what got noted, what compaction produced)
