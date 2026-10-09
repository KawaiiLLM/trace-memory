import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { call, piSession, say, submitted, usage } from "./native-fixture.ts";
import extension from "../../../src/hosts/pi/index.ts";

// Ticket 28 amendment 4: "Pi checks automatic compaction after `agent_end`, before prompt submission
// and between tool rounds … tests cover all three triggers, not only `agent_end`." These cases run
// the REAL extension inside a real Pi `AgentSession` (only the wire is stubbed) and drive each of the
// three code paths that reach `_runAutoCompaction`, so each one really enters this host's
// `session_before_compact` — 133 R1: one allocation, no Noter recovery — and Pi really persists its result.
//
//   agent-session.js:1634 `_checkCompaction`      after `agent_end` (the post-run loop)
//   agent-session.js:891  `_checkCompaction(…, false)` before prompt submission
//   agent-session.js:274  `_compactBeforeNextAssistantResponse` between tool rounds
// All three land in `_runAutoCompaction` (:1740), whose hook call (:1750) carries the automatic
// abort controller's `signal` and honours `{cancel: true}` (:1770).

const big = "word ".repeat(4_000);
const worker = (body: unknown) => /# (?:Noting|Dreamer)/u.test(JSON.stringify(body));
const traceMemory = (dir: string, rawTokens = 10_000) => ({
  dbPath: join(dir, "trace.db"),
  "noting.triggerTokens": 1_000_000_000, "consolidation.triggerTokens": 1_000_000_000,
  "compaction.factsTokens": 10_000, "compaction.rawTokens": rawTokens,
});
const session = async (options: { tools?: Parameters<typeof piSession>[0]["tools"]; contextWindow?: number; keepRecentTokens?: number; automatic?: boolean; rawTokens?: number;
  memoryConfig?: Record<string, unknown> } = {}) => {
  const store = mkdtempSync(join(tmpdir(), "trace-memory-triggers-"));
  const notices: string[] = [];
  const observe = (context: any) => ({ ...context, ui: { ...context.ui, notify: (message: string) => notices.push(message) } });
  const factory = (pi: any) => extension({ ...pi,
    on: (name: string, handler: any) => pi.on(name, (event: any, context: any) => handler(event, observe(context))),
    registerCommand: (name: string, command: any) => pi.registerCommand(name, { ...command,
      handler: (args: string, context: any) => command.handler(args, observe(context)) }),
  });
  const f = await piSession({ extensions: [factory], contextWindow: options.contextWindow ?? 200_000,
    // The threshold is `contextWindow - reserveTokens` (compaction.js:163), so a large reserve makes a
    // tiny session compact while the model still declares a window a memory worker can be admitted on
    // (27a's 10,000-token headroom).
    compaction: { enabled: options.automatic ?? true, keepRecentTokens: options.keepRecentTokens ?? 1, reserveTokens: 199_900 }, ...(options.tools ? { tools: options.tools } : {}),
    env: { TRACE_MEMORY_CONFIG: JSON.stringify({ ...traceMemory(store, options.rawTokens), ...options.memoryConfig }) },
    // A session created after this host's enrollment baseline is enrolled by default (18a), which is
    // what a fresh real session is; the baseline of a fresh agent directory would otherwise be `now`.
    prepare: ({ agentDir }) => writeFileSync(join(agentDir, "trace-memory-baseline.json"), JSON.stringify("2000-01-01T00:00:00.000Z")) });
  const dispose = f.dispose;
  return { ...f, store, notices, dispose: () => { try { dispose(); } finally { rmSync(store, { recursive: true, force: true }); } } };
};

/** The compaction entries this session persisted, and the memory carrier each one holds (29a). */
const compactions = (f: Awaited<ReturnType<typeof session>>) =>
  f.manager.getEntries().filter(e => e.type === "compaction") as { summary: string; details?: { traceMemory?: unknown } }[];

const noted = (_body: Record<string, any>) =>
  call("archive-1", "memory", { op: "archive", kind: "budget", id: "K1@1", supports: [], reason: "Deliberate budget retirement" });
const scripted = (f: Awaited<ReturnType<typeof session>>, replies: ((signal?: AbortSignal) => Response | Promise<Response>)[]) => {
  let round = 0;
  f.script((body, signal) => {
    if (worker(body)) return submitted(body) ? say("Done.") : noted(body);
    return (replies[round++] ?? (() => say("later answer", usage(10, 2))))(signal);
  });
};

test("28 amendment 4: the trigger after agent_end reaches compact, and Pi persists what it returns", async () => {
  const f = await session();
  try {
    scripted(f, [() => say("answered", usage(2_950, 2))]); // usage over the threshold: the post-run check compacts
    await f.session.prompt(`${big} FIRST`);
    expect(f.sent.some(body => JSON.stringify(body).includes("# Dreamer"))).toBe(false);
    expect(compactions(f)).toHaveLength(1);
    expect(compactions(f)[0]!.details?.traceMemory).toBeTruthy(); // a custom replacement, not Pi's own summary
    await completedStatus(f);
  } finally { f.dispose(); }
});

