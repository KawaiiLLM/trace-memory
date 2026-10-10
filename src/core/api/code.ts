// Ticket 136: the `code` argument of `search`. A script runs as the body of an async function inside a
// QuickJS sandbox, over the search's hits. Borrowed from Pi's codemode (earendil-works/pi,
// packages/codemode, MIT): the engine, the lockdown of built-ins, the output helpers and the result
// layout. Not borrowed: tool calls, `store`, images and the worker thread. A script here only reads
// in-memory hits, so the VM runs in-process and its deadline is the engine's interrupt handler.
// ponytail: an engine call that never polls the interrupt handler would outlast the deadline; none of
// the runaway shapes tried (loops, regex backtracking, sort callbacks, async chains) does.
import { JSException, QuickJS, MAX_STACK_SIZE } from "quickjs-wasi";
import { tokens } from "../render/tokens.ts";
import { quickjsWasm } from "./quickjs-wasm.ts";

export const CODE_DEADLINE_MS = 10_000;
export const CODE_MEMORY_BYTES = 256 * 1024 * 1024;
export const CODE_OUTPUT_TOKENS = 10_000;
/** Pi's bounds on what one script may print, so a print loop cannot grow the host's memory. */
const MAX_OUTPUT_CHARS = 16 * 1024 * 1024, MAX_OUTPUT_ITEMS = 100_000;

/** What a script sees. `items` are plain JSON; a field named in an item's `lazy` list is read on first
 * access through `field`, so a hit's large body crosses into the VM only when the script asks. */
export interface CodeHost {
  items: readonly Record<string, unknown>[];
  field(index: number, name: string): unknown;
  render(index: number): string;
}
export interface CodeOutput { ok: boolean; items: { text: string; console?: true }[]; error?: string; wallMs: number }
export interface CodeLimits { deadlineMs?: number; memoryBytes?: number }

