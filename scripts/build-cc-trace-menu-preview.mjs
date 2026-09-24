#!/usr/bin/env node
// Ticket 82: bundles the CC `/trace` menu preview (`cc-trace-menu-hooks-preview.tsx`, which imports the
// real shared model and CC renderer) into one self-contained module for the sandboxed Claude Code
// plugin directory. `jsx: "preserve"` leaves JSX tags untouched — the CC engine transpiles them itself
// at load time (step 0's probe used raw JSX with no import of React and no build step), so this script
// only needs to resolve local imports and strip TypeScript types, never transform JSX.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const entry = resolve(root, "scripts/cc-trace-menu-hooks-preview.tsx");
const outfile = process.argv[2] ? resolve(process.argv[2]) : resolve("/tmp/cc82-samples/plugin/hooks/index.tsx");
mkdirSync(dirname(outfile), { recursive: true });

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
