Memory has three layers: Raw entries, facts and knowledge. The layers have different duties; they are not long, medium and short versions of the same content. The evidence chain is knowledge → fact → Raw entry.

### Raw entries

The original record of conversation and execution, for checking wording, evidence and detail. The system records Raw entries; the writer only cites them, never writes them.

- **`address`**: one whole entry, such as `T123#E2` (Turn 123, entry 2), optionally with `@user`, `@assistant` or `@observation` to check its role. Never cite a block inside an entry, or an entry holding only thinking.
- **`role`** (system-derived): `user` is a user message; `assistant` is the original agent's message or tool call; `observation` is a tool result and does not mean the returned content was independently verified.