const PRELUDE = `(function (bridge, metaJson) {
  "use strict";
  // Freeze every object reachable from the built-in globals (and the intrinsics only reachable from
  // instances), so a script cannot patch what this prelude reports through. Commonly overridden
  // properties become accessors whose setter defines an own property, as freezing alone would make
  // \`this.name = ...\` in an Error subclass throw (the "override mistake").
  (function lockdown() {
    const OVERRIDABLE = new Set(["constructor", "name", "message", "toString", "toLocaleString", "valueOf", "toJSON"]);
    const seen = new Set([globalThis]);
    const queue = [];
    const add = (value) => {
      if ((typeof value === "object" && value !== null) || typeof value === "function") {
        if (!seen.has(value)) { seen.add(value); queue.push(value); }
      }
    };
    function allowOverride(object, key, value, enumerable) {
      const { get, set } = Object.getOwnPropertyDescriptor({
        get accessor() { return value; },
        set accessor(next) {
          if (this === object) throw new TypeError("Cannot assign to read only property '" + String(key) + "' of a built-in");
          if ((typeof this !== "object" || this === null) && typeof this !== "function") return;
          Object.defineProperty(this, key, { value: next, writable: true, enumerable: true, configurable: true });
        },
      }, "accessor");
      Object.defineProperty(object, key, { get, set, enumerable, configurable: false });
      add(get); add(set);
    }
    for (const key of Reflect.ownKeys(globalThis)) {
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
      add(descriptor.value); add(descriptor.get); add(descriptor.set);
      if ("value" in descriptor && descriptor.configurable) Object.defineProperty(globalThis, key, { writable: false, configurable: false });
    }
    add(Object.getPrototypeOf(function* () {}));
    add(Object.getPrototypeOf(async function () {}));
    add(Object.getPrototypeOf(async function* () {}));
    add(Object.getPrototypeOf(Int8Array));
    add(Object.getPrototypeOf([][Symbol.iterator]()));
    add(Object.getPrototypeOf(new Map()[Symbol.iterator]()));
    add(Object.getPrototypeOf(new Set()[Symbol.iterator]()));
    add(Object.getPrototypeOf(""[Symbol.iterator]()));
    add(Object.getPrototypeOf(/a/[Symbol.matchAll]("")));
    while (queue.length > 0) {
      const object = queue.pop();
      add(Object.getPrototypeOf(object));
      const descriptors = Object.getOwnPropertyDescriptors(object);
      for (const key of Reflect.ownKeys(descriptors)) {
        const descriptor = descriptors[key];
        if ("value" in descriptor) {
          add(descriptor.value);
          if (descriptor.writable && descriptor.configurable && (object === Object.prototype || OVERRIDABLE.has(key)))
            allowOverride(object, key, descriptor.value, descriptor.enumerable);
        } else { add(descriptor.get); add(descriptor.set); }
      }
      Object.freeze(object);
    }
  })();
  const stringify = JSON.stringify, parse = JSON.parse, promiseThen = Promise.prototype.then;
  const ErrorCtor = Error, TypeErrorCtor = TypeError;
  const EXIT = Object.freeze({});
  let finished = false;
  function done(ok, payload) { if (finished) return; finished = true; bridge("done", ok, payload); }
  function errorText(error) {
    const head = error.message ? error.name + ": " + error.message : String(error.name);
    const frames = typeof error.stack === "string" ? error.stack.split("\\n").filter((line) => line.trim() && !line.includes("search-prelude.js")) : [];
    return [head, ...frames].join("\\n");
  }
  function format(value) {
    if (typeof value === "string") return value;
    if (value instanceof ErrorCtor) return errorText(value);
    try { const json = stringify(value); return json === undefined ? String(value) : json; } catch { return String(value); }
  }
  function describeError(error) {
    try {
      return error instanceof ErrorCtor ? errorText(error) : String(format(error));
    } catch { return "The script threw a value that cannot be described"; }
  }

  const meta = parse(metaJson);
  const index = new Map();
  const hits = meta.map((item, i) => {
    const lazy = item.lazy || [];
    delete item.lazy;
    for (const name of lazy) {
      let loaded = false, value;
      Object.defineProperty(item, name, { enumerable: true, get() {
        if (!loaded) { value = parse(bridge("field", i, name)); loaded = true; }
        return value;
      } });
    }
    index.set(item, i);
    return Object.freeze(item);
  });
  Object.freeze(hits);
  function render(item) {
    const i = index.get(item);
    if (i === undefined) throw new TypeErrorCtor("render expects one of the items in hits");
    return bridge("render", i);
  }
  function text(value) {
    let rendered;
    try {
      rendered = value === undefined || value === null || (typeof value !== "object" && typeof value !== "function") ? String(value)
        : (stringify(value) ?? String(value));
    } catch (error) { throw new TypeErrorCtor(error instanceof ErrorCtor ? error.message : String(error)); }
    bridge("output", "text", rendered);
  }
  function exit() { done(true, undefined); throw EXIT; }
  const console = {};
  for (const level of ["log", "info", "warn", "error", "debug"]) console[level] = (...args) => { bridge("output", "console", args.map(format).join(" ")); };
  Object.freeze(console);
  for (const [name, value] of [["hits", hits], ["render", render], ["text", text], ["exit", exit], ["console", console]])
    Object.defineProperty(globalThis, name, { value, enumerable: true });

  return {
    run(fn) {
      let promise;
      try { promise = fn(); } catch (error) { done(false, describeError(error)); return; }
      promiseThen.call(promise, (value) => {
        let json;
        try { json = value === undefined ? undefined : typeof value === "string" ? value : (stringify(value) ?? String(value)); }
        catch (error) { done(false, describeError(error)); return; }
        done(true, json);
      }, (error) => { done(false, describeError(error)); });
    },
  };
})`;

/** Silence the engine's own stdout/stderr: it belongs to the host application. */
function discardOutput(memory: { readonly buffer: ArrayBufferLike }) {
  return { fd_write(_fd: number, iovsPtr: number, iovsLen: number, nwrittenPtr: number): number {
    const view = new DataView(memory.buffer);
    let written = 0;
    for (let i = 0; i < iovsLen; i++) written += view.getUint32(iovsPtr + i * 8 + 4, true);
    view.setUint32(nwrittenPtr, written, true);
    return 0;
  } };
}

