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
import { fixture, say, submitted, usage as wireUsage, worker, call, noteBatch, settled, type Body } from "./native-fixture.ts";

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

/** A subagent Noting run whose child takes a second round: its first reply reports a 50,000-token
 * prompt and calls a read-only memory tool, so the round after it is measured on that real usage plus
 * the tool result — the synthetic later round the last check has to decide. Returns the measure it was
 * refused on, or undefined when the round went out. */
async function laterRound(contextWindow: number) {
  const h = host({ "noting.triggerTokens": 20, "noting.forkModeDefault": false, contextWindow });
  try {
    h.ctx.model = { ...h.ctx.model!, contextWindow };
    h.provider(async conversation => conversation.messages.some(m => m.role === "toolResult") ? reply("Done.")
      : { ...reply(""), stopReason: "toolUse", content: [{ type: "toolCall", id: "t1", name: "search", arguments: { query: "pnpm" } }],
          usage: { ...usage, input: 50_000, totalTokens: 50_002 } });
    await h.prompt("word ".repeat(50)); await h.answer("word ".repeat(50));
    await h.emit("agent_settled"); await h.drain();
    const measured = /context of (\d+) tokens/.exec(problemsOf(h))?.[1];
    return { measure: measured === undefined ? undefined : Number(measured), requests: h.requests.length,
      outcomes: h.memory.store.listRuns(1).map(r => r.outcome), pending: h.memory.pendingEntries(1, "main", 1).length };
  } finally { await h.dispose(); }
}

test("27a 2026-09-10: the input allowance is the context window minus the 10,000-token headroom, and model.maxTokens enters neither it nor the verdict", async () => {
  const h = host({ "noting.forkModeDefault": false });
  try {
    h.persist({ role: "user", content: "word ".repeat(15000), timestamp: 1 });
    h.persist(reply("word ".repeat(15000)));
    await h.emit("session_start");
    // 12,000 - 10,000 leaves 2,000 tokens for input, under the instruction and tool cost alone; the
    // diagnostic states the allowance it was given, which is the number this case pins.
    h.ctx.model = { ...h.ctx.model!, contextWindow: 12_000, maxTokens: 8_192 };
    h.persist(reply("completion")); await h.emit("agent_end"); await h.drain();
    expect(12_000 - CONTEXT_HEADROOM).toBe(2_000);
    expect(h.notices.join("\n")).toContain(`of the ${12_000 - CONTEXT_HEADROOM} tokens allowed for input`);
    expect(h.requests).toEqual([]);
    const first = h.notices.filter(n => n.includes("tokens allowed for input"));
    // The same window with a maximum output 128 times smaller: no term of the rule moved, so the
    // allowance, the floor and the verdict are the same sentence again.
    h.notices.length = 0;
    h.ctx.model = { ...h.ctx.model!, maxTokens: 64 };
    h.persist(reply("next completion")); await h.emit("agent_end"); await h.drain();
    expect(h.notices.filter(n => n.includes("tokens allowed for input"))).toEqual(first);
    expect(h.requests).toEqual([]);
  } finally { await h.dispose(); }
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
  expect(equal.requests).toBe(2); // the later round went out

  const over = await laterRound(measure + CONTEXT_HEADROOM - 1); // one token more than the rule allows
  expect(over.measure).toBe(measure);
  expect(over.requests).toBe(1);
  expect(over.outcomes).toEqual(["failure"]);
  expect(over.pending).toBe(2); // nothing advanced
});

