import { expect, test } from "vitest";
import { TraceMemory, renderEntry, tokens, toolDefinitions, DEFAULT_CONFIG, type SourceEntry, type NotingAgentInput } from "../../../src/core/api/index.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { conversationOf, dreamerFiles, host, NOTER_BATCH_REQUESTS, reply, usage } from "./test-host.ts";
import { largestTaskPromptTokens, submit, verifyUnchanged } from "../../support/noter.ts";
import { noterWrittenItem } from "../../support/dreamer.ts";
import { CONTEXT_HEADROOM } from "../../../src/hosts/pi/index.ts";
import { hydrate } from "../../source-fixture.ts";
import { fact as seedFact, facts as seedFacts } from "../../support/seed.ts";
import { loadPrompt } from "../../../src/core/prompts/load.ts";
import { withRetrievalPolicy } from "../../../src/core/render/retrieval-policy.ts";
import { canonicalToolNames } from "../../../src/core/prompts/tool-names.ts";
import { pricedToolDefinitions } from "../../../src/core/api/tools.ts";
import { rawWindowTokens } from "../../../src/core/render/material.ts";

// 30 capped one entry view at `render.entryTokens` (2,000), so the cases below reach a trigger, a
// batch ceiling or a capacity allowance with several entries or a smaller cap instead of one huge
// entry. What each pins — the exact threshold, the batch composition, the capacity prefix — is
// unchanged; only the size one entry may reach is.
const view = (text: string, nativeId: string, role: "user" | "assistant") => renderEntry({ id: 1, entryOrdinal: role === "user" ? 1 : 2, sessionId: 1, nativeLineage: "pi-test", nativeId, turnId: 1, role, text, raw: "", calls: [], blocks: [{ kind: "text", text }] } as SourceEntry, DEFAULT_CONFIG.render).content;
const batchText = (input: string) => input.split("Raw:\n\n")[1]!.split("\n</episodic>")[0]!;

test.each([9999, 10000])("Noting threshold counts only material views (%s)", async size => {
  const h = host({});
  try {
    // 30: one entry view is worth at most 2,000 tokens, so the threshold is reached by several
    // entries; the last one is tuned word by word until the joined estimate is exactly `size`.
    const bodies = Array.from({ length: 5 }, () => "word ".repeat(1_800));
    const joined = (last: string) => tokens([...bodies.map((text, i) => view(text, `u${i}`, "user")),
      view(last, "u", "user"), view("a", "a", "assistant")].join("\n\n"));
    // Start one estimate away from the target so the loops below take a handful of renderings, not one
    // per word: every "word " is about one token, and the two loops close the remaining gap exactly.
    let content = "word ".repeat(Math.max(1, size - joined("word ")));
    while (joined(content) < size) content += "word ";
    while (joined(content) > size) content = content.slice(5);
    bodies.forEach((text, i) => h.persist({ role: "user", content: text, timestamp: 1 }, `u${i}`));
    h.persist({ role: "user", content, timestamp: 1 }, "u");
    h.persist({ ...reply(""), content: [{ type: "thinking", thinking: "private" }] }, "thinking");
    await h.emit("session_start");
    h.persist(reply("a"), "a");
    await h.emit("agent_settled"); await h.drain();
    const entries = hydrate(h.memory.store.listSourceEntries(1), h.memory.store);
    const head = h.memory.store.listTurns(1).at(-1)!.id;
    expect(tokens(entries.filter(entry => entry.nativeId !== "thinking").map(e => renderEntry(e, h.memory.config.render).content).join("\n\n"))).toBe(size);
    // The default script runs one batch: a write task, then a verify task.
    expect(h.requests).toHaveLength(size === 10000 ? NOTER_BATCH_REQUESTS : 0);
    const pending = hydrate(h.memory.pendingEntries(1, "main", head), h.memory.store);
    if (size === 9999) expect(pending.map(e => e.id)).toEqual(entries.map(e => e.id));
    else {
      const run = h.memory.store.listRuns(1).find(r => r.kind === "noting")!;
      const processed = JSON.parse(run.response!).entryAudit.entries.map((e: { id: number }) => e.id);
      expect(processed.length).toBeGreaterThan(0);
      expect(processed).toEqual(entries.slice(0, processed.length).map(e => e.id));
      expect(pending.map(e => e.id)).toEqual(entries.slice(processed.length).map(e => e.id));
    }
  } finally { await h.dispose(); }
});

