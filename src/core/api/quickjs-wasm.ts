import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

/** The compiled QuickJS engine, loaded once. The Claude Code bundle replaces this module with one that
 * embeds the binary (scripts/build-cc.mjs), because a bundle has no `node_modules` beside it. */
// The Node types do not declare the WebAssembly global (it lives in the DOM lib).
const { WebAssembly: engine } = globalThis as unknown as { WebAssembly: { compile(bytes: Uint8Array): Promise<object> } };
let compiled: Promise<object> | undefined;
export function quickjsWasm(): Promise<object> {
  compiled ??= readFile(createRequire(import.meta.url).resolve("quickjs-wasi/quickjs.wasm"))
    .then(bytes => engine.compile(bytes))
    .catch(error => { compiled = undefined; throw error; });
  return compiled;
}
