// Ticket 27a ruling points — one capacity rule on Pi's own context measure. Each test names the
// ruling it pins (parent 27 "Decision" and amendment 9, which supersedes amendments 2, 3 and 8 and
// withdraws the provider-body extraction of "Text accounting"):
//
//   context measure + 10,000 <= context window
//
// The measure is Pi's, taken where Pi takes it: pi-ai's `estimateContextTokens` over the child's own
// context for the last check before every round. Nothing here — and nothing in the adapter — walks a
// provider request body for tokens, so images and encrypted fields need no rule of ours.
import { expect, test } from "vitest";
import { CONTEXT_HEADROOM } from "../../../src/hosts/pi/index.ts";
import { tokens } from "../../../src/core/api/index.ts";
import { host, reply, usage } from "./test-host.ts";

/** The run this host recorded, with its problems joined — where a refused last check lands. */
const problemsOf = (h: ReturnType<typeof host>) => h.memory.store.listRuns(1).map(r => r.response ?? "").join("\n");

/** A Noting audit is terminal once its final response has `problems`: a successful tool write can
 * precreate the run, but Noting adds this field only after the worker itself has returned. */
async function terminalNotingAudit(h: ReturnType<typeof host>) {
  await expect.poll(() => {
    const run = h.memory.store.listRuns(1).find(r => r.kind === "noting");
    if (!run?.response) return false;
    try { return Array.isArray(JSON.parse(run.response).problems); } catch { return false; }
  }, { timeout: 5_000 }).toBe(true);
  return h.memory.store.listRuns(1).find(r => r.kind === "noting")!;
}

/** A subagent Noting run whose child takes a second round: its first reply reports a 50,000-token
 * prompt and calls a read-only memory tool, so the round after it is measured on that real usage plus
 * the tool result — the synthetic later round the last check has to decide. Returns the measure it was
 * refused on, or undefined when the round went out. */
async function laterRound(contextWindow: number, control?: {
  firstReply: Promise<void>; afterDrain: (h: ReturnType<typeof host>) => void;
}) {
  const h = host({ "noting.triggerTokens": 30, contextWindow });
  try {
    h.ctx.model = { ...h.ctx.model!, contextWindow };
    h.provider(async conversation => {
      if (conversation.messages.some(m => m.role === "toolResult")) return reply("Done.");
      await control?.firstReply;
      return { ...reply(""), stopReason: "toolUse", content: [{ type: "toolCall", id: "t1", name: "search", arguments: { query: "pnpm" } }],
        usage: { ...usage, input: 50_000, totalTokens: 50_002 } };
    });
    await h.prompt("word ".repeat(50)); await h.answer("word ".repeat(50));
    await h.emit("agent_settled"); await h.drain();
    control?.afterDrain(h);
    await terminalNotingAudit(h);
    const measured = /context of (\d+) tokens/.exec(problemsOf(h))?.[1];
    return { measure: measured === undefined ? undefined : Number(measured), requests: h.requests.length,
      outcomes: h.memory.store.listRuns(1).map(r => r.outcome), pending: h.memory.pendingEntries(1, "main", 1).length };
  } finally { await h.dispose(); }
}

test("27a 2026-09-10: the input allowance is the context window minus the 10,000-token headroom, and model.maxTokens enters neither it nor the verdict", async () => {
  // 30: one entry view is capped at 2,000 tokens, so this pending pair no longer reaches the default
  // trigger on its own; the trigger is lowered, and the allowance below is what the case is about.
  const h = host({ "noting.triggerTokens": 30 });
  try {
    h.persist({ role: "user", content: "word ".repeat(15000), timestamp: 1 });
    h.persist(reply("word ".repeat(15000)));
    // 12,000 - 10,000 leaves 2,000 tokens for input, under the instruction and tool cost alone; the
    // diagnostic states the allowance it was given, which is the number this case pins.
    h.ctx.model = { ...h.ctx.model!, contextWindow: 12_000, maxTokens: 8_192 };
    await h.emit("session_start");
    h.persist(reply("completion")); await h.emit("agent_end"); await h.emit("agent_settled"); await h.drain();
    expect(12_000 - CONTEXT_HEADROOM).toBe(2_000);
    expect(h.notices.join("\n")).toContain(`of the ${12_000 - CONTEXT_HEADROOM} tokens allowed for input`);
    expect(h.requests).toEqual([]);
    const first = h.notices.filter(n => n.includes("tokens allowed for input"));
    // The same window with a maximum output 128 times smaller: no term of the rule moved, so the
    // allowance, the floor and the verdict are the same sentence again.
    h.notices.length = 0;
    h.ctx.model = { ...h.ctx.model!, maxTokens: 64 };
    await h.prompt("next capacity check"); await h.answer("next completion"); await h.drain();
    expect(h.notices.filter(n => n.includes("tokens allowed for input"))).toEqual(first);
    expect(h.requests).toEqual([]);
  } finally { await h.dispose(); }
});

test("27a test host: a held request makes generic drain return before the later-round audit is terminal", async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const result = await laterRound(55_000, { firstReply: held, afterDrain: h => {
    try {
      expect(h.requests).toHaveLength(1);
      expect(h.memory.store.listRuns(1)).toEqual([]);
      expect(problemsOf(h)).not.toContain("context of");
      expect(h.memory.pendingEntries(1, "main", 1)).toHaveLength(2);
    } finally { release(); }
  } });
  expect(result.measure).toBeGreaterThan(50_000);
  expect(result).toMatchObject({ requests: 1, outcomes: ["failure"], pending: 2 });
});

test("27a 2026-09-10: the last check admits a later round the headroom exactly fits and refuses one token more", async () => {
  // The same run under three windows. The first is wide enough for admission and for the child's first
  // round and too narrow for its second; it reports the measure, and the other two windows are derived
  // from it, so no number below is written down. The measure is the reply's own reported usage plus the
  // estimate of the tool result after it, which is the same context in all three hosts.
  const refused = await laterRound(55_000);
  expect(refused.measure).toBeGreaterThan(50_000);
  expect(refused.requests).toBe(1); // the first round left; the second did not
  const measure = refused.measure!;

  const equal = await laterRound(measure + CONTEXT_HEADROOM); // measure + 10,000 == window: admitted
  expect(equal.measure).toBeUndefined();
  expect(equal).toMatchObject({ requests: 3, outcomes: ["failure"], pending: 2 }); // the later round and fixed end review went out; the deliberately incomplete worker advanced nothing

  const over = await laterRound(measure + CONTEXT_HEADROOM - 1); // one token more than the rule allows
  expect(over.measure).toBe(measure);
  expect(over).toMatchObject({ requests: 1, outcomes: ["failure"], pending: 2 }); // the later round was refused and nothing advanced
});

test("27a 2026-09-10: a subagent is priced by core's material accounting alone; the session's context measure never enters it", async () => {
  const h = host({ "noting.triggerTokens": 30 });
  try {
    await h.emit("session_start");
    // A foreground context far past any window. A fresh child inherits none of it, so it prices
    // nothing of it: only the instructions, the tool definitions and the frozen material.
    h.setContextUsage({ tokens: 10_000_000, contextWindow: 200_000, percent: 5_000 });
    await h.prompt("word ".repeat(200)); await h.answer("word ".repeat(200));
    await h.emit("agent_settled"); await h.drain();
    expect(h.memory.store.listRuns(1).map(r => r.outcome)).toEqual(["success", "success"]); // the batch's write and verify runs
    expect(h.requests.length).toBeGreaterThan(0);
  } finally { await h.dispose(); }
});