test("28 amendment 4: the trigger before prompt submission reaches compact", async () => {
  const f = await session();
  try {
    // One ordinary turn under the threshold — it is what allocates the memory session and leaves the
    // pending Raw — and then a turn the user aborts. Pi records the aborted reply with no usage, so
    // the check after `agent_end` skips it (agent-session.js:1641) and the one before the next
    // prompt, which does not skip aborted messages, is the trigger that compacts.
    let round = 0;
    f.script((body, signal) => {
      if (worker(body)) return submitted(body) ? say("Done.") : noted(body);
      if (++round === 2) return new Promise<Response>((_resolve, reject) => // the turn the user aborts
        signal!.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true }));
      return say("answered", usage(10, 2));
    });
    await f.session.prompt("FIRST");
    expect(compactions(f)).toHaveLength(0); // under the threshold: nothing compacted yet
    const aborted = f.session.prompt(`${big} SECOND`).catch(() => {});
    await vi.waitFor(() => expect(f.sent.length).toBe(2));
    await f.session.abort();
    await aborted;
    expect(compactions(f)).toHaveLength(0); // and the aborted reply is skipped after `agent_end`
    const before = f.sent.length;
    await f.session.prompt("THIRD");
    expect(f.sent.slice(before).some(body => JSON.stringify(body).includes("# Dreamer"))).toBe(false);
    expect(compactions(f)).toHaveLength(1);
    expect(compactions(f)[0]!.details?.traceMemory).toBeTruthy();
    await completedStatus(f);
  } finally { f.dispose(); }
});

test("28 amendment 4: the trigger between tool rounds reaches compact", async () => {
  // `keepRecentTokens` leaves the tool round itself in the kept tail, so the cut point of the
  // compaction Pi prepares between the rounds falls on the first turn rather than past the last entry.
  const f = await session({ keepRecentTokens: 100, tools: [{ name: "read", description: "Read a file",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }) }] });
  try {
    // The between-rounds check prices the context by the last reported usage, so the tool call of the
    // second turn reports a context over the threshold: the compaction happens while the round after
    // the tool result is prepared, before that round's own request is built.
    scripted(f, [() => say("answered", usage(10, 2)), () => call("read-1", "read", { path: "a.txt" }, usage(2_950, 2))]);
    await f.session.prompt("FIRST");
    expect(compactions(f)).toHaveLength(0); // under the threshold: nothing compacted yet
    await f.session.prompt(`${big} SECOND`);
    // The compaction happened while preparing the round after the tool result, not after `agent_end`.
    expect(compactions(f)).toHaveLength(1);
    expect(compactions(f)[0]!.details?.traceMemory).toBeTruthy();
    await completedStatus(f);
    expect(f.sent.some(body => JSON.stringify(body).includes("# Dreamer"))).toBe(false);
  } finally { f.dispose(); }
});

test("64c: manual compact carries current knowledge without making pending knowledge required", async () => {
  const f = await session({ automatic: false });
  try {
    scripted(f, [() => say("answered", usage(10, 2))]);
    await f.session.prompt(`${big} FIRST`);
    expect(compactions(f)).toHaveLength(0);
    await f.session.compact();
    expect(f.sent.some(worker)).toBe(false);
    expect(compactions(f)).toHaveLength(1);
    expect(compactions(f)[0]!.details?.traceMemory).toBeTruthy();
    await completedStatus(f);
  } finally { f.dispose(); }
});

test("130: a manual compact with instructions is Pi's own summary; whitespace-only instructions are still ours", async () => {
  const f = await session({ automatic: false });
  try {
    scripted(f, [() => say("answered", usage(10, 2)), () => say("answered", usage(10, 2)), () => say("native summary", usage(10, 2))]);
    await f.session.prompt(`${big} FIRST`);
    await f.session.prompt("SECOND");
    const before = f.sent.length;
    await f.session.compact("  keep the TENSOR-NAME decision  ");
    // Pi's own summarisation request, carrying the instructions
    expect(f.sent.slice(before).some(body => JSON.stringify(body).includes("keep the TENSOR-NAME decision"))).toBe(true);
    expect(compactions(f)).toHaveLength(1);
    expect(compactions(f)[0]!.summary).toContain("native summary");
    expect(compactions(f)[0]!.details?.traceMemory).toBeUndefined();

    await f.session.prompt(`${big} THIRD`);
    const again = f.sent.length;
    await f.session.compact("   ");
    expect(f.sent.length).toBe(again); // no model call: Trace Memory's compaction
    expect(compactions(f)).toHaveLength(2);
    expect(compactions(f)[1]!.details?.traceMemory).toBeTruthy();
  } finally { f.dispose(); }
});

