#!/usr/bin/env node
// Ticket 82: bundles the CC `/trace` menu preview (`cc-trace-menu-hooks-preview.tsx`, which imports the
// real shared model and CC renderer) into one self-contained module for the sandboxed Claude Code
// plugin directory. `jsx: "preserve"` leaves JSX tags untouched — the CC engine transpiles them itself
// at load time (step 0's probe used raw JSX with no import of React and no build step), so this script
// only needs to resolve local imports and strip TypeScript types, never transform JSX.
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const entry = resolve(root, "scripts/cc-trace-menu-hooks-preview.tsx");
const outfile = process.argv[2] ? resolve(process.argv[2]) : resolve("/tmp/cc82-samples/plugin/hooks/index.tsx");
const hooksDir = dirname(outfile);
mkdirSync(hooksDir, { recursive: true });

// Requirement 1: the classic SessionStart hook's injection script and the blocks it injects. These run
// as a plain OS subprocess (`node <file>`, see `hooks.json` below), not through the function-hooks
// module, so — unlike `index.tsx` — they need no esbuild bundling: Node runs a `.ts` file with a
// relative `.ts` import directly. Deployed verbatim, next to each other, so the import resolves.
copyFileSync(resolve(root, "scripts/cc-trace-menu-preview-memory-blocks.ts"), resolve(hooksDir, "cc-trace-menu-preview-memory-blocks.ts"));
copyFileSync(resolve(root, "scripts/cc-trace-menu-session-start-inject.ts"), resolve(hooksDir, "cc-trace-menu-session-start-inject.ts"));

// `modules` (function hooks, `claude plugin validate`'s schema allows both keys in one hooks.json) plus
// `hooks.SessionStart` (classic hooks): one command per block, not one command for all three
// concatenated — a live probe (ticket 82 delegation report) found a single SessionStart hook's
// `additionalContext` is silently truncated past ~10,000 characters, while three separate commands are
// each injected and counted in full.
const HOOKS_JSON = {
  modules: ["./index.tsx"],
  hooks: {
    SessionStart: [{
      hooks: ["knowledge", "facts", "raw"].map(which => ({
        type: "command",
        command: `node \${CLAUDE_PLUGIN_ROOT}/hooks/cc-trace-menu-session-start-inject.ts ${which}`,
      })),
    }],
  },
};
writeFileSync(resolve(hooksDir, "hooks.json"), `${JSON.stringify(HOOKS_JSON, null, 2)}\n`);

const result = await build({
  entryPoints: [entry],
  write: false,
  bundle: true,
  format: "esm",
  platform: "neutral",
  jsx: "preserve",
  loader: { ".tsx": "tsx" },
  legalComments: "none",
});
// `claude plugin validate` requires `register` to be an `export const`/`export function` declared
// directly, not re-exported through a trailing `export { register }` list — which is what esbuild's
// bundler always emits once it has resolved local imports. Both are the same module; only the
// declaration's surface spelling differs, so rewrite it rather than fighting the bundler for it.
const text = result.outputFiles[0].text
  .replace(/^var register = /m, "export const register = ")
  .replace(/\nexport \{\n  register\n\};\n$/, "\n");
writeFileSync(outfile, text);
console.log(`Wrote ${outfile}`);
