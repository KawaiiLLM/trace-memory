#!/usr/bin/env node
// Function hooks run without Node module resolution; bundle only the pure view and dispatch code.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const entry = resolve(root, "plugin/hooks/index.tsx");
const outfile = resolve(root, "plugin/hooks/menu.tsx");
mkdirSync(resolve(root, "plugin/hooks"), { recursive: true });
const result = await build({ entryPoints: [entry], write: false, bundle: true, format: "esm", platform: "neutral", jsx: "preserve", legalComments: "none" });
const bundled = result.outputFiles[0].text
  .replace(/^var register = /m, "export const register = ")
  .replace(/\nexport \{\n  register\n\};\n$/, "\n");
if (!bundled.includes("export const register = ")) throw new Error("bundled function hook has no direct register declaration");
writeFileSync(outfile, bundled);
const manifest = JSON.parse(readFileSync(resolve(root, "plugin/hooks/hooks.json"), "utf8"));
if (JSON.stringify(manifest.modules) !== JSON.stringify(["./menu.tsx"])) throw new Error("hooks manifest must load the bundled module");
console.log(outfile);
