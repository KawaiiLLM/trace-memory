# 17c — Closed-session catch-up (reduced form)

**Parent:** 17 — Entry Recording and closed-session catch-up.

**What to build:** a session that shuts down normally is marked closed; while it stays closed, any other enabled session's entry completion gives it one bounded opportunity per phase: one subagent Recording batch if its entry queue is nonempty and one subagent Integration run if it has an unintegrated fact, regardless of thresholds, against the closed session's own project, branch and frozen path, with its costs and deliveries attributed to it. Admission is one atomic claim per phase on the session row with a token and a thirty-minute expiry; the commit fences on that token and on the session still being closed. Reopening clears the closed mark, so no new claim succeeds and a running catch-up fails its fence at commit while the reopened session's own work proceeds. There is no heartbeat and no liveness detection: a crashed session waits until it is resumed (user ruling 2026-09-08).

**Blocked by:** 17b — Entry-driven triggers, Integration without Turn batching, no lifecycle flush.

**Status:** ready-for-agent (held)

- [ ] Another session's entry completion triggers one subagent Recording batch for a one-entry tail and one subagent Integration run for a one-fact tail; an empty Recording queue does not hide a nonempty Integration queue; larger tails need later completions.
- [ ] Catch-up runs carry the target session's identity, branch, cost attribution and delivery destination, never the active session's evidence context.
- [ ] Reopen during selection admits no new claim; reopen during execution lets the running task reach its fence and write nothing; no competing foreground task of the same phase is launched.
- [ ] Two processes racing one claim admit exactly one writer per phase; after the owner is killed and the claim expires, a stale commit from the old owner writes nothing (child-process check in the shape of the existing store write-lock test).
- [ ] Failed catch-up work stays pending; a successful zero-fact Recording still advances its selected entries.
- [ ] Revert probe: removing the fence, or removing the closed-session condition from the claim, makes a named test fail.
