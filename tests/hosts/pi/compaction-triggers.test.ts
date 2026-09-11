import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { call, piSession, say, submitted, usage } from "./native-fixture.ts";
import { dreamerRecoveryExtension } from "./recovery-fixture.ts";

// Ticket 28 amendment 4: "Pi checks automatic compaction after `agent_end`, before prompt submission
// and between tool rounds … tests cover all three triggers, not only `agent_end`." These cases run
// the REAL extension inside a real Pi `AgentSession` (only the wire is stubbed) and drive each of the
// three code paths that reach `_runAutoCompaction`, so each one really enters this host's
// `session_before_compact` — 28b's freeze/allocate/recover/decide sequence — and Pi really persists
// what it hands back.
//
//   agent-session.js:1634 `_checkCompaction`      after `agent_end` (the post-run loop)
//   agent-session.js:891  `_checkCompaction(…, false)` before prompt submission
//   agent-session.js:274  `_compactBeforeNextAssistantResponse` between tool rounds
// All three land in `_runAutoCompaction` (:1740), whose hook call (:1750) carries the automatic
// abort controller's `signal` and honours `{cancel: true}` (:1770).

const big = "word ".repeat(4_000);
const worker = (body: unknown) => JSON.stringify(body).includes("# Dreamer");
/** The real extension and a temporary DB. The hook seeds eligible knowledge beyond this envelope,
 * so every compact reaches Dreamer recovery, with small/below-threshold N/C left untouched. */
const traceMemory = (dir: string) => ({
  dbPath: join(dir, "trace.db"),
  "noting.triggerTokens": 1_000_000_000, "consolidation.triggerTokens": 1_000_000_000,
  "render.knowledgeBlockTokens": 100, "compaction.factsTokens": 10_000, "compaction.rawTokens": 10_000, "compaction.overflowTokens": 50,
});
const session = async (options: { tools?: Parameters<typeof piSession>[0]["tools"]; contextWindow?: number; keepRecentTokens?: number; automatic?: boolean } = {}) => {
  const store = mkdtempSync(join(tmpdir(), "trace-memory-triggers-"));
  const f = await piSession({ extensions: [dreamerRecoveryExtension(join(store, "trace.db")) as never], contextWindow: options.contextWindow ?? 200_000,
    // The threshold is `contextWindow - reserveTokens` (compaction.js:163), so a large reserve makes a
    // tiny session compact while the model still declares a window a memory worker can be admitted on
    // (27a's 10,000-token headroom).
    compaction: { enabled: options.automatic ?? true, keepRecentTokens: options.keepRecentTokens ?? 1, reserveTokens: 199_900 }, ...(options.tools ? { tools: options.tools } : {}),
    env: { TRACE_MEMORY_CONFIG: JSON.stringify(traceMemory(store)) },
    // A session created after this host's enrollment baseline is enrolled by default (18a), which is
    // what a fresh real session is; the baseline of a fresh agent directory would otherwise be `now`.
    prepare: ({ agentDir }) => writeFileSync(join(agentDir, "trace-memory-baseline.json"), JSON.stringify("2000-01-01T00:00:00.000Z")) });
  const dispose = f.dispose;
  return { ...f, store, dispose: () => { try { dispose(); } finally { rmSync(store, { recursive: true, force: true }); } } };
};

/** The compaction entries this session persisted, and the memory carrier each one holds (29a). */
const compactions = (f: Awaited<ReturnType<typeof session>>) =>
  f.manager.getEntries().filter(e => e.type === "compaction") as { summary: string; details?: { traceMemory?: unknown } }[];

/** Dreamer's trusted archive retires the exact seeded version; no fake completion is injected. */
const noted = (_body: Record<string, any>) =>
  call("archive-1", "memory", { operations: [{ op: "archive", id: "K1@1", supports: [], reason: "Deliberate budget retirement" }], skipped: [] });
const scripted = (f: Awaited<ReturnType<typeof session>>, replies: ((signal?: AbortSignal) => Response | Promise<Response>)[]) => {
  let round = 0;
  f.script((body, signal) => {
    // The recovery worker's own request, told from the foreground's by its production prompt.
    if (worker(body)) return submitted(body) ? say("Done.") : noted(body);
    return (replies[round++] ?? (() => say("later answer", usage(10, 2))))(signal);
  });
};

test("28 amendment 4: the trigger after agent_end reaches the recovery sequence, and Pi persists what it returns", async () => {
  const f = await session();
  try {
    scripted(f, [() => say("answered", usage(2_950, 2))]); // usage over the threshold: the post-run check compacts
    await f.session.prompt(`${big} FIRST`);
    // The hook ran native Dreamer inside Pi's own compaction, and Pi wrote its exact result.
    expect(f.sent.some(body => JSON.stringify(body).includes("# Dreamer"))).toBe(true);
    expect(compactions(f)).toHaveLength(1);
    expect(compactions(f)[0]!.details?.traceMemory).toBeTruthy(); // a custom replacement, not Pi's own summary
  } finally { f.dispose(); }
});

test("28 amendment 4: the trigger before prompt submission reaches the recovery sequence", async () => {
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
    expect(f.sent.slice(before).some(body => JSON.stringify(body).includes("# Dreamer"))).toBe(true);
    expect(compactions(f)).toHaveLength(1);
    expect(compactions(f)[0]!.details?.traceMemory).toBeTruthy();
  } finally { f.dispose(); }
});

test("28 amendment 4: the trigger between tool rounds reaches the recovery sequence", async () => {
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
    expect(f.sent.some(body => JSON.stringify(body).includes("# Dreamer"))).toBe(true);
  } finally { f.dispose(); }
});

test("32f: manual compact reaches native Dreamer recovery and persists its exact carrier", async () => {
  const f = await session({ automatic: false });
  try {
    scripted(f, [() => say("answered", usage(10, 2))]);
    await f.session.prompt(`${big} FIRST`);
    expect(compactions(f)).toHaveLength(0);
    await f.session.compact();
    expect(f.sent.some(worker)).toBe(true);
    expect(compactions(f)).toHaveLength(1);
    expect(compactions(f)[0]!.details?.traceMemory).toBeTruthy();
  } finally { f.dispose(); }
});
