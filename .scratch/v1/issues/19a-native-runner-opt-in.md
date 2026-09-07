# 19a — Native Pi runner behind an opt-in switch, with the acceptance gate

**Parent:** 19 — Native Pi fork runtime (rulings, gates and full decisions live there).

**What to build:** a second execution path in the Pi adapter, selected by an opt-in configuration switch, that runs a Recording or Integration task on a native child session: open the parent session file through an independent `SessionManager` with the runs directory, `createBranchedSession` at the frozen persisted entry, `createAgentSession` on that manager with extension, skill and project-context discovery disabled, only the four memory tools registered and tool execution sequential. The child carries the parent's request identity for caching, captures its outgoing body through `onPayload`, and that body is checked byte for byte against the captured parent prefix by the existing verification. The run record links the child's JSONL under `dirname(dbPath)/runs/<parent id>/`, counts usage from newly generated assistant messages only, records `auto_retry` events as retries, and takes its outcome from core commit state first and the terminal reply second; `prompt()` resolving is not success. The old runner stays the default and is untouched.

**Blocked by:** 17c — Closed-session catch-up (the 17 series lands first; 19a touches the same host input assembly as 17a and the scheduling 17b changed).

**Status:** ready-for-agent (held)

- [ ] With the production Recorder and Integrator prompts and the four tools, the child's first request passes `verifyRequest` against the captured parent request; the run record stores both hashes and the verification result. This is the gate for 19b and 19c.
- [ ] The parent file, id and tree position are byte-identical before and after a child run; the child has its own id and JSONL under the runs directory; the foreground `/resume` list does not show it.
- [ ] A real Recording write and a two-submission Integration run complete through native tool execution; out-of-range source entries are rejected even though they exist in copied history; a trailing provider error after a commit leaves the commit and records the problem.
- [ ] Copied plugin custom state activates no extension and starts no worker; the tool whitelist and sequential execution are visible in call order.
- [ ] Usage equals the sum of the child's new assistant messages including failed attempts; copied parent usage is excluded; a cancelled request without usage is recorded as unknown, not zero.
- [ ] Cache reads per child response are recorded as observations; no test asserts a hit.
- [ ] Revert probes: using the foreground `SessionManager`, copying the whole tree instead of the selected ancestry, summing copied usage, and treating a resolved `prompt()` as success each make a named test fail.
