# 19b — Core stops assembling model context; subagent parity

**Parent:** 19 — Native Pi fork runtime.

**What to build:** `RecordingAgentInput` and `IntegrationAgentInput` become structured task material (prompt file, frozen range and entry or fact list, reminders, review feedback, the frozen knowledge commits) with no system or user message strings, no provider bodies and no mode-specific concatenated input; the Pi adapter composes messages for both native fork and native subagent, the latter on a fresh private `SessionManager` in the runs directory, so one runner serves both modes and closed-session catch-up (17c) keeps forcing subagent. Core keeps the view renderers, source queries, evidence eligibility, validation, tools, review feedback, atomic commits and progress. The adapter supplies its available material budget before core selects a batch (parent section, gate 4). A host that cannot expose the provider request reports that limitation explicitly instead of fabricating one.

**Blocked by:** 19a — Native Pi runner behind an opt-in switch (its gate must have passed).

**Status:** ready-for-agent (held)

- [ ] No core module builds a message sequence or a provider body; a host stub that accepts the structured material and reports unavailable request audit passes the same core validation and commit contract.
- [ ] Native subagent runs use the native runner with a fresh manager; no legacy custom tool loop runs in either mode; the fallback reason and actual mode are recorded when fork is unavailable.
- [ ] Given a budget below the 50k material ceiling, core selects and freezes a smaller oldest-first batch before the only model call, with matching request material, audit range and write eligibility; when the oldest entry cannot fit, the task stays pending with a capacity problem.
- [ ] The Integration review round uses native messages or steering and preserves the two valid submissions.
- [ ] Revert probe: restoring a core-built message string, or activating inherited extensions in the subagent manager, makes a named test fail.
