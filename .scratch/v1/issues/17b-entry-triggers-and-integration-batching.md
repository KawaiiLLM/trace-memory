# 17b — Entry-driven triggers, Integration without Turn batching, no lifecycle flush

**Parent:** 17 — Entry Recording and closed-session catch-up.

**What to build:** every eligible entry completion checks the active session's queues. Recording launches at 10,000 pending compressed-view tokens (no answered-Turn trigger, no entry count) and takes the oldest contiguous pending entries that fit 50,000 tokens of rendered views, stopping at no Turn boundary; the rest waits for another completion. Integration launches at fifty applicable unintegrated facts and selects eligible facts without grouping or waiting by Turn; a fact is eligible the moment its Recording commits, and per-fact path-aware accounting stays. Finishing a worker starts nothing. Compaction, shutdown and tree switching launch no extraction: the tree-switch Recording of the abandoned branch is removed and the summary uses committed memory plus the shared pending view.

**Blocked by:** 17a — Entry units and the shared compressed Raw view.

**Status:** ready-for-agent (held)

- [ ] Recording triggers at exactly 10,000 compressed-view tokens and not below, regardless of entry count or original size.
- [ ] More than 50,000 tokens of eligible views yields an oldest-first whole-entry prefix within the limit and the next completion sees the remainder; one Turn spanning several batches and one batch spanning several Turns are both covered. If even the oldest entry cannot fit the effective budget it stays pending and the capacity problem is reported.
- [ ] Forty-nine facts do not trigger Integration, fifty do; facts of a partly recorded Turn are eligible; non-monotonic Turn/fact order skips nothing and reintegrates nothing. The two 2026-09-07 rulings tests for turn-boundary batching and "unrecorded turn never enters a batch" are rewritten to record their supersession.
- [ ] Compaction and shutdown launch neither phase and preserve pending work; a running task settles under the existing bounded shutdown wait without a new flush. `session_before_tree` launches no Recording.
- [ ] Configuration: the answered-Turn trigger is gone, the size trigger is compressed-view tokens, the three limits are validated; the host README, spec, glossary and prompts change together.
- [ ] Revert probe: restoring a lifecycle flush, or grouping Integration by Turn, makes a named test fail.
