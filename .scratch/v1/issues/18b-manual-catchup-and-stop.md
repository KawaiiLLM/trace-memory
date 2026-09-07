# 18b — Manual catchup and stop

**Parent:** 18 — Session enrollment and settings menu (section "Manual catchup and stop", the catchup/stop menu actions and acceptance scenarios 18–21).

**What to build:** `/trace catchup` drains a finite snapshot of the current enabled session's selected path: reconcile native history, freeze the pending entry boundary and pending fact set, then run bounded Noting batches followed by Consolidation of the frozen facts plus those the drained batches produced, in subagent mode, chaining batch to batch as the sole exception to the no-completion-chaining rule, ignoring trigger thresholds but not batch or context limits, using 17c's executor slots and target claims (Waiting when occupied, cancellable). `/trace stop` ends the manual drain and cancels this executor's workers through 17c's fenced cancellation without touching the foreground agent, enrollment or configuration. The menu gains Catch up and Stop; status shows running, waiting, completed, stopped or failed.

**Blocked by:** 18a and 17c.

**Status:** ready-for-agent (held)

- [ ] Parent scenarios 18 (manual finite drain), 19 (capacity and command parity), 20 (stop and resume), 21 (drain lifecycle).
- [ ] Revert probes: letting a manual drain expand its snapshot with later entries, chaining batches outside a manual catchup, or stop releasing another owner's claim each make a named test fail.
