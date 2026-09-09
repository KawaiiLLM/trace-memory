import { expect, test } from "vitest";
import { TraceMemory, renderEntry, tokens, DEFAULT_CONFIG, type SourceEntry, type NotingAgentInput } from "../../../src/core/api/index.ts";
import { join } from "node:path";
import { host, reply } from "./test-host.ts";

const view = (text: string, nativeId: string, role: "user" | "assistant") => renderEntry({ id: 1, sessionId: 1, nativeLineage: "pi-test", nativeId, turnId: 1, role, text, raw: "", calls: [] } as SourceEntry, DEFAULT_CONFIG.render).content;
const batchText = (input: string) => input.split("Raw:\n\n")[1]!.split("\n\nReceipts:")[0]!;

test.each([9999, 10000])("17b 2026-09-08: Noting threshold is exactly compressed tokens (%s)", async size => {
  const h = host({ "noting.forkModeDefault": false });
  try {
    const overhead = tokens(view("", "u", "user") + "\n\n" + view("a", "a", "assistant"));
    let content = "word ".repeat(size - overhead);
    while (tokens(view(content, "u", "user") + "\n\n" + view("a", "a", "assistant")) < size) content += "word ";
    while (tokens(view(content, "u", "user") + "\n\n" + view("a", "a", "assistant")) > size) content = content.slice(5);
    h.persist({ role: "user", content, timestamp: 1 }, "u");
    h.persist({ ...reply(""), content: [{ type: "thinking", thinking: "private" }] }, "thinking");
    await h.emit("session_start");
    h.persist(reply("a"), "a");
    await h.emit("message_start", { message: reply("") });
    await h.drain();
    const entries = h.memory.store.listSourceEntries(1);
    expect(tokens(entries.map(e => renderEntry(e, h.memory.config.render).content).join("\n\n"))).toBe(size);
    expect(h.requests).toHaveLength(size === 10000 ? 1 : 0);
    expect(h.memory.pendingEntries(1, "main", 1)).toHaveLength(size === 10000 ? 0 : 2);
  } finally { await h.dispose(); }
});

test.each([false, true])("17b 2026-09-08 (batch ceiling superseded by 20b): oldest whole-entry batches cross Turns or split one Turn (%s), with no completion chaining", async severalTurns => {
  const h = host({ "noting.forkModeDefault": false, "noting.triggerTokens": 20 });
  const cap = DEFAULT_CONFIG.noting.batchTokens; // 20b: 10,000, not 17b's 50,000
  try {
    h.persist({ role: "user", content: "start", timestamp: 1 });
    for (let i = 0; i < 8; i++) {
      if (severalTurns && i) h.persist({ role: "user", content: `turn ${i}`, timestamp: 1 });
      h.persist(reply(`entry ${i} ` + "word ".repeat(3000)));
    }
    await h.emit("session_start"); // importing history is not a completion trigger
    const head = h.memory.store.listTurns(1).at(-1)!.id;
    const initial = h.memory.pendingEntries(1, "main", head);
    expect(tokens(initial.map(e => renderEntry(e, h.memory.config.render).content).join("\n\n"))).toBeGreaterThan(2 * cap);
    h.persist(reply("new completion")); await h.emit("agent_end"); await h.drain();
    let previous = 0;
    for (let batch = 0; batch < 3; batch++) {
      const run = h.memory.store.listRuns(1).filter(r => r.kind === "noting")[batch]!;
      const ids: number[] = JSON.parse(run.response!).entryAudit.entries.map((e: { id: number }) => e.id);
      const all = h.memory.store.listSourceEntries(1);
      expect(ids).toEqual(all.slice(previous, previous + ids.length).map(e => e.id));
      const sent = batchText(h.conversations[batch]!.messages[0]!.content as string);
      expect(sent).toBe(ids.map(id => renderEntry(h.memory.store.getSourceEntry(id)!, h.memory.config.render).content).join("\n\n"));
      expect(tokens(sent)).toBeLessThanOrEqual(cap);
      if (batch < 2) expect(tokens(sent + "\n\n" + renderEntry(all[previous + ids.length]!, h.memory.config.render).content)).toBeGreaterThan(cap);
      previous += ids.length;
      expect(new Set(ids.map(id => h.memory.store.getSourceEntry(id)!.turnId)).size)[severalTurns ? "toBeGreaterThan" : "toBe"](1);
      await h.emit("agent_settled"); await h.drain();
      expect(h.conversations).toHaveLength(batch + 1); // settling and completion of the worker start nothing
      if (batch < 2) { h.persist(reply(`completion ${batch}`)); await h.emit("agent_end"); await h.drain(); }
    }
    expect(h.memory.pendingEntries(1, "main", head)).toEqual([]);
  } finally { await h.dispose(); }
}, 30000);