test.each([false, true])("17b 2026-09-08 (batch ceiling superseded by 20b): oldest whole-entry batches cross Turns or split one Turn (%s), with no completion chaining", async severalTurns => {
  const h = host({ "noting.triggerTokens": 30 });
  const cap = DEFAULT_CONFIG.noting.batchTokens; // 20b: 10,000, not 17b's 50,000
  try {
    h.persist({ role: "user", content: "start", timestamp: 1 });
    // 30: each reply is kept under `render.entryTokens` (2,000) so nothing is cut here, and there are
    // enough of them to fill three batches of the unchanged 10,000-token ceiling.
    for (let i = 0; i < 14; i++) {
      if (severalTurns && i) h.persist({ role: "user", content: `turn ${i}`, timestamp: 1 });
      h.persist(reply(`entry ${i} ` + "word ".repeat(1800)));
    }
    await h.emit("session_start"); // importing history is not a completion trigger
    const head = h.memory.store.listTurns(1).at(-1)!.id;
    const initial = hydrate(h.memory.pendingEntries(1, "main", head), h.memory.store);
    expect(tokens(initial.map(e => renderEntry(e, h.memory.config.render).content).join("\n\n"))).toBeGreaterThan(2 * cap);
    h.persist(reply("new completion")); await h.emit("agent_end"); await h.emit("agent_settled"); await h.drain();
    let previous = 0;
    for (let batch = 0; batch < 3; batch++) {
      const run = h.memory.store.listRuns(1).filter(r => r.kind === "noting")[4 * batch]!;
      const ids: number[] = JSON.parse(run.response!).entryAudit.entries.map((e: { id: number }) => e.id);
      const all = hydrate(h.memory.store.listSourceEntries(1), h.memory.store);
      expect(ids).toEqual(all.slice(previous, previous + ids.length).map(e => e.id));
      const sent = batchText(h.conversations[NOTER_BATCH_REQUESTS * batch]!.messages[0]!.content as string); // the batch's first request
      expect(sent).toBe(ids.map(id => renderEntry(h.memory.store.getSourceEntry(id)!, h.memory.config.render).content).join("\n\n"));
      expect(tokens(sent)).toBeLessThanOrEqual(cap);
      if (batch < 2) expect(tokens(sent + "\n\n" + renderEntry(all[previous + ids.length]!, h.memory.config.render).content)).toBeGreaterThan(cap);
      previous += ids.length;
      if (severalTurns) expect(new Set(ids.map(id => h.memory.store.getSourceEntry(id)!.turnId)).size).toBeGreaterThan(1);
      else if (batch === 0) expect(new Set(ids.map(id => h.memory.store.getSourceEntry(id)!.turnId)).size).toBe(1);
      await h.emit("agent_settled"); await h.drain();
      expect(h.conversations).toHaveLength(NOTER_BATCH_REQUESTS * (batch + 1)); // settling and completion of the worker start nothing
      if (batch < 2) { await h.prompt(`next batch ${batch}`); await h.answer(`completion ${batch}`); await h.drain(); }
    }
    expect(hydrate(h.memory.pendingEntries(1, "main", head), h.memory.store)).toEqual([]);
  } finally { await h.dispose(); }
}, 30000);

