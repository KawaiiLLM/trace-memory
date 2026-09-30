// Ticket 27a ruling points — one capacity rule on Pi's own context measure. Each test names the
// ruling it pins (parent 27 "Decision" and amendment 9, which supersedes amendments 2, 3 and 8 and
// withdraws the provider-body extraction of "Text accounting"):
//
//   context measure + 10,000 <= context window
//
// The measure is Pi's, taken where Pi takes it: `ctx.getContextUsage()` for a fork's inherited prefix,
// read once at admission, and pi-ai's `estimateContextTokens` over the child's own context for the
// last check before every round. Nothing here — and nothing in the adapter — walks a provider request
// body for tokens, so images and encrypted fields need no rule of ours and a subagent on an API the
// fork gate does not know keeps running.
import { expect, test } from "vitest";
import { CONTEXT_HEADROOM } from "../../../src/hosts/pi/index.ts";
import { tokens } from "../../../src/core/api/index.ts";
import { host, reply, usage } from "./test-host.ts";
import { stableForkFixture as forkFixture, say, submitted, usage as wireUsage, worker, noteAndMemory, noteBatch, settled, type Body } from "./native-fixture.ts";

/** Base64-looking payload data of a given length: a deterministic pseudo-random run over the base64
 * alphabet, so the withdrawn text estimator prices it as it priced the live failure's images (about
 * 2.4 characters per token) instead of collapsing a repeated character into one cheap segment. */
function base64(chars: number) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const out = new Array<string>(chars);
  let x = 1;
  for (let i = 0; i < chars; i++) { x = (x * 48271) % 2147483647; out[i] = alphabet[x % 64]!; }
  return out.join("");
}

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
  const h = host({ "noting.triggerTokens": 30, "noting.forkModeDefault": false, contextWindow });
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
  const h = host({ "noting.forkModeDefault": false, "noting.triggerTokens": 30 });
  try {
    h.persist({ role: "user", content: "word ".repeat(15000), timestamp: 1 });
    h.persist(reply("word ".repeat(15000)));
    await h.emit("session_start");
    // 12,000 - 10,000 leaves 2,000 tokens for input, under the instruction and tool cost alone; the
    // diagnostic states the allowance it was given, which is the number this case pins.
    h.ctx.model = { ...h.ctx.model!, contextWindow: 12_000, maxTokens: 8_192 };
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
  expect(equal).toMatchObject({ requests: 2, outcomes: ["failure"], pending: 2 }); // the later round went out; the deliberately incomplete worker advanced nothing

  const over = await laterRound(measure + CONTEXT_HEADROOM - 1); // one token more than the rule allows
  expect(over.measure).toBe(measure);
  expect(over).toMatchObject({ requests: 1, outcomes: ["failure"], pending: 2 }); // the later round was refused and nothing advanced
});

test("27a 2026-09-10: a fork's inherited prefix is Pi's context measure, and image data in the captured parent request changes neither the number nor the verdict", async () => {
  // Two images in the captured parent request, at the size the live failure reported (925,248 base64
  // characters), and then ten times that. The withdrawn whole-body estimate priced those characters as
  // prose — the 483,267-of-297,000 refusal that opened ticket 27; Pi's measure holds whatever the
  // images really cost, and this adapter adds nothing to it.
  const captured = (chars: number) => ({ model: "test", messages: [{ role: "user", content: [{ type: "text", text: "look" },
    ...[0, 1].map(() => ({ type: "image_url", image_url: { url: `data:image/png;base64,${"A".repeat(chars)}` } }))] }] });
  const admission = async (payload: unknown) => {
    const h = host({ "noting.forkModeDefault": true, "noting.triggerTokens": 30 });
    try {
      await h.emit("session_start");
      // 40,000 inherited tokens: with the Noter instructions they exceed the 50,000 - 10,000 allowance.
      h.ctx.model = { ...h.ctx.model!, contextWindow: 50_000 };
      h.setContextUsage({ tokens: 40_000, contextWindow: 50_000, percent: 80 });
      await h.prompt("word ".repeat(200));
      await h.emit("before_provider_request", { payload });
      await h.answer("word ".repeat(200));
      await h.emit("agent_settled"); await h.drain();
      return h.notices.filter(n => n.includes("tokens allowed for input")).join("\n");
    } finally { await h.dispose(); }
  };
  const small = captured(925_248), large = captured(9_252_480);
  // The two payloads are wildly different to the withdrawn estimate, and the same to this rule.
  expect(tokens(JSON.stringify(large))).toBeGreaterThan(tokens(JSON.stringify(small)) * 5);
  const diagnostic = await admission(small);
  expect(diagnostic).toContain("and the inherited context 40000");
  expect(diagnostic).toContain(`of the ${50_000 - CONTEXT_HEADROOM} tokens allowed for input`);
  expect(await admission(large)).toBe(diagnostic);
});

