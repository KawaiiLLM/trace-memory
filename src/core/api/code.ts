// Ticket 136: the `code` argument of `search`. A script runs as the body of an async function inside a
// QuickJS sandbox, over the search's hits. Borrowed from Pi's codemode (earendil-works/pi,
// packages/codemode, MIT): the engine, the worker thread, the lockdown of built-ins, the output helpers and
// the result layout. Not borrowed: tool calls, `store` and images.
//
// The sandbox runs in a worker thread (code-worker.mjs), so a script that spins never blocks the host's
// event loop. The hits cross by message: the metadata of every hit goes in up front as JSON, and a hit's
// large fields (a Raw entry's text) stay on the host until the script reads them; the worker then asks and
// waits for the answer. At the deadline the host raises the engine's interrupt flag and terminates the worker.
import { MessageChannel } from "node:worker_threads";
import { tokens } from "../render/tokens.ts";
import { startCodeWorker } from "./code-thread.ts";
import { quickjsWasm } from "./quickjs-wasm.ts";

export const CODE_DEADLINE_MS = 10_000;
export const CODE_MEMORY_BYTES = 256 * 1024 * 1024;
export const CODE_OUTPUT_TOKENS = 10_000;

/** What a script sees. `items` are plain JSON; a field named in an item's `lazy` list is read on first
 * access through `field`, so a hit's large body crosses into the VM only when the script asks. */
export interface CodeHost {
  items: readonly Record<string, unknown>[];
  field(index: number, name: string): unknown;
  render(index: number): string;
}
export interface CodeOutput { ok: boolean; items: { text: string; console?: true }[]; error?: string; wallMs: number }
export interface CodeLimits { deadlineMs?: number; memoryBytes?: number }

/** Run `source` over `host`'s items. Never rejects for a script's failure: that is `ok: false`. */
export async function runCode(source: string, host: CodeHost, limits: CodeLimits = {}): Promise<CodeOutput> {
  const started = performance.now(), deadlineMs = limits.deadlineMs ?? CODE_DEADLINE_MS;
  const items: CodeOutput["items"] = [];
  const wall = () => performance.now() - started;
  const fail = (error: string): CodeOutput => ({ ok: false, items, error, wallMs: wall() });
  let wasm: object;
  try { wasm = await quickjsWasm(); } catch (error) { return fail(`Script sandbox failed: ${error instanceof Error ? error.message : String(error)}`); }
  return new Promise<CodeOutput>(resolve => {
    const interrupt = new Int32Array(new SharedArrayBuffer(4)), sync = new Int32Array(new SharedArrayBuffer(4));
    const { port1: replies, port2: replyPort } = new MessageChannel();
    let settled = false, timer: NodeJS.Timeout | undefined;
    let worker: ReturnType<typeof startCodeWorker>;
    try {
      worker = startCodeWorker({ source, meta: JSON.stringify(host.items), wasm, memoryBytes: limits.memoryBytes ?? CODE_MEMORY_BYTES,
        deadlineAt: Date.now() + deadlineMs - wall(), deadlineMs, interrupt: interrupt.buffer, sync: sync.buffer, replyPort }, [replyPort]);
    } catch (error) {
      replies.close();
      resolve(fail(`Script sandbox failed: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    const finish = (output: CodeOutput) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      Atomics.store(interrupt, 0, 1); // the engine stops at its next poll; terminate() covers a worker that does not
      replies.close();
      void worker.terminate().catch(() => undefined).then(() => resolve(output));
    };
    timer = setTimeout(() => finish(fail(`Script timed out after ${deadlineMs / 1000} seconds`)), Math.max(0, deadlineMs - wall()));
    worker.on("message", (message: { type: string; [key: string]: unknown }) => {
      if (settled) return;
      if (message.type === "output") items.push(message.console ? { text: message.text as string, console: true } : { text: message.text as string });
      else if (message.type === "ask") {
        let reply: { ok: boolean; payload: string };
        try {
          reply = { ok: true, payload: message.kind === "field" ? JSON.stringify(host.field(message.index as number, message.name as string) ?? null) : host.render(message.index as number) };
        } catch (error) { reply = { ok: false, payload: error instanceof Error ? error.message : String(error) }; }
        replies.postMessage(reply);
        Atomics.store(sync, 0, 1);
        Atomics.notify(sync, 0);
      } else if (message.type === "done") {
        if (message.ok && message.payload !== undefined) items.push({ text: message.payload as string });
        finish(message.ok ? { ok: true, items, wallMs: wall() } : fail(message.error as string));
      }
    });
    worker.on("error", error => finish(fail(`Script sandbox failed: ${error.message}`)));
    worker.on("exit", code => finish(fail(`Script sandbox failed: the worker exited with code ${code} before the script settled`)));
  });
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