test("17b 2026-09-08: model capacity reduces the prefix and an oversized oldest entry stays pending with a report", async () => {
  // 30: two 2,000-token views no longer reach the default trigger on their own, so it is lowered.
  const h = host({ "noting.triggerTokens": 30 });
  try {
    h.persist({ role: "user", content: "word ".repeat(15000), timestamp: 1 });
    h.persist(reply("word ".repeat(15000)));
    // Price the current shared prompt/schema, not the pre-92 fixed overhead. The remaining
    // 3k holds one 2k entry and framing, but not two entries. Production limits are unchanged.
    const fixed = tokens(withRetrievalPolicy(loadPrompt("noting.md"), canonicalToolNames)) + largestTaskPromptTokens() + tokens(JSON.stringify(pricedToolDefinitions(toolDefinitions, canonicalToolNames)));
    const fittingWindow = fixed + 3_000 + CONTEXT_HEADROOM;
    h.ctx.model = { ...h.ctx.model!, contextWindow: fittingWindow };
    await h.emit("session_start");
    h.persist(reply("completion")); await h.emit("agent_end"); await h.emit("agent_settled"); await h.drain();
    expect(h.requests).toHaveLength(NOTER_BATCH_REQUESTS); // one batch: both tasks
    expect(JSON.parse(h.memory.store.listRuns(1)[0]!.response!).entryAudit.entries).toHaveLength(1);
    // 27a, replacing the whole-body estimate plus output reserve: what the child really sent had to
    // satisfy the one rule, measured as Pi measures the child's context — its messages, with no
    // assistant usage yet on a first round — with the headroom left over.
    expect(estimateContextTokens(conversationOf(h.requests[0]).messages as never).tokens + CONTEXT_HEADROOM).toBeLessThanOrEqual(fittingWindow);
    const pending = hydrate(h.memory.pendingEntries(1, "main", 1), h.memory.store);
    // Fixed instructions/tools still fit, but the remaining 1k cannot hold the oldest 2k view.
    h.ctx.model = { ...h.ctx.model!, contextWindow: fixed + 1_000 + CONTEXT_HEADROOM };
    await h.prompt("next capacity check"); await h.answer("next completion"); await h.drain();
    expect(h.requests).toHaveLength(NOTER_BATCH_REQUESTS); // the refused admission adds none
    expect(hydrate(h.memory.pendingEntries(1, "main", 1), h.memory.store).slice(0, pending.length)).toEqual(pending);
    expect(h.notices.join("\n")).toContain("Noting capacity: selected evidence cannot fit the model context");
  } finally { await h.dispose(); }
});

// Retired C's rendered-fact trigger has no replacement: N writes knowledge with facts.
// D's independent due predicate is the Noter-changed knowledge since the last curate, not a count or size of old facts.
test("D admits a due Noter-written item on an entry without consuming pending Raw", async () => {
  const h = host({ "noting.triggerTokens": 1_000_000_000, "dreaming.triggerOperations": 1 });
  try {
    await h.turn();
    const user = h.memory.store.getSourceEntry(h.memory.store.sourcePath(1, "main", 1)[0]!.id)!;
    seedFact(h.memory, h.memory.store.knowledgePath(1, "main", 1), "Package manager choice",
      [{ entry: user, text: "User chose pnpm" }]);
    const path = { sessionId: 1, branch: "main", headTurnId: 1 };
    const trigger = noterWrittenItem(h.memory, path, 1);
    expect(h.memory.store.dreamingDue(path, 1)).toBe(true);
    let curateInput = "";
    h.provider(async c => { curateInput ||= String(c.messages[0]!.content); return dreamerFiles(c) ?? reply("Done."); });
    await h.prompt("new main turn"); await h.answer("new completed entry"); await h.drain();
    expect(curateInput).toContain(`K${trigger.knowledgeId}`);
    expect(h.memory.store.listRuns(1).filter(r => r.kind === "dreaming").map(r => r.outcome)).toEqual(["success", "success", "success"]); // curate, verify, classify
    expect(h.memory.pendingEntries(1, "main", 1).length).toBeGreaterThan(0);
  } finally { await h.dispose(); }
});

