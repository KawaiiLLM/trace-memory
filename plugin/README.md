# Trace Memory Claude Code plugin

The standalone plugin requires Node >=24.6.0 and fails at its bundled entry before loading adapter or SDK code on an older runtime. It never downloads or installs a replacement runtime.

Before loading the plugin, edit `cc.config.json`. Set absolute paths for `dbPath`, `stateDir`, `worker.claudeExecutable`, and the worker's private `cwd`; set an installed model id and its finite `contextWindow`. The adapter is pinned to Claude Code 2.1.257. Missing values fail explicitly. The file is the only mutable plugin configuration surface and must not contain credentials.

The plugin registers one SessionStart Hook, one SessionEnd Hook, and one stdio MCP server. All commands use `dist/cc.cjs`; installation does not run a package manager.

Run operator commands from a trusted shell or Claude Code's `!` shell escape with the native session id:

```sh
node "$CLAUDE_PLUGIN_ROOT/dist/cc.cjs" cli \
  --config "$CLAUDE_PLUGIN_ROOT/cc.config.json" \
  --session <native-session-id> on
```

Replace `on` with `off`, `stop`, or `project <name>`. `on` changes enrollment only. `stop` reports the executor's abort acknowledgement separately from observed process termination. These commands are not a security boundary against model-initiated shell execution.
