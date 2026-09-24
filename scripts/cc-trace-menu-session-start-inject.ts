#!/usr/bin/env node
// Ticket 82 requirement 1: the classic-hook side of the real injection. `hooks/hooks.json` runs this
// script three times, once per block ("knowledge" | "facts" | "raw"), as a SessionStart hook — a plain
// OS subprocess (`type: "command"`), not a function-hooks module, so it can `import` a sibling `.ts`
// file directly: Node >=22.6 strips types from a `.ts` file it runs or imports with no build step
// (verified live against this project's pinned Node, `node --version` >=24.6). Deployed verbatim next
// to `cc-trace-menu-preview-memory-blocks.ts` by `build-cc-trace-menu-preview.mjs`.
//
// One block per invocation, not all three concatenated: a live probe (ticket 82 delegation report)
// found Claude Code silently truncates a single SessionStart hook's `additionalContext` past ~10,000
// characters, while three separate hook commands are each injected and counted in full.
import { FACTS_BLOCK, KNOWLEDGE_BLOCK, RAW_BLOCK } from "./cc-trace-menu-preview-memory-blocks.ts";

const BLOCKS: Record<string, string> = { knowledge: KNOWLEDGE_BLOCK, facts: FACTS_BLOCK, raw: RAW_BLOCK };
const which = process.argv[2] ?? "";
const additionalContext = BLOCKS[which];
if (additionalContext === undefined) {
  process.stderr.write(`cc-trace-menu-session-start-inject: unknown block "${which}" (want knowledge|facts|raw)\n`);
  process.exit(1);
}
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } }));