test("27a 2026-09-10: a fork's inherited prefix is Pi's context measure, and image data in the captured parent request changes neither the number nor the verdict", async () => {
  // Two images in the captured parent request, at the size the live failure reported (925,248 base64
  // characters), and then ten times that. The withdrawn whole-body estimate priced those characters as
  // prose — the 483,267-of-297,000 refusal that opened ticket 27; Pi's measure holds whatever the
  // images really cost, and this adapter adds nothing to it.
  const captured = (chars: number) => ({ model: "test", messages: [{ role: "user", content: [{ type: "text", text: "look" },
    ...[0, 1].map(() => ({ type: "image_url", image_url: { url: `data:image/png;base64,${"A".repeat(chars)}` } }))] }] });
  const admission = async (payload: unknown) => {
    const h = host({ "noting.triggerTokens": 20 }); // fork is the default mode
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

test("27a 2026-09-10: a 300,000-token parent measure with a small increment forks under a 500,000-token window that the withdrawn whole-body estimate refused", async () => {
  const f = await fixture({ contextWindow: 500_000 });
  try {
    // The parent's reply reports a 300,000-token prompt, and its history carries two images. Pi's
    // measure is that reply's own usage plus the estimate of what follows it; the base64 never
    // reaches an estimator of ours.
    f.script((body, index) => index === 0 ? say("好的。", wireUsage(300_000, 2))
      : worker(body) && !submitted(body) ? call("t1", "note", noteBatch) : say("Done."));
    const image = { type: "image" as const, data: base64(925_248), mimeType: "image/png" };
    await f.h.emit("before_agent_start", { prompt: "用 pnpm，不要 npm" });
    const at = f.sent.length;
    await f.parent.prompt("用 pnpm，不要 npm", { images: [image, image] });
    const captured = f.sent[at]!;
    await f.h.emit("before_provider_request", { payload: captured });
    await f.h.emit("agent_settled");
    await f.h.drain();

    const measure = (f.h.ctx as unknown as { getContextUsage(): { tokens: number | null } }).getContextUsage().tokens!;
    expect(measure).toBeGreaterThanOrEqual(300_000);
    expect(measure + CONTEXT_HEADROOM).toBeLessThanOrEqual(500_000); // the rule admits it
    // The withdrawn formula: `tokens(JSON.stringify(payload))` against `floor(window x 0.85) - maxTokens`.
    expect(tokens(JSON.stringify(captured))).toBeGreaterThan(Math.floor(500_000 * 0.85) - 8_192);

    const run = await settled(f);
    expect(run.mode).toBe("fork");
    expect(run.outcome).toBe("success");
    expect(JSON.parse(run.response!).verification.passed).toBe(true);
    expect(f.h.memory.store.listSessionFacts(1).map(fact => fact.text)).toEqual(["用 pnpm，不要 npm"]);
  } finally { await f.dispose(); }
}, 60000);

test("27a 2026-09-10: the fork measure is read once at admission, and a later foreground change does not move it", async () => {
  const f = await fixture();
  try {
    let reads = 0;
    // The first read is the admission's; every later one reports a context no window could hold, so a
    // run that re-read the measure anywhere after admission could not have sent anything.
    (f.h.ctx as unknown as { getContextUsage: () => unknown }).getContextUsage = () =>
      ({ tokens: reads++ === 0 ? 1_000 : 10_000_000, contextWindow: 200_000, percent: 1 });
    f.script((body: Body) => !worker(body) ? say("好的。") : submitted(body) ? say("Done.") : call("t1", "note", noteBatch));
    await f.turn();
    const run = await settled(f);
    expect(reads).toBe(1);
    expect(run.mode).toBe("fork");
    expect(run.outcome).toBe("success");
  } finally { await f.dispose(); }
}, 30000);

test("27a 2026-09-10: an unknown context measure is not a fork base — the task waits with a diagnostic and nothing is sent", async () => {
  const h = host({ "noting.triggerTokens": 20 }); // fork is the default mode
  try {
    await h.emit("session_start");
    // What Pi reports right after a compaction, before a valid reply has answered on the new prefix.
    h.setContextUsage({ tokens: null, contextWindow: 200_000, percent: null });
    await h.prompt("word ".repeat(200));
    await h.emit("before_provider_request", { payload: { model: "test", messages: [{ role: "user", content: "hi" }] } });
    await h.answer("word ".repeat(200));
    await h.emit("agent_settled"); await h.drain();
    expect(h.requests).toEqual([]);
    expect(h.memory.store.listRuns(1)).toEqual([]);
    expect(h.memory.pendingEntries(1, "main", 1).length).toBeGreaterThan(0);
    expect(h.notices.join("\n")).toContain("no fork base");
    // The measure returns and the same pending work runs, so nothing was permanently refused.
    h.setContextUsage({ tokens: 1_000, contextWindow: 200_000, percent: 1 });
    h.persist(reply("completion")); await h.emit("agent_end"); await h.drain();
    expect(h.requests.length).toBeGreaterThan(0);
  } finally { await h.dispose(); }
});

test("27a 2026-09-10: a subagent is priced by core's material accounting alone; the session's context measure never enters it", async () => {
  const h = host({ "noting.triggerTokens": 20, "noting.forkModeDefault": false });
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
