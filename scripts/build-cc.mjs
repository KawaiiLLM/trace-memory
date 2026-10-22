#!/usr/bin/env node
import { mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { brotliCompressSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const plugin = resolve(root, "plugin");
const output = resolve(plugin, "dist", "cc.cjs");
const temporary = `${output}.${process.pid}.${randomUUID()}.tmp`;
// Ticket 75: the status command is its own tiny bundle, built separately so it never carries `cc.cjs`'s
// SDK, Store or prompt weight — the whole point of a bundle entry that "never opens the database".
const statusOutput = resolve(plugin, "dist", "status.cjs");
const statusTemporary = `${statusOutput}.${process.pid}.${randomUUID()}.tmp`;
mkdirSync(dirname(output), { recursive: true });
export const promptLoader = {
  name: "trace-memory-prompts",
  setup(build) {
    // The bundle carries the composed prompts as constants, composed by the same `loadPrompt` the
    // runtime uses (Node strips the types), so the bundle needs no prompt files and cannot drift.
    build.onLoad({ filter: /src\/core\/prompts\/load\.ts$/ }, async () => {
      const { composePrompt } = await import(pathToFileURL(resolve(root, "src/core/prompts/load.ts")).href);
      const prompts = Object.fromEntries(["noting.md", "dreaming.md", "classifying.md"].map(file => [file, composePrompt(file)]));
      return { contents: `import { canonicalToolNames, renderToolNames, validateToolNames } from "./tool-names.ts";\nimport { DEFAULT_WRITING_LIMITS, renderLimits } from "./limits.ts";\nconst PROMPTS = ${JSON.stringify(prompts)};\nexport function loadPrompt(file, names = canonicalToolNames, limits = DEFAULT_WRITING_LIMITS) { const prompt = PROMPTS[file]; if (prompt === undefined) throw new Error("unknown prompt " + file); return renderLimits(renderToolNames(prompt, validateToolNames(names)), limits); }\n`, loader: "ts" };
    });
  },
};
// Ticket 136: `search`'s code sandbox runs on the QuickJS binary of the `quickjs-wasi` package. A bundle
// has no `node_modules` beside it, so the binary (Brotli-compressed, about a third of its size) rides
// inside the bundle and replaces the loader that reads it from the package.
export const quickjsLoader = {
  name: "trace-memory-quickjs",
  setup(build) {
    build.onLoad({ filter: /src\/core\/api\/quickjs-wasm\.ts$/ }, () => {
      const packed = brotliCompressSync(readFileSync(resolve(root, "node_modules/quickjs-wasi/quickjs.wasm"))).toString("base64");
      return { contents: `import { brotliDecompressSync } from "node:zlib";\nconst engine = globalThis.WebAssembly;\nlet compiled;\nexport function quickjsWasm() { return compiled ??= engine.compile(brotliDecompressSync(Buffer.from(${JSON.stringify(packed)}, "base64"))); }\n`, loader: "ts" };
    });
  },
};
// Ticket 136: the sandbox runs in a worker thread, and a bundle has no files beside it to start one from.
// The worker (code-worker.mjs with the QuickJS library) is bundled here to one script and rides inside the
// bundle as text, which the replaced `code-thread.ts` starts with `eval: true`.
export const codeWorkerLoader = {
  name: "trace-memory-code-worker",
  setup(plugin) {
    plugin.onLoad({ filter: /src\/core\/api\/code-thread\.ts$/ }, async () => {
      const worker = await build({ entryPoints: [resolve(root, "src/core/api/code-worker.mjs")], bundle: true, write: false,
        platform: "node", format: "cjs", target: "node24", minify: true, legalComments: "none" });
      return { contents: `import { Worker } from "node:worker_threads";\nconst SOURCE = ${JSON.stringify(worker.outputFiles[0].text)};\nexport function startCodeWorker(workerData, transferList) { return new Worker(SOURCE, { eval: true, workerData, transferList }); }\n`, loader: "ts" };
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
    plugins: [promptLoader, quickjsLoader, codeWorkerLoader],
    // jsonc-parser's default UMD entry loads its own modules through a runtime `require`, which the
    // bundle cannot follow; its ESM entry bundles whole.
    alias: { "jsonc-parser": "jsonc-parser/lib/esm/main.js" },
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

/** Ticket 75: a separate, deliberately plain bundle — no prompt loader, no Node-version banner, no
 * `import.meta.url` shim, none of which the status command needs — so it stays cheap to load. */
export async function buildCcStatus(buildImplementation = build) {
try {
  await buildImplementation({
    entryPoints: [resolve(root, "src/hosts/cc/status-bundle-entry.ts")],
    outfile: statusTemporary,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    sourcemap: false,
    legalComments: "none",
  });
  renameSync(statusTemporary, statusOutput);
  return statusOutput;
} catch (error) {
  rmSync(statusTemporary, { force: true });
  throw error;
}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(await buildCc());
  console.log(await buildCcStatus());
  await import("./build-cc-hooks.mjs");
}
