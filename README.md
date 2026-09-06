# Trace Memory

Traceable two-layer memory for coding agents. Facts are noted from the conversation, settled into durable entries, and every entry traces back through its facts to the source turn.

- `core/` — host-agnostic core: model, store, note, settle, render, prompts.
- `hosts/pi/` — Pi extension (first target). `hosts/cc/` — Claude Code plugin (adapter pending verification).

The design document is maintained outside this repository. The simulation harness and regression suite used to test the design live outside as well.

Status: design settled, implementation not started. `trace-memory@0.0.1` on npm is a placeholder.
