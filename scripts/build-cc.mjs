#!/usr/bin/env node
import { mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const plugin = resolve(root, "plugin");
const output = resolve(plugin, "dist", "cc.cjs");
const temporary = `${output}.${process.pid}.${randomUUID()}.tmp`;
mkdirSync(dirname(output), { recursive: true });
const promptLoader = {
  name: "trace-memory-prompts",
  setup(build) {
    // The bundle carries the composed prompts as constants, composed by the same `loadPrompt` the
    // runtime uses (Node strips the types), so the bundle needs no prompt files and cannot drift.
    build.onLoad({ filter: /src\/core\/prompts\/load\.ts$/ }, async () => {
      const { loadPrompt } = await import(pathToFileURL(resolve(root, "src/core/prompts/load.ts")).href);
      const prompts = Object.fromEntries(["noting.md", "consolidation.md", "dreaming.md"].map(file => [file, loadPrompt(file)]));
      return { contents: `const PROMPTS = ${JSON.stringify(prompts)};\nexport function loadPrompt(file) { const prompt = PROMPTS[file]; if (prompt === undefined) throw new Error("unknown prompt " + file); return prompt; }\n`, loader: "ts" };
    });
  },
};
const runtimeBoundary = `
const [__ccMajor, __ccMinor] = process.versions.node.split(".").map(Number);
if (__ccMajor < 24 || (__ccMajor === 24 && __ccMinor < 6)) {
  console.error("Trace Memory CC requires Node >=24.6.0; found " + process.versions.node);
  process.exit(1);
}
const __ccImportMetaUrl = require("node:url").pathToFileURL(__filename).href;`;
export async function buildCc(buildImplementation = build) {
try {
  await buildImplementation({
    entryPoints: [resolve(root, "src/hosts/cc/bundle-entry.ts")],
    outfile: temporary,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    sourcemap: false,
    legalComments: "none",
    plugins: [promptLoader],
    banner: { js: runtimeBoundary },
    define: { "import.meta.url": "__ccImportMetaUrl" },
  });
  renameSync(temporary, output);
  return output;
} catch (error) {
  rmSync(temporary, { force: true });
  throw error;
}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(await buildCc());