test("17b 2026-09-08: model capacity reduces the prefix and an oversized oldest entry stays pending with a report", async () => {
  const h = host({ "noting.forkModeDefault": false });
  try {
    h.persist({ role: "user", content: "word ".repeat(15000), timestamp: 1 });
    h.persist(reply("word ".repeat(15000)));
    await h.emit("session_start");
    h.ctx.model = { ...h.ctx.model!, contextWindow: 24000, maxTokens: 1000 };
    h.persist(reply("completion")); await h.emit("agent_end"); await h.drain();
    expect(h.requests).toHaveLength(1);
    expect(JSON.parse(h.memory.store.listRuns(1)[0]!.response!).entryAudit.entries).toHaveLength(1);
    expect(tokens(JSON.stringify(h.requests[0])) + 1000).toBeLessThanOrEqual(Math.floor(24000 * 0.85));
    const pending = h.memory.pendingEntries(1, "main", 1);
    h.ctx.model = { ...h.ctx.model!, contextWindow: 1000, maxTokens: 500 };
    h.persist(reply("next completion")); await h.emit("agent_end"); await h.drain();
    expect(h.requests).toHaveLength(1);
    expect(h.memory.pendingEntries(1, "main", 1).slice(0, pending.length)).toEqual(pending);
    expect(h.notices.join("\n")).toContain("Noting capacity: oldest entry cannot fit");
  } finally { await h.dispose(); }
});

// 20b supersedes 17b's "49 facts wait, 50 immediately committed facts trigger": the count is gone and
// the same test now measures the rendered fact tokens the Consolidator would actually receive. Facts
// still become eligible immediately, and a still-pending same-Turn source still does not hold them.
test("20b 2026-09-08 scenario 6: many short facts below the trigger wait, the tokens that reach it start one Consolidation despite pending same-Turn sources", async () => {
  const h = host({ "noting.forkModeDefault": false });
  const trigger = DEFAULT_CONFIG.consolidation.triggerTokens; // 5,000 rendered fact tokens, not fifty facts
  try {
    await h.turn();
    const write = (n: number, size = 1) => h.memory.tools({ kind: "manual", sessionId: 1, branch: "main", currentTurnId: 1 })[2]!.execute({ facts: Array.from({ length: n }, (_, i) => ({ category: "observation", actor: "user", text: `claim ${i} ` + "word ".repeat(size), source: ["T1#user"] })) });
    write(50); // fifty facts under 17b's rule; far below 5,000 rendered tokens
    const rendered = () => tokens(h.memory.store.consolidationBatch(1, "main", 1).map(f => h.memory.trace(`F${f.id}`)).join("\n"));
    expect(rendered()).toBeLessThan(trigger);
    h.persist(reply("completed entry")); await h.emit("agent_end"); await h.drain();
    expect(h.requests).toEqual([]);
    write(4, 1000); // four long facts carry more context than the fifty short ones
    expect(rendered()).toBeGreaterThanOrEqual(trigger);
    await h.emit("agent_settled"); await h.drain(); expect(h.requests).toEqual([]);
    h.persist(reply("another entry")); await h.emit("agent_end"); await h.drain();
    expect(h.requests).toHaveLength(1);
    expect(h.memory.store.listConsolidatedFacts(h.memory.store.listRuns(1).at(-1)!.id)).toHaveLength(54);
    expect(h.memory.pendingEntries(1, "main", 1).length).toBeGreaterThan(0);
    h.persist(reply("later entry")); await h.emit("agent_end"); await h.drain();
    expect(h.requests).toHaveLength(1);
  } finally { await h.dispose(); }
});

