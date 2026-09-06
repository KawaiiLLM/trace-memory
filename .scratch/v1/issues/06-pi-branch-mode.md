# 06 — Pi branch mode and prefix verification

**What to build:** A second `runAgent` implementation that sends a call whose system prompt, messages, and tool definitions are byte-identical to the session's current request plus one appended user message carrying the note instruction; a verification script that captures both requests via `before_provider_request`, compares them structurally, and records cache-read usage as an observation; automatic fallback to subagent mode when verification fails, stated in the run record. Note defaults to branch mode when verified.

**Blocked by:** 05 — Pi host, subagent mode.

**Status:** ready-for-agent

- [ ] Structural comparison of system prompt and message prefix passes on a real session; the report shows both bodies' hashes and the appended message
- [ ] Cache-read usage reported alongside, never as the sole proof
- [ ] Verification re-runs when the model, provider, or tool definitions change
- [ ] Run records distinguish branch and subagent modes and note the inherited-context difference