/** Run `source` over `host`'s items. Never rejects for a script's failure: that is `ok: false`. */
export async function runCode(source: string, host: CodeHost, limits: CodeLimits = {}): Promise<CodeOutput> {
  const started = performance.now();
  const deadlineMs = limits.deadlineMs ?? CODE_DEADLINE_MS;
  const items: CodeOutput["items"] = [];
  let chars = 0, finished: { ok: boolean; payload: string | undefined } | undefined, overflow: string | undefined;
  const wall = () => performance.now() - started;
  const fail = (error: string): CodeOutput => ({ ok: false, items, error, wallMs: wall() });
  const deadline = started + deadlineMs;
  let vm: QuickJS | undefined;
  try {
    vm = await QuickJS.create({ wasm: await quickjsWasm(), memoryLimit: limits.memoryBytes ?? CODE_MEMORY_BYTES,
      // Deep recursion must reach the engine's own guard (a catchable RangeError) before it overflows the host's
      // stack, which Pi's maximum (512 KiB) does not under Node's default stack; half of it does.
      maxStackSize: MAX_STACK_SIZE / 2, interruptHandler: () => performance.now() > deadline, wasi: discardOutput });
    const machine = vm;
    const bridge = machine.newFunction("bridge", (kind, a, b) => {
      switch (kind.toString()) {
        case "field": return machine.newString(JSON.stringify(host.field(a.toNumber(), b.toString()) ?? null));
        case "render": return machine.newString(host.render(a.toNumber()));
        case "output": {
          const value = b.toString();
          chars += value.length;
          if (chars > MAX_OUTPUT_CHARS || items.length >= MAX_OUTPUT_ITEMS) {
            overflow = `script output exceeded ${MAX_OUTPUT_CHARS} characters or ${MAX_OUTPUT_ITEMS} text() and console calls; print a summary instead`;
            throw new Error(overflow);
          }
          items.push(a.toString() === "console" ? { text: value, console: true } : { text: value });
          return machine.undefined;
        }
        case "done":
          finished = { ok: a.toBoolean(), payload: b === undefined || b.isUndefined ? undefined : b.toString() };
          return machine.undefined;
      }
      return machine.undefined;
    });
    const meta = JSON.stringify(host.items);
    const api = machine.callFunction(machine.evalCode(PRELUDE, "search-prelude.js"), machine.undefined, bridge, machine.newString(meta));
    // The prefix shares its line with the script, so reported line numbers match the script as written.
    const fn = machine.evalCode(`(async () => {${source}\n})`, "search-code.js");
    machine.callFunction(api.getProp("run"), api, fn);
    machine.executePendingJobs();
    const result = finished as { ok: boolean; payload: string | undefined } | undefined;
    if (wall() > deadlineMs) return fail(`Script timed out after ${deadlineMs / 1000} seconds`);
    if (!result) return fail("The script is waiting on a promise that can never settle: nothing else can run here, and timers do not exist.");
    if (result.ok && result.payload !== undefined) items.push({ text: result.payload });
    if (overflow) return fail(overflow);
    return result.ok ? { ok: true, items, wallMs: wall() } : fail(result.payload ?? "Error");
  } catch (error) {
    if (wall() > deadlineMs) return fail(`Script timed out after ${deadlineMs / 1000} seconds`);
    return fail(error instanceof JSException ? `${error.name}: ${error.message}` : `Script sandbox failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    vm?.dispose();
  }
}

/** Keep the start and end of an over-long output; the full text goes to `spill`'s file when the host has one. */
export function capOutput(text: string, spill?: (text: string) => string, maxTokens = CODE_OUTPUT_TOKENS): string {
  const total = tokens(text);
  if (total <= maxTokens) return text;
  let keep = Math.floor(text.length * maxTokens / total * 0.95), kept = "";
  // The estimate is not linear in length; shrink until the kept text fits.
  for (let attempt = 0; attempt < 8; attempt++, keep = Math.floor(keep * 0.85)) {
    const head = text.slice(0, Math.ceil(keep / 2)), tail = text.slice(text.length - Math.floor(keep / 2));
    kept = `${head}…${Math.max(0, total - tokens(head) - tokens(tail))} tokens truncated…${tail}`;
    if (tokens(kept) <= maxTokens) break;
  }
  let saved: string;
  try { saved = spill ? `[Full output: ${spill(text)}]` : "[The full output is not saved; filter or summarize in code]"; }
  catch (error) { saved = `[Could not save the full output: ${error instanceof Error ? error.message : String(error)}]`; }
  return `Warning: truncated output (original token count: ${total})\n\n${kept}\n\n${saved}`;
}

/** Pi's result layout: the verdict and wall time, then text items (numbered when several), then the
 * console lines in one block, then the error for a failed script. */
export function formatCodeResult(output: CodeOutput, spill?: (text: string) => string): string {
  const texts = output.items.filter(item => !item.console), lines = output.items.filter(item => item.console).map(item => item.text);
  const parts = texts.map((item, index) => texts.length > 1 ? `==> text ${index + 1}/${texts.length} <==\n${item.text}` : item.text);
  if (lines.length) parts.push(`<console_output>\n${lines.join("\n")}\n</console_output>`);
  if (!output.ok) parts.push(`Script error:\n${output.error}`);
  const body = capOutput(parts.join("\n"), spill);
  return `${output.ok ? "Script completed" : "Script failed"}\nWall time ${(output.wallMs / 1000).toFixed(1)} seconds\nOutput:\n${body}`;
}
