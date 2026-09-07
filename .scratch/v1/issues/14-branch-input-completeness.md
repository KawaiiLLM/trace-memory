# 14 — Branch Recording input: the missing final reply, a source index, and traceable source addresses

**What to build:** In branch mode the Recorder sees everything the range holds and can name where each fact came from. The appended message carries, after the range line, the head turn's final assistant reply (the one piece of range raw that is never in the captured prefix, because the prefix is the request that produced it) rendered with its `T<id>#assistant` tag, and a compact source index of the range: for every turn its `T<id>#user`, `T<id>#assistant` and `T<id>#t<n> tool=<name>` addresses with a short preview each, no raw copied. `trace` accepts `T<n>#user`, `T<n>#assistant` and `T<n>#t<k>` and renders only that part, so a fact's printed source can be handed straight back to `trace`.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

Adopted by the user on 2026-09-07 (「可以」) from an input audit. Ruling kept: recording defaults to branch (17:01); the branch message carries the range and the instruction (08:53), and this ticket repairs that rule's premise the same way the delivery deferral did: the prefix must actually contain the range raw, and what it cannot contain is appended. Subagent mode is unchanged.

- [ ] The branch input is `Range: …`, then the head turn's final assistant text under `[Source entry id: T<id>#assistant]` exactly as `renderTurn` prints it (nothing when the head turn has no assistant text), then `Sources:` with one line per turn of the range listing its addresses and a preview of at most 60 characters each; tool-call lines carry `tool=<name>`
- [ ] The subagent input is unchanged; the prompt's "when this message carries only the range" sentence is reworded to describe the new branch message
- [ ] A ruling test: with a two-turn range whose head turn has an assistant reply and a tool call, the branch input contains the reply text, contains `T<head>#assistant`, `T<first>#user`, `T<head>#t1 tool=`, and does not contain the first turn's user prompt beyond its preview
- [ ] `trace` address grammar gains an optional `#user | #assistant | #t<n>` suffix on `T<n>` and `S<m>/T<n>`; the output is that message or that tool call alone (the tool call with the standard cut unless `full`); a suffix that names a missing part is rejected with the reason; `checkAddress` in the tool layer accepts the suffix; the search results and fact renders stay as they are
- [ ] Live run recorded by the acceptor: a branch Recording whose fact cites `T<id>#assistant` for content that only the final reply contained
- [ ] Revert probes named in the report: drop the appended reply; drop the source index; reject the suffix in trace
