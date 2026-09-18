# Trace Memory Claude Code plugin

The standalone plugin requires Node >=24.6.0 and fails at its bundled entry before loading adapter or SDK code on an older runtime. It never downloads or installs a replacement runtime.

Before loading the plugin, edit `cc.config.json`. Set absolute paths for `stateDir`, `worker.claudeExecutable`, and the worker's private `cwd`; set the prepared model's finite `contextWindow`. CC defaults to `worker.model: "opus"` and `worker.effort: "high"` for all three memory phases. These settings belong only to CC: they neither read nor change Pi's model/thinking preferences, and do not inherit the foreground CC session's selection. The adapter is pinned to Claude Code 2.1.257. Missing required values fail explicitly. The file is the only mutable plugin configuration surface and must not contain credentials.

Omit `dbPath` to use `~/.trace-memory/trace.db`, the same default as Pi. An existing database is opened in place, never replaced or copied by installation; an absent database is created on first use. Set an explicit absolute `dbPath` only to use another database (or to match a customized Pi path). Database reuse includes the existing Store's normal schema migration checks; it does not reset facts, knowledge, or enrollment. Project knowledge still requires the same explicitly declared project name on both hosts.

The plugin registers one SessionStart Hook, one SessionEnd Hook, one stdio MCP server, and the user-invoked `trace` skill. Installation does not run a package manager.

## Session commands

Use `/trace-memory:trace catchup` to drain pending memory work. The same entry accepts these subcommands:

| Subcommand | Effect |
| --- | --- |
| `on` | Enable memory for this session; does not start a catchup. |
| `off` | Stop this executor's work and disable memory. |
| `catchup` | Start one finite Noting/Consolidation drain, or report the active drain. |
| `stop` | Stop this executor's work without disabling memory. |
| `project <name>` | Declare this session's shared project. |

The pinned Claude Code version also gives the skill a `/trace` alias. Use the full `/trace-memory:trace` name when another skill or command is named `trace`; the native alias resolver does not reject ambiguous matches. Pi's command remains `/trace`.

The skill forwards to the same CLI shown below, using the current native session ID. Unlike Pi's direct command callback, a Claude Code skill instructs the foreground model to execute that CLI under normal shell permissions. No permission bypass or model-side security boundary is implied. A bare or invalid invocation shows usage; there is no Pi-style settings menu.

`catchup` requires an enabled session and its live MCP executor. It reconciles the current path, freezes pending entries and facts, then processes bounded Noting batches followed by Consolidation of those facts and the facts those batches produced. Later input is not added to that drain. Normal batch/context limits and claims still apply; trigger thresholds do not. It does not force Dreaming. Repeating the command reports an active drain instead of creating another. Acknowledgement is not completion, and `stop`, `off`, path changes, or shutdown end the drain while retaining committed work.

## Direct CLI

Run the same operator commands from a trusted shell or Claude Code's `!` shell escape with the native session ID:

```sh
node "$CLAUDE_PLUGIN_ROOT/dist/cc.cjs" cli \
  --config "$CLAUDE_PLUGIN_ROOT/cc.config.json" \
  --session <native-session-id> on
```

Replace `on` with `off`, `catchup`, `stop`, or `project <name>`. `stop` reports the executor's abort acknowledgement separately from observed process termination. Neither entry installs the plugin, edits configuration, or starts a replacement executor when the session's MCP executor is absent.
