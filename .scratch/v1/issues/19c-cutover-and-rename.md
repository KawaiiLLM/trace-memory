# 19c — Readiness, cache-miss latch, cutover, deletion and rename

**Parent:** 19 — Native Pi fork runtime.

**What to build:** the native runner becomes the only runner. Tasks launch from a persisted checkpoint that can be reopened, never from a message completion alone; an assistant tool-call group with missing results defers the launch or takes the documented subagent fallback; a tree switch invalidates a stale launch context. The cache-miss latch lands as ruled and gated (parent section, gate 3): after the prefix check passed, one eligible `cacheRead = 0` response downgrades later tasks of the session to subagent with one TUI warning, audited, reset through the trace command; unknown usage is not a miss. Cancellation is wired into the child `AgentSession`; disposing a child never touches the parent or other workers. Then delete the old runner: the custom conversation loop, custom provider-message construction, the handwritten retry-settings reader (replaced by Pi's `SettingsManager`) and its stale comment; keep `verifyRequest` as the gate. Finally rename the execution mode from branch to fork in configuration, status, prompts and run metadata with the old spelling accepted as an alias; historical branch-mode runs are labelled legacy request-copy execution, not rewritten.

**Blocked by:** 19b — Core stops assembling model context.

**Status:** ready-for-agent (held)

- [ ] A completion before persistence launches nothing; the next safe boundary launches once with a real entry id and no request capture; a partial multi-tool group defers or falls back; a tree switch before launch does not substitute the new branch's history.
- [ ] Cache eligibility: a positive hit, below-minimum input, missing or placeholder usage, provider error or cancellation, disabled or unsupported caching, unknown provider limits, and a request that failed the prefix check none of them set the latch; one eligible miss after a passing prefix check sets it, warns once, survives reopen, and clears only through the explicit reset; two in-flight phases reporting misses together produce one transition.
- [ ] After deletion no legacy loop, prefix builder or settings reader remains; `verifyRequest` remains and still runs on every fork request; the report shows production lines added and removed against the 19a baseline.
- [ ] Rename: canonical `fork` in new metadata and configuration, `branch` accepted as an alias with the canonical form winning and the conflict reported; historical runs keep their actual mode; docs, prompts, status wording and the glossary change together.
- [ ] Revert probes: restoring a lifecycle-style launch from a completion, counting a prefix-failed request toward the latch, or rewriting historical run modes each make a named test fail.
