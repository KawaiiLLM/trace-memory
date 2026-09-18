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
    build.onLoad({ filter: /src\/core\/(noting|consolidation|dreaming)\/index\.ts$/ }, ({ path }) => {
      const phase = /\/(noting|consolidation|dreaming)\/index\.ts$/.exec(path)?.[1];
      if (!phase) throw new Error(`Cannot identify prompt owner ${path}`);
      const source = readFileSync(path, "utf8");
      const expression = `readFileSync(new URL("../prompts/${phase}.md", import.meta.url), "utf8")`;
      if (!source.includes(expression)) throw new Error(`Prompt load expression changed in ${path}`);
      return { contents: source.replace(expression, JSON.stringify(readFileSync(resolve(root, `src/core/prompts/${phase}.md`), "utf8"))), loader: "ts" };
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