test("17b 2026-09-08: lifecycle hooks launch neither phase and preserve both pending queues", async () => {
  const h = host({ "noting.forkModeDefault": false });
  try {
    h.persist({ role: "user", content: "word ".repeat(20000), timestamp: 1 }); h.persist(reply("pending"));
    await h.emit("session_start");
    h.memory.tools({ kind: "manual", sessionId: 1, branch: "main", currentTurnId: 1 })[2]!.execute({ facts: Array.from({ length: 50 }, (_, i) => ({ category: "observation", actor: "user", text: `claim ${i}`, source: ["T1#user"] })) });
    const pending = h.memory.pendingEntries(1, "main", 1);
    const summary = await h.emit("session_before_tree");
    expect(summary.summary.summary).toBe(h.memory.branchSummary(1, "main", 1));
    await h.emit("session_before_compact", { preparation: { tokensBefore: 100000 } });
    await h.emit("session_shutdown");
    expect(h.requests).toEqual([]);
    expect(h.memory.pendingEntries(1, "main", 1)).toEqual(pending);
    expect(h.memory.store.consolidationBatch(1, "main", 1)).toHaveLength(50);
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

// Ticket 20 "Configuration" and acceptance scenario 17. The new Consolidation limits are ordinary
// settings of the existing namespace, and the fact count is a removed key: it is not reinterpreted as
// tokens through the alias table, and it is shown nowhere, because the menu is built from the defaults.
test("20b 2026-09-08 scenario 17: the new token settings validate and layer, and the removed fact-count key errors by name", () => {
  expect(DEFAULT_CONFIG.consolidation).toMatchObject({ triggerTokens: 5000, batchTokens: 10000 });
  // The ruled ceiling of fresh material: 10,000 knowledge plus 20,000 shared episodic.
  expect(DEFAULT_CONFIG.render.knowledgeBlockTokens + DEFAULT_CONFIG.render.episodicBlockTokens).toBe(30_000);
  for (const key of ["triggerTokens", "batchTokens"]) for (const value of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => TraceMemory(":memory:", async () => ({ outcome: "success", output: "", request: {} }), { consolidation: { [key]: value } })).toThrow(`Invalid consolidation.${key}`);
    expect(() => host({ [`consolidation.${key}`]: value })).toThrow(`consolidation.${key}`);
  }
  const removed = "Removed setting consolidation.triggerUnconsolidatedFacts: use consolidation.triggerTokens (tokens, not a count)";
  expect(() => TraceMemory(":memory:", async () => ({ outcome: "success", output: "", request: {} }), { consolidation: { triggerUnconsolidatedFacts: 50 } } as never)).toThrow(removed);
  expect(() => host({ "consolidation.triggerUnconsolidatedFacts": 50 })).toThrow(removed);
  // A supplied override reaches the effective configuration under its own name.
  const memory = TraceMemory(":memory:", async () => ({ outcome: "success", output: "", request: {} }), { consolidation: { triggerTokens: 7, batchTokens: 11 } });
  try { expect(memory.config.consolidation).toMatchObject({ triggerTokens: 7, batchTokens: 11 }); } finally { memory.close(); }
});

test.each(["user", "toolResult"])("17b 2026-09-08: stale branch capture falls back with the newly completed %s evidence", async role => {
  // 20b: the batch ceiling is 10,000, so the material is scaled to one batch that still holds the
  // whole frozen set; the trigger is scaled with it. What is pinned here is the fallback, not a size.
  const h = host({ "noting.triggerTokens": 1000 });
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
    expect(h.requests).toHaveLength(1);
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
    expect(h.memory.pendingEntries(1, "main", role === "user" ? 2 : 1)).toEqual([]);
  } finally { await h.dispose(); }
});

test.each(["batch", "native prefix"])("17b 2026-09-08: an oldest entry blocked by the %s budget stays pending", async limit => {
  const h = host(limit === "batch" ? { "noting.batchTokens": 9000 } : {});
  try {
    h.persist({ role: "user", content: "word ".repeat(20000), timestamp: 1 }); h.persist(reply("tail"));
    await h.emit("session_start");
    if (limit === "native prefix") {
      h.ctx.model = { ...h.ctx.model!, contextWindow: 30000, maxTokens: 1000 };
      await h.emit("before_provider_request", { payload: { model: "test", messages: [{ role: "user", content: "word ".repeat(30000) }] } });
    }
    h.persist(reply("completion")); await h.emit("agent_end"); await h.drain();
    expect(h.requests).toEqual([]);
    expect(h.memory.store.listRuns(1)).toEqual([]);
    expect(h.memory.pendingEntries(1, "main", 1).map(e => e.nativeId)).toEqual(h.memory.store.listSourceEntries(1).map(e => e.nativeId));
    expect(h.notices.join("\n")).toContain(limit === "batch" ? "oldest entry exceeds noting.batchTokens" : "oldest entry cannot fit the episodic budget or the model context");
  } finally { await h.dispose(); }
});

test("17b 2026-09-08: capture after compaction does not claim the persisted original prefix", async () => {
  const h = host({ "noting.triggerTokens": 2500 }); // 20b: one 10,000-token batch still holds all of it
  try {
    await h.prompt("old pending evidence " + "word ".repeat(2000)); await h.answer("old reply");
    const compact = (await h.emit("session_before_compact", { preparation: { tokensBefore: 9000 } })).compaction.summary;
    const entry = { id: "compact", parentId: h.entries.at(-1)!.id, timestamp: "now", type: "compaction", summary: compact, firstKeptEntryId: "", tokensBefore: 9000 };
    h.entries.push(entry); h.allEntries.push(entry);
    await h.emit("session_compact", { compactionEntry: entry });
    await h.emit("before_provider_request", { payload: { model: "test", messages: [{ role: "user", content: compact }] } });
    h.persist(reply("word ".repeat(800))); await h.emit("agent_end"); await h.drain();
    expect(h.requests).toHaveLength(1);
    expect(h.conversations[0]!.messages[0]!.content).toContain("old pending evidence");
    const run = h.memory.store.listRuns(1)[0]!;
    expect(run.mode).toBe("subagent");
    expect(JSON.parse(run.response!).fallbackReason).toContain("native runner:"); // as above: no fork here, fresh context, complete evidence
    expect(h.memory.pendingEntries(1, "main", 1)).toEqual([]);
  } finally { await h.dispose(); }
});

test("17b 2026-09-08: facade infers the source path before a Turn is fully recorded", async () => {
  const h = host({ "noting.triggerTokens": 1000000000 });
  const runner = TraceMemory(join(h.dir, "trace.db"), async raw => {
    const input = raw as NotingAgentInput;
    input.reportRequest({ exact: true });
    if (input.kind === "noting") input.tools[2]!.execute({ facts: [{ category: "observation", actor: "user", text: "partial source fact", source: ["T1#user"] }] });
    return { outcome: "success", output: "", request: { exact: true } };
  }, { noting: { batchTokens: 100, forkModeDefault: false } });
  try {
    await h.prompt("user source"); await h.answer("word ".repeat(1000));
    expect((await runner.noting({ sessionId: 1, branch: "main", headTurnId: 1 })).outcome).toBe("success");
    expect(h.memory.pendingEntries(1, "main", 1).map(e => e.role)).toEqual(["assistant"]);
    const result = await runner.consolidate({ sessionId: 1, branch: "main" });
    expect(result.outcome).toBe("success");
    expect("range" in result && result.range.facts.map(f => f.id)).toEqual([1]);
  } finally { runner.close(); await h.dispose(); }
});

test("17b 2026-09-08: native payload overhead is capacity-checked before sending or advancing entries", async () => {
  const h = host({ "noting.triggerTokens": 20, "noting.forkModeDefault": false });
  try {
    // The overhead is real now (19c): core prices the material it froze, while the body the child
    // actually sends also carries the domain system prompt and the four tool schemas. This window
    // admits the material and cannot hold the body.
    h.ctx.model = { ...h.ctx.model!, contextWindow: 6200, maxTokens: 500 };
    await h.prompt("word ".repeat(500)); await h.answer("word ".repeat(500));
    await h.emit("agent_settled"); await h.drain();
    expect(h.requests).toEqual([]);
    expect(h.memory.pendingEntries(1, "main", 1).map(e => e.role)).toEqual(["user", "assistant"]);
    const run = h.memory.store.listRuns(1)[0]!;
    expect(run.outcome).toBe("failure");
    expect(JSON.parse(run.response!).problems.join("\n")).toContain("provider request exceeds model context");
  } finally { await h.dispose(); }
});

// Ticket 20 "Noting" and acceptance scenario 5. The batch is the oldest contiguous whole-entry prefix
// that fits: an entry that does not fit beside the oldest one is not dropped, and no smaller later
// entry is pulled forward to fill the space it left.
test("20b 2026-09-08 scenario 5: a small oldest entry is not joined with a near-ceiling entry, and no smaller later entry jumps the queue", async () => {
  const h = host({ "noting.forkModeDefault": false, "noting.triggerTokens": 20 });
  try {
    h.persist({ role: "user", content: "small oldest", timestamp: 1 });
    h.persist(reply("BIG " + "word ".repeat(15000))); // the primary renderer bounds this at the 10,000-token entry cap
    h.persist(reply("small later"));
    await h.emit("session_start");
    const all = h.memory.store.listSourceEntries(1);
    expect(tokens(renderEntry(all[1]!, h.memory.config.render).content)).toBe(DEFAULT_CONFIG.render.entryTokens);
    h.persist(reply("completion")); await h.emit("agent_end"); await h.drain();
    const noted = (n: number) => JSON.parse(h.memory.store.listRuns(1).filter(r => r.kind === "noting")[n]!.response!).entryAudit.entries.map((e: { id: number }) => e.id);
    expect(noted(0)).toEqual([all[0]!.id]); // the oldest alone: the near-ceiling entry does not fit beside it
    expect(h.memory.pendingEntries(1, "main", 1).map(e => e.id).slice(0, 2)).toEqual([all[1]!.id, all[2]!.id]);
    h.persist(reply("completion 2")); await h.emit("agent_end"); await h.drain();
    expect(noted(1)).toEqual([all[1]!.id]); // the big entry is taken next, not skipped for the small later one
  } finally { await h.dispose(); }
});

test("review 2026-09-08: Consolidation negotiates the model's real capacity like Noting and never sends a request the window cannot hold", async () => {
  const h = host({ "noting.triggerTokens": 1e9 });
  try {
    await h.turn();
    const note = h.memory.tools({ kind: "manual", sessionId: 1, branch: "main", currentTurnId: 1 }).find(t => t.name === "note")!;
    expect(note.execute({ facts: [{ category: "observation", actor: "user", text: "Large evidence " + "word ".repeat(6000), source: ["T1#user"] }] })).toContain("ok: F1");
    h.ctx.model = { ...h.ctx.model!, contextWindow: 2000, maxTokens: 64 };
    h.persist(reply("new completion")); await h.emit("agent_end"); await h.drain();
    expect(h.requests).toHaveLength(0); // the oldest fact cannot fit a 2,000-token window: pending, not sent
    expect(h.notices.some(n => n.includes("Consolidation capacity"))).toBe(true);
    expect(h.memory.store.consolidationBatch(1, "main", 1)).toHaveLength(1);
  } finally { await h.dispose(); }
});