async function completedStatus(f: Awaited<ReturnType<typeof session>>) {
  expect(f.notices.filter(n => n.includes("compaction used"))).toHaveLength(1);
  expect(f.notices.at(-1)).toContain("compaction used bounded entry views");
  await f.session.prompt("/trace");
  expect(f.notices.at(-1)).toContain("Compaction: bounded entry views");
}

test.each([true, false])("133 R1: pending Raw overflow uses Pi's native compactor (automatic=%s) without a custom carrier or an extra Noter", async automatic => {
  const f = await session({ automatic, rawTokens: 1, memoryConfig: { "compaction.temporaryTokens": 1 } });
  try {
    const replies = automatic
      ? [() => say("answered", usage(2_950, 2)), () => say("native overflow summary", usage(10, 2))]
      : [() => say("answered", usage(10, 2)), () => say("answered", usage(10, 2)), () => say("native overflow summary", usage(10, 2))];
    scripted(f, replies);
    await f.session.prompt(`${big} FIRST`);
    if (!automatic) {
      await f.session.prompt("SECOND");
      await f.session.compact();
    }
    expect(compactions(f)).toHaveLength(1);
    expect(compactions(f)[0]!.summary).toContain("native overflow summary");
    expect(compactions(f)[0]!.details?.traceMemory).toBeUndefined();
    expect(f.sent.some(worker)).toBe(false);
    expect(f.notices.some(message => message.includes("compaction omitted"))).toBe(false);
    expect(f.notices.at(-1)).toContain("compaction used native delegation");
    await f.session.prompt("/trace");
    expect(f.notices.at(-1)).toContain("Compaction: native delegation");
  } finally { f.dispose(); }
});

test("133: optional pi-subagents service supplies queued/running tasks to persisted compaction", async () => {
  const f = await session({ automatic: false });
  const key = Symbol.for("@gotgenes/pi-subagents:service");
  const registry = globalThis as Record<symbol, unknown>, previous = registry[key];
  registry[key] = { listAgents: () => [
    { id: "queued", type: "Explore", description: "Waiting for a seat", status: "queued" },
    { id: "running", type: "reviewer", description: "Inspecting the change", status: "running" },
    { id: "done", type: "Explore", description: "Finished task", status: "completed" },
    { id: "missing-description", type: "Explore", status: "running" },
    { id: "missing-type", description: "Missing kind", status: "queued" },
    { type: "Explore", description: "Missing id", status: "running" },
    { id: "bad-description", type: "Explore", description: 42, status: "running" },
    null,
  ] };
  try {
    f.script(() => say("answered", usage(10, 2)));
    await f.session.prompt("FIRST");
    await f.session.compact();
    const summary = compactions(f)[0]!.summary;
    expect(summary).toContain("- queued Explore: Waiting for a seat (queued)");
    expect(summary).toContain("- running reviewer: Inspecting the change (running)");
    expect(summary).not.toContain("Finished task");
    expect(summary).not.toContain("missing-description");
    expect(summary).not.toContain("missing-type");
    expect(summary).not.toContain("bad-description");
    expect(summary).not.toContain("Missing id");
    expect(summary.indexOf("Running tasks:")).toBeGreaterThan(summary.indexOf("Raw:"));
    delete registry[key];
    await f.session.prompt("SECOND");
    await f.session.compact();
    expect(compactions(f)[1]!.summary).not.toContain("Running tasks:");
    expect(compactions(f)[1]!.details?.traceMemory).toBeTruthy();
    expect(f.sent).toHaveLength(2); // two foreground answers, no compaction or worker requests
    expect(f.notices.some(message => message.includes("native delegation"))).toBe(false);
  } finally {
    if (previous === undefined) delete registry[key]; else registry[key] = previous;
    f.dispose();
  }
});

test("133 R2: a throwing optional Pi agent lookup keeps native fallback", async () => {
  const f = await session({ automatic: false });
  const key = Symbol.for("@gotgenes/pi-subagents:service");
  const registry = globalThis as Record<symbol, unknown>, previous = registry[key];
  registry[key] = { listAgents: () => { throw new Error("agent registry unavailable"); } };
  try {
    scripted(f, [() => say("answered", usage(10, 2)), () => say("answered", usage(10, 2)),
      () => say("native lookup-error summary", usage(10, 2))]);
    await f.session.prompt("FIRST");
    await f.session.prompt("SECOND");
    await f.session.compact();
    expect(compactions(f)).toHaveLength(1);
    expect(compactions(f)[0]!.summary).toContain("native lookup-error summary");
    expect(compactions(f)[0]!.details?.traceMemory).toBeUndefined();
    expect(f.sent.some(worker)).toBe(false);
    expect(f.notices.some(message => message.includes("agent registry unavailable"))).toBe(true);
    expect(f.notices.some(message => message.includes("compaction omitted"))).toBe(false);
  } finally {
    if (previous === undefined) delete registry[key]; else registry[key] = previous;
    f.dispose();
  }
});
