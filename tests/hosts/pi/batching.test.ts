import { expect, test } from "vitest";
import { TraceMemory, renderEntry, tokens, toolDefinitions, DEFAULT_CONFIG, type SourceEntry, type NotingAgentInput } from "../../../src/core/api/index.ts";
import { join } from "node:path";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { conversationOf, host, reply, usage } from "./test-host.ts";
import { createDreamerTrigger } from "../../admitted-dreamer-scenario.ts";
import { CONTEXT_HEADROOM } from "../../../src/hosts/pi/index.ts";
import { hydrate } from "../../source-fixture.ts";
import { loadPrompt } from "../../../src/core/prompts/load.ts";

// 30 capped one entry view at `render.entryTokens` (2,000), so the cases below reach a trigger, a
// batch ceiling or a capacity allowance with several entries or a smaller cap instead of one huge
// entry. What each pins — the exact threshold, the batch composition, the capacity prefix — is
// unchanged; only the size one entry may reach is.
const view = (text: string, nativeId: string, role: "user" | "assistant") => renderEntry({ id: 1, entryOrdinal: role === "user" ? 1 : 2, sessionId: 1, nativeLineage: "pi-test", nativeId, turnId: 1, role, text, raw: "", calls: [], blocks: [{ kind: "text", text }] } as SourceEntry, DEFAULT_CONFIG.render).content;
const batchText = (input: string) => input.split("Raw:\n\n")[1]!.split("\n\nReceipts:")[0]!;

test.each([9999, 10000])("17b 2026-09-08: Noting threshold is exactly compressed tokens (%s)", async size => {
  const h = host({ "noting.forkModeDefault": false });
  try {
    // 30: one entry view is worth at most 2,000 tokens, so the threshold is reached by several
    // entries; the last one is tuned word by word until the joined estimate is exactly `size`.
    const bodies = Array.from({ length: 5 }, () => "word ".repeat(1_800));
    const joined = (last: string) => tokens([...bodies.map((text, i) => view(text, `u${i}`, "user")),
      view(last, "u", "user"), renderEntry({ id: 7, entryOrdinal: 2, sessionId: 1, turnId: 6, nativeLineage: "pi-test", nativeId: "thinking",
        role: "assistant", text: "", raw: "", calls: [], blocks: [{ kind: "thinking", text: "private" }] }, DEFAULT_CONFIG.render).content,
      view("a", "a", "assistant")].join("\n\n"));
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
    await h.emit("message_start", { message: reply("") });
    await h.drain();
    const entries = hydrate(h.memory.store.listSourceEntries(1), h.memory.store);
    const head = h.memory.store.listTurns(1).at(-1)!.id;
    expect(tokens(entries.map(e => renderEntry(e, h.memory.config.render).content).join("\n\n"))).toBe(size);
    // The default script explicitly calls note, then memory, then ends normally.
    expect(h.requests).toHaveLength(size === 10000 ? 3 : 0);
    expect(hydrate(h.memory.pendingEntries(1, "main", head), h.memory.store)).toHaveLength(size === 10000 ? 0 : entries.length);
  } finally { await h.dispose(); }
});

test.each([false, true])("17b 2026-09-08 (batch ceiling superseded by 20b): oldest whole-entry batches cross Turns or split one Turn (%s), with no completion chaining", async severalTurns => {
  const h = host({ "noting.forkModeDefault": false, "noting.triggerTokens": 30 });
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
    h.persist(reply("new completion")); await h.emit("agent_end"); await h.drain();
    let previous = 0;
    for (let batch = 0; batch < 3; batch++) {
      const run = h.memory.store.listRuns(1).filter(r => r.kind === "noting")[batch]!;
      const ids: number[] = JSON.parse(run.response!).entryAudit.entries.map((e: { id: number }) => e.id);
      const all = hydrate(h.memory.store.listSourceEntries(1), h.memory.store);
      expect(ids).toEqual(all.slice(previous, previous + ids.length).map(e => e.id));
      const sent = batchText(h.conversations[3 * batch]!.messages[0]!.content as string); // note, memory, terminal reply
      expect(sent).toBe(ids.map(id => renderEntry(h.memory.store.getSourceEntry(id)!, h.memory.config.render).content).join("\n\n"));
      expect(tokens(sent)).toBeLessThanOrEqual(cap);
      if (batch < 2) expect(tokens(sent + "\n\n" + renderEntry(all[previous + ids.length]!, h.memory.config.render).content)).toBeGreaterThan(cap);
      previous += ids.length;
      expect(new Set(ids.map(id => h.memory.store.getSourceEntry(id)!.turnId)).size)[severalTurns ? "toBeGreaterThan" : "toBe"](1);
      await h.emit("agent_settled"); await h.drain();
      expect(h.conversations).toHaveLength(3 * (batch + 1)); // settling and completion of the worker start nothing
      if (batch < 2) { h.persist(reply(`completion ${batch}`)); await h.emit("agent_end"); await h.drain(); }
    }
    expect(hydrate(h.memory.pendingEntries(1, "main", head), h.memory.store)).toEqual([]);
  } finally { await h.dispose(); }
}, 30000);