test("17b 2026-09-08: lifecycle hooks launch neither phase and preserve both pending queues", async () => {
  const h = host({});
  try {
    h.persist({ role: "user", content: "word ".repeat(20000), timestamp: 1 }); h.persist(reply("pending"));
    await h.emit("session_start");
    const user = h.memory.store.getSourceEntry(h.memory.store.sourcePath(1, "main", 1)[0]!.id)!;
    seedFacts(h.memory, h.memory.store.knowledgePath(1, "main", 1),
      Array.from({ length: 50 }, (_, i) => ({ title: `Claim ${i}`, sources: [{ entry: user, text: `claim ${i}` }] })));
    const pending = hydrate(h.memory.pendingEntries(1, "main", 1), h.memory.store);
    const summary = await h.emit("session_before_tree");
    expect(summary.summary.summary).toBe(h.memory.branchSummary(1, "main", 1));
    await h.emit("session_before_compact", { preparation: { tokensBefore: 100000 } });
    await h.emit("session_shutdown");
    expect(h.requests).toEqual([]);
    expect(hydrate(h.memory.pendingEntries(1, "main", 1), h.memory.store)).toEqual(pending);
    expect(h.memory.store.listBranchFacts(1, "main", 1)).toHaveLength(50); // historical fact backlog is not erased
  } finally { await h.dispose(); }
});

test("17b 2026-09-08 (batch default superseded by 20b): configuration rejects removed and unknown keys and validates compressed trigger and batch limits", () => {
  expect(DEFAULT_CONFIG.noting).toMatchObject({ triggerTokens: 10000, batchTokens: 10000 });
  for (const key of ["triggerTokens", "batchTokens"]) for (const value of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => TraceMemory(":memory:", async () => ({ outcome: "success", output: "", request: {} }), { noting: { [key]: value } })).toThrow(`Invalid noting.${key}`);
  }
  for (const key of ["triggerAnsweredTurns", "unknown"]) {
    expect(() => TraceMemory(":memory:", async () => ({ outcome: "success", output: "", request: {} }), { noting: { [key]: 1 } } as never)).toThrow(`Unknown setting noting.${key}`);
    expect(() => host({ [`noting.${key}`]: 1 })).toThrow(`Unknown setting noting.${key}`);
  }
});

test("retired C trigger is never interpreted as an N/D token setting", () => {
  expect(DEFAULT_CONFIG).not.toHaveProperty("consolidation");
  expect(() => host({ "consolidation.triggerUnconsolidatedFacts": 50 })).toThrow(/Consolidation is retired/);
  expect(() => TraceMemory(":memory:", async () => ({ outcome: "success", output: "", request: {} }),
    { consolidation: { triggerTokens: 7 } } as never)).toThrow(/Consolidation is retired/);
  const memory = TraceMemory(":memory:", async () => ({ outcome: "success", output: "", request: {} }));
  try { expect(memory.config.noting).toMatchObject({ triggerTokens: 10_000, batchTokens: 10_000 }); }
  finally { memory.close(); }
});

// 27b moved the second half of this case — a fork whose inherited prefix does not fit — to
// `fallback.test.ts`: that batch is no longer left pending but re-admitted once as a subagent.
// 92 replaces 86's oversized-first exception with a complete-render batch ceiling.
test("92: an oldest entry over the configured batch ceiling remains pending with an explicit refusal", async () => {
  // 30: one entry view is capped at 2,000 tokens, so the ceiling this entry must exceed is smaller,
  // and the trigger is lowered with it — 2,000 tokens of pending Raw no longer reach the default one.
  const h = host({ "noting.batchTokens": 1000, "noting.triggerTokens": 30 });
  try {
    h.persist({ role: "user", content: "word ".repeat(20000), timestamp: 1 }); h.persist(reply("tail"));
    await h.emit("session_start");
    h.persist(reply("completion")); await h.emit("agent_end"); await h.emit("agent_settled"); await h.drain();
    const all = hydrate(h.memory.store.listSourceEntries(1), h.memory.store);
    const runs = h.memory.store.listRuns(1).filter(run => run.kind === "noting");
    expect(runs).toHaveLength(0);
    expect(h.requests).toHaveLength(0);
    expect(tokens(renderEntry(all[0]!, h.memory.config.render).content)).toBeGreaterThan(1000);
    expect(hydrate(h.memory.pendingEntries(1, "main", 1), h.memory.store).map(e => e.id)).toEqual(all.map(e => e.id));
    expect(h.notices.join("\n")).toContain("oldest entry and Raw framing exceed noting.batchTokens (1000); left pending");
  } finally { await h.dispose(); }
});

