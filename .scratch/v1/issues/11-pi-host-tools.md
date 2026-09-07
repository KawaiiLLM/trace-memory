# 11 — Pi host: four tools from the façade, tool rounds in both modes, `/trace project` and `/trace mark`

**What to build:** The Pi host registers the four façade tools for the main agent (not prompted to use the write tools), executes model tool calls during Noting and Consolidation runs in both modes, and serves marks and project declaration as `/trace` subcommands. In branch mode a tool round appends the assistant call and the tool results to the verified request, so the prefix never changes; in subagent mode it extends the conversation. Consolidation's two submissions run through the same loop.

**Blocked by:** 10 — `memory` tool.

**Status:** ready-for-agent

- [ ] The definitions registered for the main agent and the ones sent in subagent runs are the same façade objects; a branch-mode run verified against a captured prefix containing them passes with nothing added per run (test: capture with the four tools, run, verification passed, tools unchanged)
- [ ] Branch mode: `note`/`memory`/`trace` calls are executed, the assistant message and tool results are appended in the provider's native shapes (extend `branch.ts` for tool-call and tool-result items per API: anthropic-messages, openai-completions, openai-responses), the model is called again, every round is verified against the previous request; the run record stores the last request
- [ ] Subagent mode: the same loop through `modelRegistry.complete`; the Consolidation second submission is a further tool round, not a separate conversation; the former continuation state is gone
- [ ] Main-agent calls route to the session-bound façade tools and commit at once; they are also recorded as raw tool calls of the turn
- [ ] `/trace` alone stays read-only status; `/trace project <name>` declares and re-injects; `/trace mark K<n> verified|flagged|clear` marks; the `mark` tool is gone
- [ ] README and LIVE-VERIFICATION updated; the acceptor (not the worker) records a live run: a branch Noting that fetches through `trace`, and an Consolidation through `memory`
- [ ] Revert probes named in the report: a branch tool round not verified; a tool added per run; the mark tool still registered