test("17b 2026-09-08: model capacity reduces the prefix and an oversized oldest entry stays pending with a report", async () => {
  // 30: two 2,000-token views no longer reach the default trigger on their own, so it is lowered.
  const h = host({ "noting.forkModeDefault": false, "noting.triggerTokens": 30 });
  try {
    h.persist({ role: "user", content: "word ".repeat(15000), timestamp: 1 });
    h.persist(reply("word ".repeat(15000)));
    await h.emit("session_start");
    // Price the current shared prompt/schema, not the pre-92 fixed overhead. The remaining
    // 3k holds one 2k entry and framing, but not two entries. Production limits are unchanged.
    const fixed = tokens(loadPrompt("noting.md")) + tokens(JSON.stringify(toolDefinitions));
    const fittingWindow = fixed + 3_000 + CONTEXT_HEADROOM;
    h.ctx.model = { ...h.ctx.model!, contextWindow: fittingWindow };
    h.persist(reply("completion")); await h.emit("agent_end"); await h.drain();
    expect(h.requests).toHaveLength(3); // note, memory, terminal reply
    expect(JSON.parse(h.memory.store.listRuns(1)[0]!.response!).entryAudit.entries).toHaveLength(1);
    // 27a, replacing the whole-body estimate plus output reserve: what the child really sent had to
    // satisfy the one rule, measured as Pi measures the child's context — its messages, with no
    // assistant usage yet on a first round — with the headroom left over.
    expect(estimateContextTokens(conversationOf(h.requests[0]).messages as never).tokens + CONTEXT_HEADROOM).toBeLessThanOrEqual(fittingWindow);
    const pending = hydrate(h.memory.pendingEntries(1, "main", 1), h.memory.store);
    // Fixed instructions/tools still fit, but the remaining 1k cannot hold the oldest 2k view.
    h.ctx.model = { ...h.ctx.model!, contextWindow: fixed + 1_000 + CONTEXT_HEADROOM };
    h.persist(reply("next completion")); await h.emit("agent_end"); await h.drain();
    expect(h.requests).toHaveLength(3); // the refused admission adds none
    expect(hydrate(h.memory.pendingEntries(1, "main", 1), h.memory.store).slice(0, pending.length)).toEqual(pending);
    expect(h.notices.join("\n")).toContain("Noting capacity: selected evidence cannot fit the model context");
  } finally { await h.dispose(); }
});

// Retired C's rendered-fact trigger has no replacement: N writes knowledge with facts.
// D's independent due predicate is pending Knowledge, not a count or size of old facts.
test("D admits a real pending Knowledge pool on an entry without consuming pending Raw", async () => {
  const h = host({ "noting.triggerTokens": 1_000_000_000 });
  try {
    await h.turn();
    const fact = h.memory.tools({ kind: "manual", sessionId: 1, branch: "main", currentTurnId: 1 })[2]!
      .execute({ facts: [{ text: "User chose pnpm", source: ["T1#E1"] }] });
    expect(fact).not.toContain("rejected:");
    const path = { sessionId: 1, branch: "main", headTurnId: 1 };
    const trigger = createDreamerTrigger(h.memory, path, 1, 1);
    expect(h.memory.taskEligibility("dreaming", path).due).toBe(true);
    h.provider(async c => {
      if (c.messages.some(m => m.role === "toolResult")) return reply("Done.");
      const frozen = String(c.messages[0]!.content);
      const version = frozen.match(/New (K\d+@v\d+)/)?.[1];
      if (!version || version !== `K${trigger.knowledgeId}@v1`) throw new Error(`unexpected frozen D range: ${frozen.slice(0, 400)}`);
      return { ...reply(""), stopReason: "toolUse", content: [{ type: "toolCall", id: "memory-1", name: "memory",
        arguments: { operations: [], skipped: [{ knowledge: version, because: "Reviewed; retain" }] } }] };
    });
    h.persist(reply("new completed entry")); await h.emit("agent_end"); await h.drain();
    expect(h.memory.store.listRuns(1).filter(r => r.kind === "dreaming").map(r => r.outcome)).toEqual(["success"]);
    expect(h.memory.pendingEntries(1, "main", 1).length).toBeGreaterThan(0);
  } finally { await h.dispose(); }
});