test("17b 2026-09-08: facade infers the source path before a Turn is fully recorded", async () => {
  const h = host({ "noting.triggerTokens": 1000000000 });
  const runner = TraceMemory(join(h.dir, "trace.db"), async raw => {
    const input = raw as NotingAgentInput;
    if (input.task !== "extract-facts") return verifyUnchanged(input, { request: { exact: true } });
    input.reportRequest({ exact: true });
    if (input.kind === "noting") await submit(input, runner, { noteInput: [{ title: "Partial source", sources: "[T1#E1] partial source fact" }], memoryInput: {} });
    return { outcome: "success", output: "", request: { exact: true } };
  }, { noting: { batchTokens: 100 } });
  try {
    await h.prompt("user source"); await h.answer("word ".repeat(1000));
    expect((await runner.noting({ sessionId: 1, branch: "main", headTurnId: 1 })).outcome).toBe("success");
    expect(hydrate(h.memory.pendingEntries(1, "main", 1), h.memory.store).map(e => e.role)).toEqual(["assistant"]);
    expect(h.memory.store.listSessionFacts(1).map(f => f.id)).toEqual([1]);
    expect(h.memory.store.listRuns(1).some(run => run.kind === "consolidation")).toBe(false);
  } finally { runner.close(); await h.dispose(); }
});