test("27a 2026-09-10: a 300,000-token parent measure with a small increment forks under a 500,000-token window", async () => {
  const f = await forkFixture({ contextWindow: 500_000 });
  try {
    // The parent's reply reports a 300,000-token prompt, and its prompt attaches two images. Pi's
    // measure is that reply's own usage plus the estimate of what follows it; the base64 never
    // reaches an estimator of ours. The live failure's body, where these images made the withdrawn
    // whole-body estimate refuse, no longer arises: Pi 0.87 omits an image it cannot shrink below its
    // inline limit before the request, and the captured-payload case above pins that image data
    // changes neither the measure nor the verdict.
    f.script((body, index) => index === 0 ? say("好的。", wireUsage(300_000, 2))
      : worker(body) && !submitted(body) ? noteAndMemory("t1", noteBatch) : say("Done."));
    const image = { type: "image" as const, data: base64(925_248), mimeType: "image/png" };
    await f.h.emit("before_agent_start", { prompt: "用 pnpm，不要 npm" });
    const at = f.sent.length;
    await f.parent.prompt("用 pnpm，不要 npm", { images: [image, image] });
    const captured = f.sent[at]!;
    await f.h.emit("before_provider_request", { payload: captured });
    // Capacity under a stable parent; a competing settled leaf change is a separate gate case.
    await f.h.emit("agent_settled"); await f.h.drain();

    const measure = (f.h.ctx as unknown as { getContextUsage(): { tokens: number | null } }).getContextUsage().tokens!;
    expect(measure).toBeGreaterThanOrEqual(300_000);
    expect(measure + CONTEXT_HEADROOM).toBeLessThanOrEqual(500_000); // the rule admits it

    const run = await settled(f);
    expect(run.mode).toBe("fork");
    expect(run.outcome).toBe("success");
    expect(JSON.parse(run.response!).verification.passed).toBe(true);
    expect(f.h.memory.store.listSessionFacts(1).map(fact => fact.text)).toEqual(["用 pnpm，不要 npm"]);
  } finally { await f.dispose(); }
}, 60000);

test("27a 2026-09-10: the fork measure is read once at admission, and a later foreground change does not move it", async () => {
  const f = await forkFixture();
  try {
    let reads = 0;
    // The first read is the admission's; every later one reports a context no window could hold, so a
    // run that re-read the measure anywhere after admission could not have sent anything.
    (f.h.ctx as unknown as { getContextUsage: () => unknown }).getContextUsage = () =>
      ({ tokens: reads++ === 0 ? 1_000 : 10_000_000, contextWindow: 200_000, percent: 1 });
    f.script((body: Body) => !worker(body) ? say("好的。") : submitted(body) ? say("Done.") : noteAndMemory("t1", noteBatch));
    await f.turn();
    const run = await settled(f);
    expect(reads).toBe(1);
    expect(run.mode).toBe("fork");
    expect(run.outcome).toBe("success");
  } finally { await f.dispose(); }
}, 30000);

test("27b 2026-09-10: an unknown context measure is not a fork base — the task is re-admitted once as a subagent, with that model's capacity", async () => {
  const h = host({ "noting.forkModeDefault": true, "noting.triggerTokens": 30 });
  try {
    await h.emit("session_start");
    // What Pi reports right after a compaction, before a valid reply has answered on the new prefix.
    // 27a left this task pending; 27b reroutes it to the fresh path instead of waiting for a measure.
    h.setContextUsage({ tokens: null, contextWindow: 200_000, percent: null });
    await h.prompt("word ".repeat(200));
    await h.emit("before_provider_request", { payload: { model: "test", messages: [{ role: "user", content: "hi" }] } });
    await h.answer("word ".repeat(200));
    await h.emit("agent_settled"); await h.drain();
    const run = h.memory.store.listRuns(1)[0]!;
    expect(run.mode).toBe("subagent");
    expect(run.outcome).toBe("success");
    // The requested mode and the reason are the audit's, and the model charged is the configured
    // subagent model — resolved through the `session` preference, so the same provider/id here.
    const response = JSON.parse(run.response!);
    expect(response.requestedMode).toBe("fork");
    expect(run.model).toBe("fake/test");
    expect(h.notices.filter(n => n.includes("fell back to subagent mode"))).toHaveLength(1);
    expect(h.notices.join("\n")).toContain("no fork base");
    // The fresh material was frozen for that model, sent, and its evidence committed exactly once.
    expect(h.requests.length).toBeGreaterThan(0);
    expect(h.conversations[0]!.systemPrompt).toContain("Noting (facts and knowledge)");
    // At the final turn checkpoint the reply is already persisted, so the batch includes it.
    expect(h.memory.pendingEntries(1, "main", 1)).toEqual([]);
    // No latch, no persisted mode change: the next task requests fork again.
    // Read the executor's preference, not the separate observer facade's defaults.
    h.ctx.hasUI = true;
    h.answers.push("Settings…", undefined); await h.commands.get("trace")!.handler("", h.ctx);
    expect(h.dialogs.at(-1)!.options).toContain("Noter mode: fork (Environment setting — this edit will not take effect)");
  } finally { await h.dispose(); }
});

test("27a 2026-09-10: a subagent is priced by core's material accounting alone; the session's context measure never enters it", async () => {
  const h = host({ "noting.triggerTokens": 30, "noting.forkModeDefault": false });
  try {
    await h.emit("session_start");
    // A foreground context far past any window. A fresh child inherits none of it, so it prices
    // nothing of it: only the instructions, the tool definitions and the frozen material.
    h.setContextUsage({ tokens: 10_000_000, contextWindow: 200_000, percent: 5_000 });
    await h.prompt("word ".repeat(200)); await h.answer("word ".repeat(200));
    await h.emit("agent_settled"); await h.drain();
    expect(h.memory.store.listRuns(1).map(r => r.outcome)).toEqual(["success"]);
    expect(h.requests.length).toBeGreaterThan(0);
  } finally { await h.dispose(); }
});