test("17b 2026-09-08: lifecycle hooks launch neither phase and preserve both pending queues", async () => {
  const h = host({ "noting.forkModeDefault": false });
  try {
    h.persist({ role: "user", content: "word ".repeat(20000), timestamp: 1 }); h.persist(reply("pending"));
    await h.emit("session_start");
    h.memory.tools({ kind: "manual", sessionId: 1, branch: "main", currentTurnId: 1 })[2]!.execute({ facts: Array.from({ length: 50 }, (_, i) => ({ text: `claim ${i}`, source: ["T1#E1"] })) });
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

test.each(["user", "toolResult"])("17b 2026-09-08: stale branch capture falls back with the newly completed %s evidence", async role => {
  // 20b: the batch ceiling is 10,000, so the material is scaled to one batch that still holds the
  // whole frozen set; the trigger is scaled with it. What is pinned here is the fallback, not a size.
  const h = host({ "noting.forkModeDefault": true, "noting.triggerTokens": 1000 });
  try {
    await h.turn();
    await h.emit("before_provider_request", { payload: { model: "test", messages: [{ role: "user", content: "old prefix" }] } });
    if (role === "user") await h.prompt("NEW USER EVIDENCE " + "word ".repeat(2000));
    else {
      // Large natural-language pending material is below threshold until a tool result completes.
      h.persist(reply("word ".repeat(900))); await h.emit("agent_end");
      h.persist({ ...reply(""), content: [{ type: "toolCall", id: "new-call", name: "read", arguments: { path: "file" } }] });
      h.persist({ role: "toolResult", toolCallId: "new-call", toolName: "read", content: [{ type: "text", text: "NEW TOOL EVIDENCE " + "word ".repeat(2000) }], timestamp: 1 });
    }
    if (role === "user") {
      await h.emit("message_start", { message: reply("") });
    } else {
      // Another bounded assistant entry crosses the trigger; the missing tool result stays in the frozen set.
      h.persist(reply("word ".repeat(100))); await h.emit("agent_end");
    }
    await h.drain();
    expect(h.requests).toHaveLength(3); // note, memory, terminal reply
    const sent = h.conversations[0]!.messages[0]!.content as string;
    expect(sent).toContain(role === "user" ? "NEW USER EVIDENCE" : "NEW TOOL EVIDENCE");
    const run = h.memory.store.listRuns(1)[0]!;
    expect(run.mode).toBe("subagent");
    // 19c: the request-copy runner's "captured prefix does not contain the selected source entries"
    // check went with it. It existed because that runner replayed a captured body that could predate
    // the evidence it claimed to cover; a fork instead branches the parent's persisted ancestry, so
    // the newly completed entries are in the child's context by construction. This fake host has no
    // persisted parent file at all, so the task falls back to fresh context with the whole evidence.
    expect(JSON.parse(run.response!).fallbackReason).toContain("native runner:");
    expect(hydrate(h.memory.pendingEntries(1, "main", role === "user" ? 2 : 1), h.memory.store)).toEqual([]);
  } finally { await h.dispose(); }
});

// 27b moved the second half of this case — a fork whose inherited prefix does not fit — to
// `fallback.test.ts`: that batch is no longer left pending but re-admitted once as a subagent.
// 86 makes the batch cap soft for the oldest entry; model input capacity remains hard.
test("86: the oldest entry crosses the soft batch budget", async () => {
  // 30: one entry view is capped at 2,000 tokens, so the ceiling this entry must exceed is smaller,
  // and the trigger is lowered with it — 2,000 tokens of pending Raw no longer reach the default one.
  const h = host({ "noting.batchTokens": 1000, "noting.triggerTokens": 30 });
  try {
    h.persist({ role: "user", content: "word ".repeat(20000), timestamp: 1 }); h.persist(reply("tail"));
    await h.emit("session_start");
    h.persist(reply("completion")); await h.emit("agent_end"); await h.drain();
    const all = hydrate(h.memory.store.listSourceEntries(1), h.memory.store);
    const runs = h.memory.store.listRuns(1).filter(run => run.kind === "noting");
    expect(runs).toHaveLength(1);
    expect(h.requests).toHaveLength(3);
    expect(JSON.parse(runs[0]!.response!).entryAudit.entries.map((entry: { id: number }) => entry.id)).toEqual([all[0]!.id]);
    expect(tokens(renderEntry(all[0]!, h.memory.config.render).content)).toBeGreaterThan(1000);
    expect(hydrate(h.memory.pendingEntries(1, "main", 1), h.memory.store).map(e => e.id)).toEqual(all.slice(1).map(e => e.id));
  } finally { await h.dispose(); }
});

test("17b 2026-09-08: capture after compaction does not claim the persisted original prefix", async () => {
  const h = host({ "noting.forkModeDefault": true, "noting.triggerTokens": 2500 }); // 20b: one 10,000-token batch still holds all of it
  try {
    await h.prompt("old pending evidence " + "word ".repeat(2000)); await h.answer("old reply");
    const compact = (await h.emit("session_before_compact", { preparation: { tokensBefore: 9000 } })).compaction.summary;
    const entry = { id: "compact", parentId: h.entries.at(-1)!.id, timestamp: "now", type: "compaction", summary: compact, firstKeptEntryId: "", tokensBefore: 9000 };
    h.entries.push(entry); h.allEntries.push(entry);
    await h.emit("session_compact", { compactionEntry: entry });
    await h.emit("before_provider_request", { payload: { model: "test", messages: [{ role: "user", content: compact }] } });
    h.persist(reply("word ".repeat(800))); await h.emit("agent_end"); await h.drain();
    expect(h.requests).toHaveLength(3); // note, memory, terminal reply
    expect(h.conversations[0]!.messages[0]!.content).toContain("old pending evidence");
    const run = h.memory.store.listRuns(1)[0]!;
    expect(run.mode).toBe("subagent");
    // 27c/29c: the compaction kept no earlier entry, so the pending evidence is in no representation
    // the inherited context holds; this admission is the one that refuses the fork — and the reason it
    // names is the run's, on the model that ran it.
    expect(JSON.parse(run.response!).fallbackReason).toContain("Raw availability: entry 1 ");
    expect(hydrate(h.memory.pendingEntries(1, "main", 1), h.memory.store)).toEqual([]);
  } finally { await h.dispose(); }
});

test("17b 2026-09-08: facade infers the source path before a Turn is fully recorded", async () => {
  const h = host({ "noting.triggerTokens": 1000000000 });
  const runner = TraceMemory(join(h.dir, "trace.db"), async raw => {
    const input = raw as NotingAgentInput;
    input.reportRequest({ exact: true });
    if (input.kind === "noting") {
      input.tools.find(tool => tool.name === "note")!.execute({ facts: [{ text: "partial source fact", source: ["T1#E1"] }] });
      input.tools.find(tool => tool.name === "memory")!.execute({ operations: [], skipped: [] });
    }
    return { outcome: "success", output: "", request: { exact: true } };
  }, { noting: { batchTokens: 100, forkModeDefault: false } });
  try {
    await h.prompt("user source"); await h.answer("word ".repeat(1000));
    expect((await runner.noting({ sessionId: 1, branch: "main", headTurnId: 1 })).outcome).toBe("success");
    expect(hydrate(h.memory.pendingEntries(1, "main", 1), h.memory.store).map(e => e.role)).toEqual(["assistant"]);
    expect(h.memory.store.listSessionFacts(1).map(f => f.id)).toEqual([1]);
    expect(h.memory.store.listRuns(1).some(run => run.kind === "consolidation")).toBe(false);
  } finally { runner.close(); await h.dispose(); }
});

test("17b 2026-09-08, on 27a's rule: a round the child's own context cannot hold is refused before sending or advancing entries", async () => {
  const h = host({ "noting.triggerTokens": 30, "noting.forkModeDefault": false });
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
  // 30: the near-ceiling entry is the one the renderer caps at `render.entryTokens` (2,000), so the
  // batch ceiling this case needs is that cap — the small oldest cannot fit beside it either way.
  const h = host({ "noting.forkModeDefault": false, "noting.triggerTokens": 30, "noting.batchTokens": 2000 });
  try {
    h.persist({ role: "user", content: "small oldest", timestamp: 1 });
    h.persist(reply("BIG " + "word ".repeat(15000))); // the renderer bounds this at the entry cap
    h.persist(reply("small later"));
    await h.emit("session_start");
    const all = hydrate(h.memory.store.listSourceEntries(1), h.memory.store);
    expect(tokens(renderEntry(all[1]!, h.memory.config.render).content)).toBe(DEFAULT_CONFIG.render.entryTokens);
    h.persist(reply("completion")); await h.emit("agent_end"); await h.drain();
    const noted = (n: number) => JSON.parse(h.memory.store.listRuns(1).filter(r => r.kind === "noting")[n]!.response!).entryAudit.entries.map((e: { id: number }) => e.id);
    expect(noted(0)).toEqual([all[0]!.id]); // the oldest alone: the near-ceiling entry does not fit beside it
    expect(hydrate(h.memory.pendingEntries(1, "main", 1), h.memory.store).map(e => e.id).slice(0, 2)).toEqual([all[1]!.id, all[2]!.id]);
    h.persist(reply("completion 2")); await h.emit("agent_end"); await h.drain();
    expect(noted(1)).toEqual([all[1]!.id]); // the big entry is taken next, not skipped for the small later one
  } finally { await h.dispose(); }
});

// Retired C-only fact-capacity admission has no live worker. N's oldest-entry and per-round
// capacity refusals above remain active; D's real pending-version admission is exercised here.
