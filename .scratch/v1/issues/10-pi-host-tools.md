# 10 — Pi host: four tools registered from the façade, tool loop in both modes, `/trace project`

**What to build:** The Pi host registers the four tools from `tools(context)` for the main agent (the main agent is not prompted to use the write tools; the descriptions say extraction runs are the normal writers), executes model tool calls during note and settle runs in both modes, and moves project declaration to `/trace project <name>`. In branch mode a tool round appends the assistant call and the tool results to the verified request, so the prefix never changes; in subagent mode it extends the conversation. Settle's two rounds use the same loop with the feedback message between them.

**Blocked by:** 09 — Entry tool.

**Status:** ready-for-agent

- [ ] The tool definitions registered for the main agent and the ones sent in subagent runs are the same objects from the façade; a branch-mode note verified against a captured prefix that contains them passes with no per-run tool added (test: capture with the four tools, run, verification passed, tools unchanged)
- [ ] Branch mode: a `fact`/`entry`/`trace` call is executed, the assistant message and tool results are appended in the provider's native shapes (extend `branch.ts` for tool call and tool result items per API; anthropic-messages, openai-completions, openai-responses), the model is called again, and every round is verified against the previous request; the run record stores the last request
- [ ] Subagent mode: same loop through `modelRegistry.complete`; settle final round replays the candidate conversation and the feedback message as today
- [ ] Main-agent calls route to the façade's session-bound tools and commit at once; they are also recorded as raw tool calls of the turn
- [ ] The `mark` tool is gone; `/trace project <name>` declares the project and re-injects entries; `/trace` alone stays read-only status
- [ ] README and LIVE-VERIFICATION updated; a live run (branch note fetching through `trace`, settle through `entry`) is recorded by the acceptor, not the ticket worker
- [ ] Revert probes named in the report: branch tool round not verified; tools added per run; mark tool still registered