test("17b 2026-09-08, on 27a's rule: a round the child's own context cannot hold is refused before sending or advancing entries", async () => {
  const h = host({ "noting.triggerTokens": 30 });
  try {
    // 27a recalibration. The overhead the old formula caught in the first body — the whole request JSON
    // priced as prose against `floor(window x 0.85) - maxTokens` — is not what the guard reads any
    // more: the last check is Pi's measure of the child's own context, which is that child's latest
    // real assistant usage plus an estimate of what follows it. The overhead is therefore a LATER
    // round: this child's first reply reports a 50,000-token prompt and calls a read-only memory tool,
    // and the round after it — that usage plus the tool result — cannot fit the 55,000 - 10,000 = 45,000
    // the allowance leaves. Admission and the first round pass, so the refusal really is the last check.
    h.ctx.model = { ...h.ctx.model!, contextWindow: 55_000 };
    h.provider(async conversation => conversation.messages.some(m => m.role === "toolResult") ? reply("Done.")
      : { ...reply(""), stopReason: "toolUse", content: [{ type: "toolCall", id: "t1", name: "search", arguments: { query: "pnpm" } }],
          usage: { ...usage, input: 50_000, totalTokens: 50_002 } });
    await h.prompt("word ".repeat(500)); await h.answer("word ".repeat(500));
    await h.emit("agent_settled"); await h.drain();
    expect(h.requests).toHaveLength(1); // the first round left; the round over the rule did not
    expect(hydrate(h.memory.pendingEntries(1, "main", 1), h.memory.store).map(e => e.role)).toEqual(["user", "assistant"]);
    const run = h.memory.store.listRuns(1)[0]!;
    expect(run.outcome).toBe("failure");
    expect(JSON.parse(run.response!).problems.join("\n")).toMatch(/the child's context of \d+ tokens leaves less than the 10000-token headroom in the 55000-token window/);
  } finally { await h.dispose(); }
});

// Ticket 20 "Noting" and acceptance scenario 5. The batch is the oldest contiguous whole-entry prefix
// that fits: an entry that does not fit beside the oldest one is not dropped, and no smaller later
// entry is pulled forward to fill the space it left.
test("20b 2026-09-08 scenario 5: a small oldest entry is not joined with a near-ceiling entry, and no smaller later entry jumps the queue", async () => {
  // Price the complete Raw frame for the bounded large view. It fits alone but not alongside
  // the small oldest entry; a stored-body-only ceiling would reject even the large view.
  const large = "BIG " + "word ".repeat(15000);
  const cap = rawWindowTokens([view(large, "big", "assistant")], []);
  const h = host({ "noting.triggerTokens": 30, "noting.batchTokens": cap });
  try {
    h.persist({ role: "user", content: "small oldest", timestamp: 1 });
    h.persist(reply(large)); // the renderer bounds this at the entry cap
    h.persist(reply("small later"));
    await h.emit("session_start");
    const all = hydrate(h.memory.store.listSourceEntries(1), h.memory.store);
    expect(tokens(renderEntry(all[1]!, h.memory.config.render).content)).toBe(DEFAULT_CONFIG.render.entryTokens);
    h.persist(reply("completion")); await h.emit("agent_end"); await h.emit("agent_settled"); await h.drain();
    const noted = (n: number) => JSON.parse(h.memory.store.listRuns(1).filter(r => r.kind === "noting")[4 * n]!.response!).entryAudit.entries.map((e: { id: number }) => e.id);
    expect(noted(0)).toEqual([all[0]!.id]); // the oldest alone: the near-ceiling entry does not fit beside it
    expect(hydrate(h.memory.pendingEntries(1, "main", 1), h.memory.store).map(e => e.id).slice(0, 2)).toEqual([all[1]!.id, all[2]!.id]);
    await h.prompt("next pending batch"); await h.answer("completion 2"); await h.drain();
    expect(noted(1)).toEqual([all[1]!.id]); // the big entry is taken next, not skipped for the small later one
  } finally { await h.dispose(); }
});

// Retired C-only fact-capacity admission has no live worker. N's oldest-entry and per-round
// capacity refusals above remain active; D's real pending-version admission is exercised here.

// 136 review SPEC4: a Noter's search output past the cap is saved, and the path in the result opens with the
// worker's own `read`, which otherwise opens trace:// only. The directory is removed when the run ends.
test("136 review SPEC4: a Pi Noter's over-long search output is saved and its path is readable by the worker's Read", async () => {
  const h = host({ "noting.triggerTokens": 30 });
  try {
    const toolText = (message: { content?: unknown } | undefined) => ((message?.content as { text?: string }[] | undefined) ?? []).map(part => part.text ?? "").join("");
    let path = "", readBack = "", stranger = "";
    h.provider(async conversation => {
      const results = conversation.messages.filter(m => m.role === "toolResult");
      if (!results.length) return { ...reply(""), stopReason: "toolUse", content: [{ type: "toolCall", id: "s1", name: "search",
        arguments: { layer: "raw", code: "text(Array.from({ length: 40000 }, (_, i) => 'line ' + i + ' word').join('\\n'))" } }] };
      if (results.length === 1) {
        path = /\[Full output: (.+)\]/.exec(toolText(results[0]))![1]!;
        return { ...reply(""), stopReason: "toolUse", content: [{ type: "toolCall", id: "r1", name: "read", arguments: { path } }] };
      }
      if (results.length === 2) {
        readBack = toolText(results[1]);
        return { ...reply(""), stopReason: "toolUse", content: [{ type: "toolCall", id: "r2", name: "read", arguments: { path: join(path, "..", "..", "elsewhere.txt") } }] };
      }
      if (results.length === 3) stranger = toolText(results[2]);
      return reply("Done.");
    });
    await h.prompt("word ".repeat(500)); await h.answer("word ".repeat(500));
    await h.emit("agent_settled"); await h.drain();
    expect(path).toMatch(/trace-memory-worker-[^/]+\/output-[^/]+\.txt$/);
    expect(readBack).toContain("line 0 word"); // Pi's Read pages a long file; the first page opens
    expect(stranger).toMatch(/restricted to trace:\/\//);
    expect(existsSync(path)).toBe(false); // removed with the run
  } finally { await h.dispose(); }
});
