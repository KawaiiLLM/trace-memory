// Ticket 136: the worker thread of the `search` code sandbox (code.ts is the host side). One worker runs one
// script in a fresh QuickJS VM and is killed by the host when the script settles or its deadline passes, so a
// spinning script never blocks the host's event loop. The thread layout follows Pi's codemode
// (earendil-works/pi, packages/codemode/src/runtime/worker.ts); the engine, lockdown and output helpers are
// Pi's too. Not Pi's: the hits are read synchronously by the script (`hits[0].text`), so the worker asks the
// host and blocks on Atomics.wait for the answer, which the host's event loop is free to send.
//
// Plain JavaScript on purpose: a package installed under node_modules cannot load TypeScript natively, and
// the Claude Code bundle embeds this file's built text (scripts/build-cc.mjs).
//
// Messages to the host: {type: "output", console: boolean, text} | {type: "ask", kind: "field" | "render",
// index, name?} (then wait; a "field" answer is {index: value} for the asked hit and its chunk) | {type: "done", ok: true, payload?} | {type: "done", ok: false, error}.
// The host answers an ask on `replyPort` with {ok, payload}, then sets sync[0] to 1 and notifies it.
import { parentPort, receiveMessageOnPort, workerData } from "node:worker_threads";
import { JSException, MAX_STACK_SIZE, QuickJS } from "quickjs-wasi";

/** Pi's bounds on what one script may print, so a print loop cannot grow the host's memory. */
const MAX_OUTPUT_CHARS = 16 * 1024 * 1024, MAX_OUTPUT_ITEMS = 100_000;
/** How long a field read waits for the host before the worker gives up. */
const ASK_TIMEOUT_MS = 30_000;

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
  // Field values the host has sent, by field name then hit index. One reply covers a whole chunk of hits.
  const known = new Map();
  function field(i, name) {
    let values = known.get(name);
    if (!values) known.set(name, values = new Map());
    if (!values.has(i)) { const batch = parse(bridge("field", i, name)); for (const key in batch) values.set(Number(key), batch[key]); if (!values.has(i)) values.set(i, undefined); }
    return values.get(i);
  }
  const hits = meta.map((item, i) => {
    const lazy = item.lazy || [];
    delete item.lazy;
    for (const name of lazy) Object.defineProperty(item, name, { enumerable: true, get() { return field(i, name); } });
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
function discardOutput(memory) {
  return { fd_write(_fd, iovsPtr, iovsLen, nwrittenPtr) {
    const view = new DataView(memory.buffer);
    let written = 0;
    for (let i = 0; i < iovsLen; i++) written += view.getUint32(iovsPtr + i * 8 + 4, true);
    view.setUint32(nwrittenPtr, written, true);
    return 0;
  } };
}

/**
 * @param {{ source: string, meta: string, wasm: object, memoryBytes: number, deadlineAt: number, deadlineMs: number,
 *   interrupt: SharedArrayBuffer, sync: SharedArrayBuffer, replyPort: import("node:worker_threads").MessagePort }} data
 */
async function main(data) {
  const interrupt = new Int32Array(data.interrupt), sync = new Int32Array(data.sync);
  const post = (message) => parentPort.postMessage(message);
  const timedOut = () => Atomics.load(interrupt, 0) !== 0 || Date.now() > data.deadlineAt;
  let chars = 0, items = 0, finished, overflow;
  /** A synchronous question to the host: the answer is a string, or an error thrown into the script. */
  function ask(message) {
    Atomics.store(sync, 0, 0);
    post({ type: "ask", ...message });
    if (Atomics.wait(sync, 0, 0, ASK_TIMEOUT_MS) === "timed-out") throw new Error("the host did not answer");
    const reply = receiveMessageOnPort(data.replyPort)?.message;
    if (!reply) throw new Error("the host sent no answer");
    if (!reply.ok) throw new Error(reply.payload);
    return reply.payload;
  }
  try {
    const vm = await QuickJS.create({ wasm: data.wasm, memoryLimit: data.memoryBytes,
      // Without a guard, deep recursion overflows the wasm stack and traps instead of throwing a catchable RangeError.
      maxStackSize: MAX_STACK_SIZE, interruptHandler: timedOut, wasi: discardOutput });
    const bridge = vm.newFunction("bridge", (kind, a, b) => {
      switch (kind.toString()) {
        case "field": return vm.newString(ask({ kind: "field", index: a.toNumber(), name: b.toString() }));
        case "render": return vm.newString(ask({ kind: "render", index: a.toNumber() }));
        case "output": {
          const text = b.toString();
          chars += text.length;
          if (chars > MAX_OUTPUT_CHARS || items >= MAX_OUTPUT_ITEMS) {
            overflow = `script output exceeded ${MAX_OUTPUT_CHARS} characters or ${MAX_OUTPUT_ITEMS} text() and console calls; print a summary instead`;
            throw new Error(overflow);
          }
          items++;
          post({ type: "output", console: a.toString() === "console", text });
          return vm.undefined;
        }
        case "done":
          finished = { ok: a.toBoolean(), payload: b === undefined || b.isUndefined ? undefined : b.toString() };
          return vm.undefined;
      }
      return vm.undefined;
    });
    const api = vm.callFunction(vm.evalCode(PRELUDE, "search-prelude.js"), vm.undefined, bridge, vm.newString(data.meta));
    // The prefix shares its line with the script, so reported line numbers match the script as written.
    const fn = vm.evalCode(`(async () => {${data.source}\n})`, "search-code.js");
    vm.callFunction(api.getProp("run"), api, fn);
    vm.executePendingJobs();
    if (timedOut()) throw new Error("timed out");
    if (!finished) post({ type: "done", ok: false, error: "The script is waiting on a promise that can never settle: nothing else can run here, and timers do not exist." });
    else if (overflow) post({ type: "done", ok: false, error: overflow });
    else post({ type: "done", ok: finished.ok, ...(finished.ok ? { payload: finished.payload } : { error: finished.payload ?? "Error" }) });
  } catch (error) {
    post({ type: "done", ok: false, error: timedOut() ? `Script timed out after ${data.deadlineMs / 1000} seconds`
      : error instanceof JSException ? `${error.name}: ${error.message}` : `Script sandbox failed: ${error instanceof Error ? error.message : String(error)}` });
  }
}

if (parentPort) main(workerData);
