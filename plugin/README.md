# Trace Memory Claude Code plugin

The standalone plugin requires Node >=24.6.0 and fails at its bundled entry before loading adapter or SDK code on an older runtime. It never downloads or installs a replacement runtime.

Before loading the plugin, edit `cc.config.json`. Set absolute paths for `stateDir`, `worker.claudeExecutable`, and the worker's private `cwd`. In `worker.contextWindows`, supply the prepared context capacity for each selected model, keyed by its exact configured name; each must be a safe integer greater than 10,000. The template's `null` values require explicit preparation, not a guessed capacity. The adapter is pinned to Claude Code 2.1.257.

CC uses the same flat phase-setting keys as Pi. The shipped defaults are:

| Phase | Model key | Default | Thinking key | Default |
| --- | --- | --- | --- | --- |
| Noter | `notingModel` | `sonnet` | `notingThinking` | `high` |
| Consolidator | `consolidationModel` | `opus` | `consolidationThinking` | `high` |
| Dreamer | `dreaming.model` | `opus` | `dreaming.thinking` | `high` |

These are top-level JSON keys, including the literal dots in the Dreamer keys. CC and Pi store their values separately: this file neither reads nor changes Pi settings. CC does not inherit the foreground selection, so `session` and `inherit` fail explicitly. Its adapter converts each thinking setting to the SDK's effort and verifies native model support; unsupported settings are not silently replaced. All six settings are required when `worker` is present. Omit `worker` only for ingestion/read-only operation.

A phase uses its selected model, thinking level and capacity consistently for admission, execution and run records, including borrowed work and catchup. Capacity is looked up by model name, not copied from another phase. Restart CC after configuration changes; an already running executor retains its resolved settings.

**Upgrade from the single-model configuration:** remove `worker.model`, `worker.effort` and `worker.contextWindow`; set the six phase keys above and register each selected model's capacity in `worker.contextWindows`. The retired fields are rejected rather than used as a shared fallback. The file is the only mutable plugin configuration surface and must not contain credentials.

Omit `dbPath` to use `~/.trace-memory/trace.db`, the same default as Pi. An existing database is opened in place, never replaced or copied by installation; an absent database is created on first use. Set an explicit absolute `dbPath` only to use another database (or to match a customized Pi path). Database reuse includes the existing Store's normal schema migration checks; it does not reset facts, knowledge, or enrollment. A new session on either host joins the project its repository directory (the git repository root, or the real cwd outside a repository) already has when that is exactly one project; the home directory and temporary directories are excluded, and `project <name>` overrides.

The plugin registers one SessionStart Hook, one SessionEnd Hook, one stdio MCP server, and the user-invoked `trace` skill. Installation does not run a package manager.

## Session commands

Use `/trace-memory:trace catchup` to drain pending memory work. The same entry accepts these subcommands:

| Subcommand | Effect |
| --- | --- |
| `on` | Enable memory for this session; does not start a catchup. |
| `off` | Stop this executor's work and disable memory. |
| `catchup` | Start one finite Noting drain with threshold-driven C/D checks, or report the active drain. |
| `stop` | Stop this executor's work without disabling memory. |
| `project <name>` | Declare this session's shared project. |

The pinned Claude Code version also gives the skill a `/trace` alias. Use the full `/trace-memory:trace` name when another skill or command is named `trace`; the native alias resolver does not reject ambiguous matches. Pi's command remains `/trace`.

The skill forwards to the same CLI shown below, using the current native session ID. Unlike Pi's direct command callback, a Claude Code skill instructs the foreground model to execute that CLI under normal shell permissions. No permission bypass or model-side security boundary is implied. A bare or invalid invocation shows usage; there is no Pi-style settings menu.

`catchup` requires an enabled session and its live MCP executor. It reconciles the current path and freezes the pending Raw boundary. Noting drains it in bounded subagent batches, ignoring only N's trigger threshold; later Raw does not extend the drain. Each successful N completion checks C's normal threshold, and each successful catchup-launched C completion checks D's normal per-pool thresholds, even after the last N batch. No new foreground message is needed. C/D are not unconditional drains, and D completion launches nothing.

Catchup uses ordinary slots and claims: N and C may overlap, at most one of each per session; D has one database-wide seat and one pool per run. A busy completion trigger is skipped, not retained or retried on slot release. Low-threshold tails may remain when catchup finishes. Repeating the command reports the active drain. Acknowledgement is not completion; `stop`, `off`, path changes and shutdown fence further launches while retaining committed work.

The executor's first successful enabled reconciliation publishes the complete historical path and checks that final path once, including when the SessionStart Hook already imported it. It never replays thousands of historical scheduling opportunities. Later live ingested entries retain their individual checks; unchanged polling starts no task. A failed attachment discards its resources even when cleanup throws, reports the original error rather than readiness, and retries from fresh resources only on the next existing wake.

Project declaration keeps the Noting/Consolidation backlog and live-claim guards; pending Dreaming alone does not block it. It waits for an active Dreamer whose session belongs to an affected project or whose frozen range touches an affected pool. Moving project knowledge preserves its revision identity and existing processing records: only a destination pool that has not handled that version sees it as pending.

## Database upgrade

Stop older Pi and CC executors before opening the shared database with this upgrade; mixed-runtime writes are unsupported. The transaction preserves source, fact, knowledge-history, session and project records. Historical empty support lists inherit their parents' supports; root-empty ancestry remains empty and is reported. Knowledge marks are removed entirely.

The old-default budget policy (4k/10k/1k) becomes 4k/15k/1k; custom policies are kept and reported. Legacy processing records are translated only for current visible versions into their current pools. This translation does not mark every version handled or change knowledge validity. Validate the upgrade on a consistent database copy before deployment. Existing files keep their journal mode on Store/worker open: WAL conversion is an explicit stopped-executor operation, not an implicit worker migration. Stop all executors, take and validate a consistent backup, then convert manually and verify the mode before restarting. Code installation and database conversion are separate operations.

## Direct CLI

Run the same operator commands from a trusted shell or Claude Code's `!` shell escape with the native session ID:

```sh
node "$CLAUDE_PLUGIN_ROOT/dist/cc.cjs" cli \
  --config "$CLAUDE_PLUGIN_ROOT/cc.config.json" \
  --session <native-session-id> on
```

Replace `on` with `off`, `catchup`, `stop`, or `project <name>`. `stop` reports the executor's abort acknowledgement separately from observed process termination. Neither entry installs the plugin, edits configuration, or starts a replacement executor when the session's MCP executor is absent.
