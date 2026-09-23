#!/usr/bin/env node
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { Store } from "../src/core/store/index.ts";

const input = process.argv[2];
if (!input || process.argv.length !== 3) {
  console.error("usage: npm run upgrade:paths -- <explicit-database-path>");
  process.exit(2);
}
const path = resolve(input);
if (!statSync(path).isFile()) throw new Error(`Upgrade target is not a file: ${path}`);
const start = performance.now();
Store.upgradeSourcePaths(path);
console.info(`Source path upgrade committed in ${(performance.now() - start).toFixed(1)} ms: ${path}`);
