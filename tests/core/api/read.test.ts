import { afterEach, beforeEach, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { sourceSeededMemory, compacted, renderEntry, tokens, ENTRY_VIEW_VERSION } from "../../source-fixture.ts";

const fixture = JSON.parse(readFileSync(new URL("../../fixtures/noting/facts.json", import.meta.url), "utf8"));
const rawFixture = JSON.parse(readFileSync(new URL("../../fixtures/noting/turns.json", import.meta.url), "utf8"));
const time = "2026-09-06T00:00:00Z";
let memory: ReturnType<typeof sourceSeededMemory>, calls: number;
// 26a: a Noting run completes its batch by submitting; with nothing to record it sends `{facts: []}`.
beforeEach(() => { calls = 0; memory = sourceSeededMemory(":memory:", async raw => { calls++;
  const input = raw as { kind: string; tools: { name: string; execute(input: unknown): string }[] };
  if (input.kind === "noting") input.tools.find(tool => tool.name === "note")!.execute({ facts: [] });
  return { outcome: "success", output: [], request: {} }; }); });
afterEach(() => memory.close());
function session(projectId?: number, declaration: "marker" | "undeclared" = "marker") {
  const project = projectId ?? memory.store.createProject({ name: "mapC", declaredBy: "marker" }).id;
  return memory.store.createSession({ enrollmentChoice: true, host: "fake", startedAt: time, firstReplyAt: time, projectId: project, projectDeclaration: declaration });
}
function turn(sessionId: number, text = fixture.base, parentTurnId?: number) {
  return memory.store.appendTurn({ sessionId, userPrompt: text, assistantText: null, parentTurnId, kind: "turn", startedAt: time });
}
function noting(sessionId: number, turnId: number, text = fixture.base, branch = "main") {
  const result = memory.store.commitNotingRun({ run: { sessionId, branch, kind: "noting", createdAt: time },
    facts: [{ turnId, text, category: "decision", actor: "user", source: [`T${turnId}#user`], createdAt: time }],
    entryIds: memory.store.sourcePath(sessionId, branch, turnId).map(e => e.id) });
  if (!result.ok) throw new Error(result.problems.join("\n"));
  return result;
}
function knowledge(sessionId: number, factId: number, category: "constraint" | "open" | "dispute" | "goal" | "mechanism" | "term" | "reference" = "constraint",
  scope: "session" | "project" | "global" = "project", text = fixture.knowledge, createdAt = time, topics: string[] = []) {
  const result = memory.store.commitConsolidationRun({ run: { sessionId, branch: "main", kind: "consolidation", createdAt: time },
    operations: [{ op: "create", topics, reason: "Initial admission of this conclusion.", handle: "$e1", author: "fake", text, category, scope, supports: [factId], createdAt }],
    consolidated: memory.store.getSession(sessionId)!.projectId === memory.store.getSession(memory.store.getTurn(memory.store.getFact(factId)!.turnId)!.sessionId)!.projectId ? [factId] : [] });
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.committed[0]!.knowledgeId;
}
function populated() {
  const s = session(), t = turn(s.id), n = noting(s.id, t.id), f = n.facts[0]!;
  const e = knowledge(s.id, f.id);
  return { s, t, f, e };
}
const golden = (name: string) => readFileSync(new URL(`../../fixtures/read/${name}.txt`, import.meta.url), "utf8").trimEnd();
/** 28a: what one custom replacement charged, window by window. A `native` delegation has none. */
const charged = (result: ReturnType<typeof memory.compact>) => {
  if ("native" in result) throw new Error(`expected a custom replacement, got: ${result.reason}`);
  return result.charged!;
};
/** 28a "Lending": the three windows are one envelope and a window needing less lends the difference,
 * so what a test controls is the sum, not one key. This sets the sum, keeping the knowledge window at
 * exactly what its block already charges — the required-material fit test measures knowledge at its
 * own baseline, so pinning it there leaves the envelope as the only thing that moves. */
const envelope = (total: number, knowledge: number) => {
  memory.config.render.knowledgeBlockTokens = Math.max(1, knowledge);
  memory.config.compaction.factsTokens = Math.max(0, Math.ceil((total - knowledge) / 2));
  memory.config.compaction.rawTokens = Math.max(0, Math.floor((total - knowledge) / 2));
};
const defaultWindows = () => {
  memory.config.render.knowledgeBlockTokens = 20_000;
  memory.config.compaction.factsTokens = 10_000;
  memory.config.compaction.rawTokens = 10_000;
};

test("injection and compaction match Chinese fixture goldens without a model call", () => {
  const { s, t } = populated();
  turn(s.id, rawFixture[1].userPrompt, t.id);
  expect(memory.inject(s.id)).toBe(golden("inject"));
  expect(compacted(memory.compact(s.id, "main"))).toBe(golden("compact"));
  expect(calls).toBe(0);
});

test("injection stays byte-identical across a zero-fact noting and has no XML attributes", async () => {
  const { s, t } = populated();
  const before = memory.inject(s.id), next = turn(s.id, fixture.observation, t.id);
  expect((await memory.noting({ sessionId: s.id, branch: "main", headTurnId: next.id })).outcome).toBe("success");
  expect(memory.inject(s.id)).toBe(before);
  for (const tag of before.match(/<[^>]+>/g)!) expect(tag).toMatch(/^<\/?[a-z_]+>$/);
});

test("visibility includes global, own project and own session only, excluding inactive knowledge", () => {
  const { s, f } = populated(), peer = session(s.projectId), foreign = session();
  const own = knowledge(s.id, f.id, "open", "session"), other = knowledge(peer.id, noting(peer.id, turn(peer.id).id).facts[0]!.id, "open", "session");
  const outside = knowledge(foreign.id, noting(foreign.id, turn(foreign.id).id).facts[0]!.id), global = knowledge(foreign.id, f.id, "goal", "global");
  const archived = knowledge(s.id, f.id, "reference");
  memory.store.commitConsolidationRun({ run: { sessionId: s.id, kind: "consolidation", createdAt: time },
    operations: [{ op: "archive", reason: "Retired: the cited evidence withdraws this conclusion.", knowledgeId: archived, baseCommit: archived, supports: [f.id], createdAt: time }] });
  for (const block of [memory.inject(s.id), compacted(memory.compact(s.id))]) {
    expect(block).toContain(`[K${own}@${own}]`); expect(block).toContain(`[K${global}@${global}]`);
    for (const id of [other, outside, archived]) expect(block).not.toContain(`[K${id}@`);
  }
});

test("category order, chronological ties, whole trailing category omissions; lines are never escaped", () => {
  const { s, f } = populated();
  const ids = ["reference", "term", "mechanism", "goal", "dispute", "open"].map((c) => knowledge(s.id, f.id, c as "goal"));
  const earlier = knowledge(s.id, f.id, "constraint", "project", "<&>", "2020");
  const all = memory.inject(s.id);
  expect(all.indexOf(`[K${earlier}@`)).toBeLessThan(all.indexOf("[K1@"));
  // Injected lines are trace lines byte for byte (ruling 15:14); tags only delimit blocks.
  expect(all).toContain("<&>");
  expect(all).not.toContain("&lt;");
  const tags = ["constraint", "open", "dispute", "goal", "mechanism", "term", "reference"];
  expect(tags.map((tag) => all.indexOf(`<${tag}>`))).toEqual(tags.map((tag) => all.indexOf(`<${tag}>`)).sort((a, b) => a - b));
  // 20b: the knowledge cap is hard — including the three categories 17b's exemption protected — and
  // hard for its receipt too (review 2026-09-08): a budget that cannot hold even the bounded receipt
  // of the omitted items is a capacity error, never an oversized block.
  memory.config.render.knowledgeBlockTokens = 0;
  expect(() => memory.inject(s.id)).toThrow(/Knowledge capacity/);
  // A budget that holds part of the list keeps a whole prefix of the priority order, receipts included.
  memory.config.render.knowledgeBlockTokens = 200;
  const partial = memory.inject(s.id);
  const kept = tags.filter(tag => partial.includes(`<${tag}>`));
  expect(kept.length).toBeGreaterThan(0);
  expect(kept).toEqual(tags.slice(0, kept.length));
  expect(partial.indexOf("Receipts:")).toBeGreaterThan(partial.indexOf("</knowledge>"));
  for (const id of ids.slice(0, 4)) expect(memory.trace(`K${id}`)).toContain(`[K${id}@${id}]`);
});

test("compaction retains oversized raw with standard tool cuts, in its bounded views", () => {
  const { s, t } = populated(), raw = fixture.observation.repeat(1000);
  const next = turn(s.id, raw, t.id);
  memory.store.appendToolCall({ turnId: next.id, name: "Bash", input: "pwd", result: JSON.stringify({ stdout: "x".repeat(10000) }), status: "success" });
  // 20c/30: a custom replacement applies only while the bounded views fit the shared cap. This case is
  // about those views' own cuts — `E` on the user text, `R` on the result — not about delegation, so
  // it gives the enclosing envelope the room; delegation has its own tests.
  memory.config.noting.batchTokens = 100_000; memory.config.render.episodicBlockTokens = 200_000;
  const compaction = memory.compact(s.id, "main", next.id);
  expect("native" in compaction).toBe(false);
  const result = compacted(compaction);
  // 17a supersedes unbounded user Raw: both excerpts retain head, omission count and tail.
  expect(result).not.toContain(raw); expect(result).toMatch(/\[\.\.\. \d+ characters truncated\]/);
  expect(result).toContain(raw.slice(0, 40)); expect(result).toContain(raw.slice(-40));
  expect(calls).toBe(0);
});

test("compaction uses supplied ancestry and newest facts fit before older facts", () => {
  const { s, t } = populated();
  const abandoned = turn(s.id, "abandoned raw", t.id), selected = turn(s.id, "selected raw", t.id);
  const precise = compacted(memory.compact(s.id, "main", selected.id));
  expect(precise).toContain("selected raw"); expect(precise).not.toContain("abandoned raw");
  // 17a: an omitted head resolves one path, never a union of sibling queues.
  expect(compacted(memory.compact(s.id))).not.toContain("abandoned raw");
  const n = noting(s.id, selected.id, fixture.interpretation);
  const whole = memory.compact(s.id, "main", selected.id);
  const full = compacted(whole);
  expect(full.indexOf("[F1]")).toBeLessThan(full.indexOf(`[F${n.facts[0]!.id}]`)); // chronological presentation
  // 28a: F1 is already consolidated, so it is refill (a) — optional material in the spare — while the
  // new fact is pending and required. An envelope that holds exactly the required material therefore
  // keeps the pending fact whole and leaves the older consolidated one out; the pending window is
  // never trimmed to make room for a refill.
  const windows = charged(whole);
  envelope(windows.knowledge + windows.required.facts + windows.required.raw, windows.knowledge);
  const limited = compacted(memory.compact(s.id, "main", selected.id));
  expect(limited).toContain(`[F${n.facts[0]!.id}]`); expect(limited).not.toContain("[F1]");
  defaultWindows();
  expect(memory.store.getTurn(abandoned.id)).not.toBeNull();
});

// ---- Ticket 20 "Compaction escalation" (20c), as 30 left it: the one bounded view over a frozen
// read snapshot, and the native delegation when it does not fit ----

test("20c 2026-09-08 scenario 9: all pending bounded views fit, historical facts take the remaining shared space, and no worker starts or progress changes", () => {
  const { s, t } = populated();
  const selected = turn(s.id, "selected raw", t.id);
  const second = noting(s.id, t.id, fixture.interpretation).facts[0]!; // a newer fact on an already-processed turn
  const pending = memory.pendingEntries(s.id, "main", selected.id);
  const runsBefore = memory.store.listRuns(s.id).length;
  const result = memory.compact(s.id, "main", selected.id);
  expect("native" in result).toBe(false);
  const text = compacted(result);
  // Every pending entry is present in its normal shared view, and both historical facts fit beside them.
  for (const entry of pending) expect(text).toContain(renderEntry(entry, memory.config.render).content);
  expect(text).toContain(`[F${second.id}]`); expect(text).toContain("[F1]");
  expect(text).not.toContain("compact-only");
  // Reading a snapshot is not extraction: no model call, no run, no progress, no claim.
  expect(calls).toBe(0);
  expect(memory.store.listRuns(s.id)).toHaveLength(runsBefore);
  expect(memory.pendingEntries(s.id, "main", selected.id).map(e => e.id)).toEqual(pending.map(e => e.id));
  // 28a: F1 is consolidated, so it refills the spare; the newer fact is pending and required. An
  // envelope holding the required material plus room for the refill's own omission receipt keeps the
  // pending fact, leaves F1 out and says so — the receipt sits outside the block, as every other does.
  const windows = charged(result);
  const receipt = tokens("omitted 1 older facts; expand: F1") + tokens("Receipts:") + 2;
  envelope(windows.knowledge + windows.required.facts + windows.required.raw + receipt, windows.knowledge);
  const limited = compacted(memory.compact(s.id, "main", selected.id));
  expect(limited).toContain(`[F${second.id}]`); expect(limited).not.toContain("[F1]");
  expect(limited).toContain("omitted 1 older facts; expand: F1");
  expect(limited.indexOf("Receipts:")).toBeGreaterThan(limited.indexOf("</episodic>"));
  defaultWindows();
});

test("20c/23 scenario 10, as 30 left it: one bounded view of every entry under the ordinary Raw title, and an envelope it cannot meet delegates to native compaction", () => {
  const { s, t } = populated();
  const body = "word ".repeat(12_000);
  // Three long prompts: each entry view is worth at most `render.entryTokens` (2,000 since 30), so
  // the two ahead of the inspected turn are ordinary pending entries and every one of them is cut.
  let parent = t.id;
  for (const i of [1, 2]) parent = turn(s.id, `FILLER_${i} ${body}`, parent).id;
  const next = turn(s.id, `USER_HEAD ${body} USER_TAIL`, parent);
  memory.store.appendToolCall({ turnId: next.id, name: "Bash", input: JSON.stringify({ command: "SECRET_ARGUMENT" }),
    result: JSON.stringify({ stdout: "SECRET_RESULT " + "x".repeat(4_000) }), status: "success" });
  const pending = memory.pendingEntries(s.id, "main", next.id);
  const result = memory.compact(s.id, "main", next.id);
  expect("native" in result).toBe(false);
  const text = compacted(result);
  // One view, one title: the tier-2 block title 23 introduced is gone with the tier itself (30).
  expect(text).toContain("\nRaw:\n");
  expect(text).not.toContain("tier-2 entry views");
  // Every selected entry is represented, in order, by the addresses its labels carry; native identity
  // stays in storage and in the run audit, never in the model-facing text.
  for (const entry of pending) {
    const view = renderEntry(entry, memory.config.render, memory.resultText).content;
    expect(text).toContain(view);
    expect(tokens(view)).toBeLessThanOrEqual(memory.config.render.entryTokens);
  }
  expect(text).not.toContain(`[entry ${JSON.stringify([pending[0]!.nativeLineage, pending[0]!.nativeId])}]`);
  expect(text.indexOf(`[T${next.id}#user]:`)).toBeLessThan(text.indexOf(`[T${next.id}#t1]`));
  // Tool identity and status remain, and so does what `C` and `R` can hold of the payload.
  expect(text).toContain(`[T${next.id}#t1] Bash(command="SECRET_ARGUMENT")`);
  expect(text).toContain(`[T${next.id}#t1] Bash success: `);
  expect(text).toContain("SECRET_RESULT"); expect(text).not.toContain("x".repeat(4_000));
  // User text is excerpted, and the omission is marked in the one wording every view uses.
  expect(text).toContain("USER_HEAD"); expect(text).not.toContain(body);
  expect(text).toMatch(/\[\.\.\. \d+ characters truncated\]/);
  // Deterministic local work: the same snapshot renders the same bytes, and no model was called.
  expect(compacted(memory.compact(s.id, "main", next.id))).toBe(text);
  expect(calls).toBe(0);
  // There is no second, tighter rendering to fall back on (30): an envelope these views cannot meet
  // is a native delegation naming the overflowing window and its numbers, with nothing hidden to
  // force a success and no pending window trimmed (28a item 3).
  envelope(500, 100);
  const delegated = memory.compact(s.id, "main", next.id);
  expect("native" in delegated).toBe(true);
  expect("native" in delegated && delegated.reason).toContain("compaction.rawTokens");
  expect("native" in delegated && delegated.reason).toContain(`bounded views of ${pending.length} pending entries`);
  expect("native" in delegated && delegated.reason).toContain("required material does not fit after lending");
  expect(memory.pendingEntries(s.id, "main", next.id).map(e => e.id)).toEqual(pending.map(e => e.id));
  defaultWindows();
  // The stored evidence is untouched by any of it: `full` still renders it uncut, and the assembled
  // read without `full` (23b) is the same bounded view of the same entry, cut where the budgets bite.
  expect(memory.trace(`T${next.id}#user`, { full: true })).toContain(body);
  expect(memory.trace(`T${next.id}#user`)).toContain("USER_HEAD");
  expect(memory.trace(`T${next.id}`, { tool: 1, full: true })).toContain("SECRET_ARGUMENT");
  expect(memory.trace(`T${next.id}`, { tool: 1, full: true })).toContain("SECRET_RESULT");
});

/** 25c amended this acceptance on its own terms — its thresholds moved from `noting.batchTokens` to
 * the shared envelope, because compaction no longer applies the Noter's batch ceiling to a foreground
 * backlog (parent amendment 3) — 30 amended it again (there is no second rendering to escalate to, so
 * a backlog the one bounded view cannot fit delegates to native compaction, and the tighter `E` of
 * 2,000 keeps long replies inside the envelope), and 28a makes that envelope the sum of the three
 * windows: Raw over its own 10,000-token baseline borrows the knowledge and facts allowance nothing
 * else is using, which is exactly the lending this acceptance now exercises. */
test("23 conversation-dense acceptance, rescaled by 25c, 30 and 32a: a dozen long replies fit, four dozen delegate to native with the reason, eight three times as long still fit under E", () => {
  const dense = (count: number, words: number) => {
    const s = session();
    let parent: number | undefined;
    for (let i = 0; i < count; i++) {
      const t = turn(s.id, `Question ${i}: ` + "word ".repeat(30), parent);
      memory.store.updateTurn(t.id, { assistantText: `Answer ${i}: ` + "word ".repeat(words) });
      parent = t.id;
    }
    return { s, parent: parent! };
  };
  const view = (entry: Parameters<typeof renderEntry>[0]) => renderEntry(entry, memory.config.render, memory.resultText).content;
  const total = (views: string[]) => tokens(views.join("\n\n"));
  const capacity = memory.config.render.knowledgeBlockTokens + memory.config.compaction.factsTokens + memory.config.compaction.rawTokens;
  // Long replies with few tool calls: the shape the retired compact-only view handled.
  const dozen = dense(12, 1_000);
  memory.store.appendToolCall({ turnId: dozen.parent, name: "bash", input: JSON.stringify({ command: "npm test" }), result: "ok", status: "success" });
  const pending = memory.pendingEntries(dozen.s.id, "main", dozen.parent);
  const fits = total(pending.map(view));
  // Above the Noter's batch ceiling and below the shared envelope: before 25c the inner cap escalated
  // this; the one view keeps every entry, and the ordinary Raw title is the only one there is.
  expect(fits).toBeGreaterThan(memory.config.noting.batchTokens);
  expect(fits).toBeLessThan(capacity);
  const kept = memory.compact(dozen.s.id, "main", dozen.parent);
  expect("native" in kept).toBe(false);
  for (const entry of pending) expect(compacted(kept)).toContain(view(entry));
  expect(compacted(kept)).toContain("\nRaw:\n");
  // Four times the backlog is over the 40,000-token envelope even in the one view (32a raised
  // the main knowledge window, so this fixture grows with the envelope), and 30 removed the
  // rendering that used to be tried next: compact says so instead of cutting harder than the profile
  // allows, and starts no recovery worker of its own (28 amendment 9).
  const many = dense(48, 1_000);
  memory.store.appendToolCall({ turnId: many.parent, name: "bash", input: JSON.stringify({ command: "npm test" }), result: "ok", status: "success" });
  const overflowing = memory.pendingEntries(many.s.id, "main", many.parent);
  expect(total(overflowing.map(view))).toBeGreaterThan(capacity);
  const result = memory.compact(many.s.id, "main", many.parent);
  expect("native" in result).toBe(true);
  expect((result as { reason: string }).reason).toContain("bounded views");
  expect((result as { reason: string }).reason).toContain("compaction.rawTokens");
  expect(calls).toBe(0);
  // Eight replies three times as long: each is over `E` on its own, so each is cut to it, and the
  // backlog that needed the tier-2 profile before 30 now fits the one view.
  const longer = dense(8, 3_000);
  const longEntries = memory.pendingEntries(longer.s.id, "main", longer.parent);
  expect(longEntries.some(e => tokens(view(e)) === memory.config.render.entryTokens)).toBe(true);
  expect(total(longEntries.map(view))).toBeLessThan(capacity);
  const fewer = memory.compact(longer.s.id, "main", longer.parent);
  expect("native" in fewer).toBe(false);
  for (const entry of longEntries) expect(compacted(fewer)).toContain(view(entry));
});

test("20c 2026-09-08 scenario 11: when the bounded views miss a cap compact asks for native compaction with the reason, and changes nothing", () => {
  const { s, t } = populated();
  let parent = t.id;
  for (let i = 0; i < 40; i++) parent = turn(s.id, `entry ${i}`, parent).id;
  const pending = memory.pendingEntries(s.id, "main", parent).map(e => e.id);
  expect(pending.length).toBeGreaterThanOrEqual(40);
  // Many tiny entries: their identities and labels alone exceed the whole envelope.
  envelope(200, 100);
  const outer = memory.compact(s.id, "main", parent);
  expect("native" in outer).toBe(true);
  expect("native" in outer && outer.reason).toContain("compaction.rawTokens");
  expect("native" in outer && outer.reason).toContain(`bounded views of ${pending.length} pending entries`);
  expect("text" in outer).toBe(false); // not an empty success, and no oversized block either
  // 25c: there is no second cap to miss. The Noter's batch ceiling is not compact's knob any more —
  // shrinking it to fifty tokens neither escalates this snapshot nor appears in any reason — so the
  // three windows and their envelope are the only budgets a delegation can name (28a).
  defaultWindows(); memory.config.noting.batchTokens = 50;
  const inner = memory.compact(s.id, "main", parent);
  expect("native" in inner).toBe(false);
  expect(compacted(inner)).not.toContain("raw ceiling");
  for (const id of pending) expect(compacted(inner)).toContain(`T${memory.store.listSourceEntries(s.id).find(e => e.id === id)!.turnId}#`);
  envelope(200, 100);
  const named = memory.compact(s.id, "main", parent);
  expect("native" in named && named.reason).toContain("compaction.rawTokens");
  expect("native" in named && named.reason).not.toContain("raw ceiling");
  // Delegation is a request, not a summary: nothing was read differently, processed or erased.
  expect(memory.pendingEntries(s.id, "main", parent).map(e => e.id)).toEqual(pending);
  expect(memory.trace(`T${parent}#user`)).toContain("entry 39");
  expect(calls).toBe(0);
});

// ---- Ticket 25, amendment 3 (25c), as 28a left it: three windows over one envelope, required
// material reserved out of it before either refill ----

test("25c 2026-09-09, as 28a left it: with nothing pending the consolidated refill takes the whole spare, and pending Raw that needs the envelope leaves it none", () => {
  const { s, t } = populated();
  // Already-consolidated facts, large enough that "some space" and "no space" are far apart: about
  // 830 tokens each. Consolidated, so they are refill (a) — optional history in the spare — and not
  // the pending facts a required window must hold whole.
  for (let i = 0; i < 15; i++) noting(s.id, t.id, `history ${i} ` + "word ".repeat(800));
  const facts = memory.store.listSessionFacts(s.id);
  memory.store.commitConsolidationRun({ run: { sessionId: s.id, branch: "main", kind: "consolidation", createdAt: time },
    operations: [], consolidated: facts.map(f => f.id) });
  expect(memory.store.consolidationBatch(s.id, "main", t.id)).toHaveLength(0);
  expect(memory.pendingEntries(s.id, "main", t.id)).toHaveLength(0);
  // No pending Raw: the refill may use the whole spare, and all of it fits inside the envelope.
  const roomy = memory.compact(s.id, "main", t.id);
  const spare = compacted(roomy);
  for (const fact of facts) expect(spare).toContain(`[F${fact.id}]`);
  expect(spare).not.toContain("older facts; expand:");
  const windows = charged(roomy);
  expect(windows.knowledge + windows.facts + windows.raw).toBeLessThanOrEqual(windows.envelope);
  // Now pending Raw that needs almost all of the envelope. It is required and is reserved first, so
  // the optional facts receive no space at all. One entry is worth at most `render.entryTokens`
  // (2,000 since 30), so ten of them are about 19,400 tokens.
  for (let i = 0; i < 10; i++) memory.appendEntry({ sessionId: s.id, nativeLineage: "x", nativeId: `big${i}`, turnId: t.id,
    role: "assistant", text: "word ".repeat(1_940), raw: "", calls: [] });
  const pending = memory.pendingEntries(s.id, "main", t.id);
  expect(pending).toHaveLength(10);
  const measured = charged(memory.compact(s.id, "main", t.id));
  // An envelope of exactly the required material plus the refill's own omission receipt: the pending
  // views are all kept, the optional facts are all left out, and the receipt says so.
  const receipt = tokens(`omitted ${facts.length} older facts; expand: F1, F2, F3, F4, F5, F6, F7, F8 and 8 more up to F16`) + tokens("Receipts:") + 2;
  envelope(measured.knowledge + measured.required.facts + measured.required.raw + receipt, measured.knowledge);
  const crowded = memory.compact(s.id, "main", t.id);
  expect("native" in crowded).toBe(false); // the required material fits; only the optional refill yields
  const text = compacted(crowded);
  for (const entry of pending) expect(text).toContain(renderEntry(entry, memory.config.render).content);
  for (const fact of facts) expect(text).not.toContain(`[F${fact.id}]`);
  expect(text).toContain(`omitted ${facts.length} older facts; expand: F1`);
  expect(text.indexOf("Receipts:")).toBeGreaterThan(text.indexOf("</episodic>"));
  // Knowledge keeps its own baseline under that pressure: the block is still there.
  expect(text).toContain("<knowledge>");
  expect(text.indexOf("<knowledge>")).toBeLessThan(text.indexOf("<episodic>"));
  expect(memory.inject(s.id).startsWith("<knowledge>")).toBe(true);
  expect(calls).toBe(0);
  defaultWindows();
});

test("25c 2026-09-09, as 30 left it: pending membership is processing progress inside a Turn, and a native delegation leaves injection alone", () => {
  const { s, t } = populated();
  const noted = memory.appendEntry({ sessionId: s.id, nativeLineage: "x", nativeId: "done", turnId: t.id, role: "assistant", text: "PARTIAL_NOTED", raw: "", calls: [] });
  const open = memory.appendEntry({ sessionId: s.id, nativeLineage: "x", nativeId: "open", turnId: t.id, role: "assistant", text: "PARTIAL_PENDING " + "word ".repeat(1_500), raw: "", calls: [] });
  // One Turn, two entries, one of them processed: progress is per entry, never a Turn watermark.
  const run = memory.store.commitNotingRun({ run: { sessionId: s.id, branch: "main", kind: "noting", createdAt: time },
    facts: [{ turnId: t.id, text: "PARTIAL_FACT", category: "observation", actor: "user", source: [`T${t.id}#user`], createdAt: time }],
    entryIds: [noted.id] });
  expect(run.ok).toBe(true);
  expect(memory.pendingEntries(s.id, "main", t.id).map(e => e.id)).toEqual([open.id]);
  const bounded = compacted(memory.compact(s.id, "main", t.id));
  expect(bounded).toContain("PARTIAL_PENDING");
  expect(bounded).toContain("PARTIAL_FACT");
  // 28a refill (b): the already-extracted entry is not pending, and it is not excluded on that
  // account either — the spare allowance supplies recent applicable already-extracted Raw beside the
  // pending views. Membership is what `pendingEntries` says, never presence in the block.
  expect(bounded).toContain("PARTIAL_NOTED");
  expect(memory.pendingEntries(s.id, "main", t.id).map(e => e.id)).toEqual([open.id]);
  // The identities the block carries, in the one bounded view (30), in source order.
  const membership = (text: string) => memory.store.listSourceEntries(s.id)
    .filter(e => text.includes(renderEntry(e, memory.config.render, memory.resultText).content)).map(e => e.id);
  expect(membership(bounded)).toEqual(memory.store.sourcePath(s.id, "main", t.id).map(e => e.id));
  expect(membership(bounded)).toContain(noted.id); expect(membership(bounded)).toContain(open.id);
  // Native delegation: the pending set does not shrink to fit, and the injection does not move.
  const injection = memory.inject(s.id);
  envelope(200, 200);
  const delegated = memory.compact(s.id, "main", t.id);
  expect("native" in delegated).toBe(true);
  expect("text" in delegated).toBe(false); // no custom summary is built, so none can be consumed
  expect(memory.pendingEntries(s.id, "main", t.id).map(e => e.id)).toEqual([open.id]);
  defaultWindows();
  expect(memory.inject(s.id)).toBe(injection);
  expect(calls).toBe(0);
});

// 29d (ticket 29, "Retire automatic foreground receipt delivery") supersedes the ruling this file
// pinned as "pending delivery is exact to its run and branch, consumed once, including after later
// commits": commits create no delivery intents at all now, so exactness and single consumption have
// no subject. What survives of it is the part that was never about delivery — a run owns its facts —
// and that is asserted by the test below and by "commits leave no delivery intent behind".
test("29d: a noting commit records its facts and leaves no delivery intent behind", () => {
  const s = session(), t = turn(s.id);
  const first = noting(s.id, t.id, "first fact", "main");
  noting(s.id, t.id, "second fact", "other");
  expect(memory.inject(s.id)).not.toContain("noted");
  expect(memory.store.db.prepare("SELECT COUNT(*) AS n FROM pending_deliveries").get()).toEqual({ n: 0 });
  expect(JSON.parse(memory.store.getRun(first.runId)!.response!).factIds).toEqual([first.facts[0]!.id]);
});

test("branch facts use run ownership independently of audit JSON", () => {
  const s = session(), t = turn(s.id);
  const first = noting(s.id, t.id, "noted", "main");
  memory.tools({ kind: "manual", sessionId: s.id, branch: "other", currentTurnId: t.id })[2]!.execute({
    facts: [{ category: "decision", actor: "user", text: "manual", source: [`T${t.id}#user`] }] });
  const manual = memory.store.listRuns(s.id).at(-1)!;
  memory.store.db.exec("UPDATE runs SET response = 'not JSON'");
  expect(memory.store.listBranchFacts(s.id, "main").map(f => f.text)).toEqual(["noted", "manual"]); // facts belong to their turn, whichever branch wrote them
  expect(memory.store.listBranchFacts(s.id, "other").map(f => f.text)).toEqual(["noted", "manual"]); // same turn, same path
  for (const run of [memory.store.getRun(first.runId)!, manual]) {
    memory.store.updateRun(run.id, { ...run, response: "{}" });
    const ids = (memory.store.db.prepare("SELECT id FROM facts WHERE run_id = ? ORDER BY id").all(run.id) as { id: number }[]).map(f => f.id);
    expect(JSON.parse(memory.store.getRun(run.id)!.response!).factIds).toEqual(ids);
  }
  const empty = memory.store.recordRun({ sessionId: s.id, kind: "manual", createdAt: time, outcome: "success", response: "{}" });
  memory.store.updateRun(empty.id, empty);
  expect(JSON.parse(memory.store.getRun(empty.id)!.response!)).toEqual({});
});

test("marks bind to current revision, replace its mark, clear it, and do not carry into an edit", () => {
  const { s, f, e } = populated();
  expect(memory.mark(e, "verified")).toBe(`K${e}@1: verified`);
  expect(memory.inject(s.id)).toContain("· verified");
  expect(memory.trace(`K${e}`)).toContain("· verified");
  const edit = memory.store.commitConsolidationRun({ run: { sessionId: s.id, kind: "consolidation", createdAt: time }, operations: [{
    op: "update", topics: [], reason: "Substantive correction of the recorded conclusion.", knowledgeId: e, baseCommit: 1, text: fixture.editedKnowledge, category: "constraint", scope: "project", supports: [f.id], createdAt: time }] });
  expect(edit.ok).toBe(true); expect(memory.inject(s.id)).not.toContain("verified");
  expect(memory.trace(`K${e}`)).not.toContain("· verified");
  expect(memory.trace(`K${e}@1`)).toContain("· verified");
  memory.mark(e, "flagged"); expect(memory.inject(s.id)).toContain("· flagged");
  memory.mark(e, "verified"); expect(memory.store.listKnowledgeMarks(e).filter((m) => m.commitId === 2)).toHaveLength(1);
  memory.mark(e, "clear"); expect(memory.inject(s.id)).not.toContain("verified");
  expect(memory.store.listKnowledgeMarks(e).map((m) => m.commitId)).toEqual([1]);
});

test("literal search finds facts, historical knowledge and raw across projects", () => {
  const s = session(), t = turn(s.id, "needle raw"), n = noting(s.id, t.id, "needle fact");
  const e = knowledge(s.id, n.facts[0]!.id, "goal", "project", "needle knowledge");
  expect(memory.search("needle", "facts")).toContain("[F1]"); expect(memory.search("needle", "facts")).not.toContain("[K");
  expect(memory.search("needle", "knowledge")).toContain(`[K${e}@${e}]`); expect(memory.search("needle", "knowledge")).not.toContain("[F1]");
  const all = memory.search("needle", "all"); expect(all).toContain("[F1]"); expect(all).toContain(`[K${e}@${e}]`); expect(all).toContain(`[S${s.id}/T${t.id}]`);
  expect(all.split("\n").filter((l) => l.startsWith("["))).toHaveLength(3);
  memory.store.commitConsolidationRun({ run: { sessionId: s.id, kind: "consolidation", createdAt: time }, operations: [{
    op: "update", topics: [], reason: "Substantive correction of the recorded conclusion.", knowledgeId: e, baseCommit: 1, text: "replacement knowledge", category: "goal", scope: "project", supports: [1], createdAt: time }] });
  expect(memory.search("needle", "knowledge")).toContain(`[K${e}@${e}]`);
  expect(memory.search("needle", "knowledge")).not.toContain(`[K${e}@2]`);
  const other = session(), foreign = turn(other.id, "needle foreign");
  memory.store.appendToolCall({ turnId: t.id, name: "Bash", input: "toolonly", result: "literal%_", status: "success" });
  const raw = memory.search("toolonly", "raw");
  expect(raw).toContain(`[S${s.id}/T${t.id}]`); expect(raw).toContain("literal substring search");
  expect(memory.search("needle foreign", "raw")).toContain(`T${foreign.id}`); // another project's raw is readable (ruling 2026-09-07)
  expect(memory.search("%_", "raw")).toContain(`[S${s.id}/T${t.id}]`);
  expect(memory.search("nohits", "all")).toContain("No hit does not mean absent.");
});

test("schema has no unused full-text tables or triggers", () => {
  expect(memory.store.db.prepare("SELECT name FROM sqlite_schema WHERE name GLOB '*_fts*'").all()).toEqual([]);
});

test.each([
  ["美琴", "御坂美琴的电击"],
  ["pnpm", "使用pnpm而不是npm"],
  ["不要", "用 pnpm，不要 npm"],
  ["琴", "御坂美琴的电击"],
  ["用pnpm", "使用pnpm而不是npm"],
  ["core/api/read.ts", "查看core/api/read.ts文件"],
  ["%", "进度100%完成"],
  ["_", "使用snake_case命名"],
  ["\\", "路径core\\api\\read.ts"],
])("literal substring search for %s across all layers and projects keeps cursor order", (query, text) => {
  const s = session(), foreign = session();
  const expected = { facts: [] as string[], knowledge: [] as string[], raw: [] as string[] };
  for (const owner of [s, foreign]) {
    for (const content of [text, "无关内容 core/api/read.ts snakeXcase 100X coreapi", text]) {
      const t = turn(owner.id, "raw prompt");
      memory.store.appendToolCall({ turnId: t.id, name: "Bash", result: content, status: "success" });
      const f = noting(owner.id, t.id, content).facts[0]!;
      const k = knowledge(owner.id, f.id, "reference", "project", content);
      if (content.includes(query)) { // both projects: reads are unrestricted (ruling 2026-09-07)
        expected.facts.push(`[F${f.id}]`);
        expected.knowledge.push(`[K${k}@${k}]`);
        expected.raw.push(`[S${owner.id}/T${t.id}]`);
      }
    }
  }
  const search = memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: 1 }).find(t => t.name === "search")!;
  for (const layer of ["facts", "knowledge", "raw", "all"] as const) {
    const wanted = layer === "all" ? [...expected.facts, ...expected.knowledge, ...expected.raw] : expected[layer];
    const found: string[] = [];
    let cursor: string | undefined;
    do {
      const page = search.execute({ query, layer, cap: 1, ...(cursor ? { cursor } : {}) });
      const addresses = [...page.matchAll(/^\[[^\]]+\]/gm)].map(m => m[0]);
      expect(addresses).toHaveLength(1);
      expect(page).toContain("literal substring search");
      found.push(...addresses);
      cursor = /cursor=(\S+)/.exec(page)?.[1];
      expect(found.length).toBeLessThanOrEqual(wanted.length);
    } while (cursor);
    expect(found).toEqual(wanted);
  }
  expect(search.description).toContain("literal substring search");
});

test("opaque cursors continue search snapshots and trace session, comma, revision and negation listings", () => {
  const { s, t, f, e } = populated();
  turn(s.id, "second turn", t.id);
  noting(s.id, t.id, fixture.base);
  const first = memory.search(fixture.base, "facts", { cap: 1 });
  const cursor = /cursor=(\S+)/.exec(first)![1]!;
  expect(cursor).not.toContain("{"); expect(first).toContain("[F1]");
  const last = memory.search("ignored", "all", { cursor });
  expect(last).toContain("[F2]"); expect(last).not.toContain("cursor="); expect(last).toContain("No hit does not mean absent");
  expect(() => memory.trace(`cursor=${cursor}`)).toThrow("unknown or expired cursor");
  for (const address of [`S${s.id}`, "mapC", `F${f.id},K${e}`, `K${e}`, `F${f.id}..`]) {
    const full = memory.trace(address), chunks: string[] = [];
    let part = memory.trace(address, { cap: 1 });
    for (;;) {
      chunks.push(part.split("\n\nReceipts:")[0]!);
      const next = /cursor=(\S+)/.exec(part)?.[1];
      if (!next) break;
      part = memory.trace(`cursor=${next}`);
    }
    expect(chunks.join("\n")).toBe(full);
  }
  expect(() => memory.trace(`S${s.id}`, { cap: 0 })).toThrow("positive integer");
});

test("status reports attribution, counts, every watermark and last runs, and no delivery queue (29d)", () => {
  const { s, t } = populated(); noting(s.id, t.id, fixture.observation, "side");
  const status = memory.status(s.id);
  expect(status).not.toContain("Watermark");
  expect(status).not.toContain("Pending deliveries"); // 29d: the queue-only status field went with the queue
  for (const text of ["Project: mapC (marker)", "Facts: 2 session; 2 project", "Knowledge: 1 visible active", "Last noting: run 3 success", "Last consolidation: run 2 success"]) expect(status).toContain(text);
});

test("project mark merges an undeclared own project, relabels facts and knowledge, and beats later marker reports", () => {
  const s = session(undefined, "undeclared"), t = turn(s.id), n = noting(s.id, t.id), f = n.facts[0]!;
  const e = knowledge(s.id, f.id), own = knowledge(s.id, f.id, "open", "session");
  expect(memory.declareProject(s.id, "declared")).toContain("declared (mark)");
  const project = memory.store.findProjectByName("declared")!;
  expect(memory.store.getProject(s.projectId)!.mergedInto).toBe(project.id);
  expect(memory.store.listProjectFacts(project.id).map((f) => f.id)).toEqual([f.id]);
  expect(memory.store.getKnowledge(e)!.projectId).toBe(project.id);
  const peer = session(project.id);
  expect(memory.inject(peer.id)).toContain(`[K${e}@${e}]`); expect(memory.inject(peer.id)).not.toContain(`[K${own}@${own}]`);
  memory.declareProject(s.id, "ignored marker", "marker");
  expect(memory.store.getSession(s.id)!.projectId).toBe(project.id);
  expect(memory.store.findProjectByName("ignored marker")).toBeNull();
  memory.declareProject(s.id, "next");
  expect(memory.store.getSession(peer.id)!.projectId).toBe(project.id);
  expect(memory.store.getProject(project.id)!.mergedInto).toBeNull();
  expect(memory.inject(s.id)).toContain(`[K${own}@${own}]`);
});

test("listing line caps still apply with an explicit large search token budget", () => {
  const s = session(), t = turn(s.id);
  const result = memory.store.commitNotingRun({ run: { sessionId: s.id, kind: "noting", createdAt: time },
    facts: Array.from({ length: 101 }, (_, i) => ({ turnId: t.id, text: `needle ${i}`, category: "observation" as const,
      actor: "agent" as const, source: [`T${t.id}#assistant`], createdAt: time })) });
  expect(result.ok).toBe(true);
  const first = memory.search("needle", "all", { maxTokens: 10000 });
  expect(first.split("\n").filter((l) => l.startsWith("[F"))).toHaveLength(100);
  const cursor = /cursor=(\S+)/.exec(first)![1]!;
  noting(s.id, t.id, "needle added later");
  const last = memory.search("", "all", { cursor });
  expect(last).toContain("[F101]"); expect(last).not.toContain("[F102]");
  expect(last).not.toContain("cursor=");
});

test("first-prompt injection by project needs no session: global and project knowledge", () => {
  const { s, f } = populated();
  const p = memory.store.getSession(s.id)!.projectId;
  knowledge(s.id, f.id, "constraint", "session", "session-only");
  const byProject = memory.inject({ projectId: p });
  const bySession = memory.inject(s.id);
  expect(byProject).toContain("[K1@");
  expect(byProject).not.toContain("session-only");
  expect(bySession).toContain("session-only");
  expect(() => memory.inject({ projectId: 999 })).toThrow("does not exist");
});

test("search marks historical, merged and archived knowledge hits so they do not read like current rules", () => {
  const s = session(), t = turn(s.id, "rule raw"), n = noting(s.id, t.id, "pnpm rule fact");
  const a = knowledge(s.id, n.facts[0]!.id, "constraint", "project", "Use pnpm for installs");
  const b = knowledge(s.id, n.facts[0]!.id, "constraint", "project", "pnpm is the package manager");
  const c = knowledge(s.id, n.facts[0]!.id, "constraint", "project", "pnpm lockfile is committed");
  const run = { sessionId: s.id, kind: "consolidation" as const, createdAt: time };
  memory.store.commitConsolidationRun({ run, operations: [{ op: "update", topics: [], reason: "Substantive correction of the recorded conclusion.", knowledgeId: a, baseCommit: 1, text: "Use npm for installs", category: "constraint", scope: "project", supports: [1], createdAt: time }] });
  memory.store.commitConsolidationRun({ run, operations: [{ op: "merge", topics: [], reason: "Merged duplicate knowledge into the survivor.", intoKnowledgeId: b, intoBaseCommit: b, absorb: [{ knowledgeId: c, baseCommit: c }], text: "pnpm is the package manager and its lockfile is committed", category: "constraint", scope: "project", supports: [1], createdAt: time }] });
  memory.store.commitConsolidationRun({ run, operations: [{ op: "archive", reason: "Retired: the cited evidence withdraws this conclusion.", knowledgeId: b, baseCommit: 5, supports: [1], createdAt: time }] });
  const hits = memory.search("pnpm", "knowledge");
  expect(hits).toContain(`[K${a}@1]`); expect(hits).toContain(`note: superseded by K${a}@4`);
  expect(hits.split("\n").find(l => l.startsWith(`[K${c}@3]`))).toContain("note: archived");
  expect(hits).toContain("note: archived");
  const current = memory.search("for installs", "knowledge").split("\n").find((l) => l.startsWith(`[K${a}@4]`))!;
  expect(current).toContain("note: tip"); // unbound reads label tips without claiming current
});

test("reads resolve any existing address: another session's history, current revision, and a missing revision is rejected as missing", () => {
  const s = session(), t = turn(s.id, "scope raw"), n = noting(s.id, t.id, "scoped fact");
  const k = knowledge(s.id, n.facts[0]!.id, "goal", "project", "shared-then-private goal");
  memory.store.commitConsolidationRun({ run: { sessionId: s.id, kind: "consolidation", createdAt: time }, operations: [{ op: "update", topics: [], reason: "Substantive correction of the recorded conclusion.", knowledgeId: k, baseCommit: 1, text: "private goal now", category: "goal", scope: "session", supports: [1], createdAt: time }] });
  const peer = session(memory.store.getSession(s.id)!.projectId), pt = turn(peer.id, "peer raw");
  memory.store.updateTurn(pt.id, { assistantText: "ok" });
  const trace = memory.tools({ kind: "manual", sessionId: peer.id, branch: "main", currentTurnId: pt.id }).find((d) => d.name === "trace")!;
  expect(memory.search("shared-then-private", "knowledge", { sessionId: peer.id })).toContain(`[K${k}@${k}]`);
  expect(trace.execute({ address: `K${k}@1` })).toContain("shared-then-private goal");
  expect(trace.execute({ address: `K${k}` })).toContain("shared-then-private goal");
  expect(trace.execute({ address: `K${k}@2` })).toContain("private goal now");
  expect(trace.execute({ address: `K${k}@3` })).toContain("does not exist");
});

// ---- 21b 2026-09-08: topic grouping and literal label retrieval ----

test("21b 2026-09-08: one topic spans categories, one commit joins two groups, and a label absent from the text finds that commit once", () => {
  const { s, f, e } = populated();
  const a = knowledge(s.id, f.id, "constraint", "project", "The extractor keeps every raw entry", time, ["extraction", "database"]);
  const b = knowledge(s.id, f.id, "mechanism", "project", "One row per entry, written in the same transaction", time, ["database"]);
  const c = knowledge(s.id, f.id, "term", "project", "An entry is one native message", time);
  const groups = memory.topicGroups(s.id);
  // One subject holds knowledge of two categories; the groups reference the exact commits.
  expect(groups.topics).toEqual([
    { topic: "database", commits: [{ knowledgeId: a, commit: a }, { knowledgeId: b, commit: b }] },
    { topic: "extraction", commits: [{ knowledgeId: a, commit: a }] }]);
  expect(groups.unclassified).toEqual([{ knowledgeId: e, commit: e }, { knowledgeId: c, commit: c }]);
  // Sharing a label merges no identity and clones no record: both groups name the same K@commit.
  expect(memory.store.getKnowledge(a)!.id).not.toBe(memory.store.getKnowledge(b)!.id);
  expect(memory.store.listKnowledgeRevisions(a)).toHaveLength(1);
  // The label is absent from every conclusion, and the hit is one line per exact commit.
  for (const id of [a, b]) expect(memory.store.getKnowledgeRevision(id, id)!.text).not.toContain("database");
  const hits = memory.search("database", "knowledge").split("\n").filter(l => l.startsWith("[K"));
  expect(hits).toHaveLength(2);
  // Several labels, or text and labels together, still return one result per commit.
  const d = knowledge(s.id, f.id, "reference", "project", "The database schema lives in core/store", time, ["database", "database design"]);
  const again = memory.search("database", "knowledge").split("\n").filter(l => l.startsWith("[K"));
  expect(again).toHaveLength(3);
  expect(again.filter(l => l.startsWith(`[K${d}@${d}]`))).toHaveLength(1);
});

test("21b 2026-09-08: labels match literally, never as JSON syntax, and empty topics hide nothing", () => {
  const { s, f } = populated();
  const labelled = knowledge(s.id, f.id, "goal", "project", "带标签的结论", time,
    ["禁书目录", "read path", "100%_done", 'say "hi"', "core\\store"]);
  const plain = knowledge(s.id, f.id, "open", "project", "unlabelled but searchable", time);
  for (const query of ["禁书目录", "read path", "100%_done", '"hi"', "core\\store"]) {
    expect(memory.search(query, "knowledge")).toContain(`[K${labelled}@${labelled}]`);
  }
  // The serialized JSON around the labels is not searchable content: neither its punctuation nor its escapes.
  for (const query of ['", "', '["', '\\"hi\\"', '","']) expect(memory.search(query, "knowledge")).not.toContain("[K");
  // A percent or underscore is a literal character here, exactly as in text search.
  expect(memory.search("100%", "knowledge")).toContain(`[K${labelled}@`);
  expect(memory.search("100X_done", "knowledge")).not.toContain("[K");
  expect(memory.search("unlabelled but searchable", "knowledge")).toContain(`[K${plain}@${plain}]`);
});

// ---- Ticket 28a: three material windows over one envelope, lending, and the two refills ----

/** Facts of one Turn that no Consolidation has taken and that mark no entry as processed: the
 * pending facts a required window must hold whole. */
function pendingFacts(sessionId: number, turnId: number, texts: string[], branch = "main") {
  const result = memory.store.commitNotingRun({ run: { sessionId, branch, kind: "noting", createdAt: time },
    facts: texts.map(text => ({ turnId, text, category: "observation" as const, actor: "user" as const, source: [`T${turnId}#user`], createdAt: time })),
    entryIds: [] });
  if (!result.ok) throw new Error(result.problems.join("\n"));
  return result.facts;
}
/** Mark facts consolidated on this path, which is what makes them refill (a) candidates. */
function consolidate(sessionId: number, ids: number[], branch = "main") {
  const result = memory.store.commitConsolidationRun({ run: { sessionId, branch, kind: "consolidation", createdAt: time },
    operations: [], consolidated: ids });
  if (!result.ok) throw new Error(JSON.stringify(result));
}
const entry = (sessionId: number, turnId: number, nativeId: string, text: string) =>
  memory.appendEntry({ sessionId, nativeLineage: "x", nativeId, turnId, role: "assistant", text, raw: "", calls: [] });

test("32a / 28 acceptance 1: 18k knowledge, 14k facts and 6k Raw fit at 38k through lending without a worker", () => {
  const s = session(), t = turn(s.id, "head");
  const seed = pendingFacts(s.id, t.id, ["seed"])[0]!;
  consolidate(s.id, [seed.id]);
  for (let i = 0; i < 9; i++) knowledge(s.id, seed.id, "constraint", "project", `K${i} ` + "word ".repeat(1_950), `202${i}`);
  const facts = pendingFacts(s.id, t.id, [...Array(14)].map((_, i) => `FACT_${i} ` + "word ".repeat(990)));
  for (let i = 0; i < 3; i++) entry(s.id, t.id, `raw${i}`, `RAW_${i} ` + "word ".repeat(1_940));
  const result = memory.compact(s.id, "main", t.id);
  expect("native" in result).toBe(false); // 38k of demand inside the 40k envelope
  const windows = charged(result), text = compacted(result);
  // The facts window is served past its 10,000-token baseline:
  // borrowed what knowledge and Raw were not using, and nothing was clipped to a baseline.
  expect(windows.facts).toBeGreaterThan(10_000);
  expect(windows.knowledge).toBeGreaterThan(17_000);
  expect(windows.raw).toBeGreaterThan(5_000);
  expect(windows.envelope).toBe(40_000);
  expect(windows.knowledge + windows.facts + windows.raw).toBeLessThanOrEqual(windows.envelope);
  for (const fact of facts) expect(text).toContain(`[F${fact.id}]`);
  for (let i = 0; i < 3; i++) expect(text).toContain(`RAW_${i}`);
  for (let i = 0; i < 9; i++) expect(text).toContain(`K${i} `);
  expect(calls).toBe(0);
});

test("28a acceptance 2: a window keeps its baseline material when another wants more, optional knowledge yields first, and a required overflow delegates naming the window", () => {
  const s = session(), t = turn(s.id, "head");
  const seed = pendingFacts(s.id, t.id, ["seed"])[0]!;
  consolidate(s.id, [seed.id]);
  // A knowledge corpus far past its own window, 7k of pending facts and 12k of pending Raw.
  for (let i = 0; i < 13; i++) knowledge(s.id, seed.id, "constraint", "project", `K${i} ` + "word ".repeat(1_950), `20${10 + i}`);
  const facts = pendingFacts(s.id, t.id, [...Array(7)].map((_, i) => `FACT_${i} ` + "word ".repeat(990)));
  for (let i = 0; i < 6; i++) entry(s.id, t.id, `raw${i}`, `RAW_${i} ` + "word ".repeat(1_940));
  const result = memory.compact(s.id, "main", t.id);
  expect("native" in result).toBe(false);
  const windows = charged(result), text = compacted(result);
  // The facts window keeps everything inside its own baseline although Raw wants more than its own…
  for (const fact of facts) expect(text).toContain(`[F${fact.id}]`);
  expect(windows.raw).toBeGreaterThan(10_000);
  // …and optional knowledge beyond its baseline is what yields, down to its baseline but never below.
  expect(windows.knowledge).toBeLessThan(13 * 2_000);
  expect(windows.knowledge).toBeGreaterThanOrEqual(memory.config.render.knowledgeBlockTokens - 2_000);
  expect(text).toContain("knowledge; expand: K"); // the rest is named, never silently dropped
  expect(windows.knowledge + windows.facts + windows.raw).toBeLessThanOrEqual(windows.envelope);
  // Required material that still does not fit after all of that lending delegates, naming the window
  // and its numbers — the pending window is never trimmed to force a success.
  pendingFacts(s.id, t.id, [...Array(24)].map((_, i) => `OVER_${i} ` + "word ".repeat(990)));
  const delegated = memory.compact(s.id, "main", t.id);
  expect("native" in delegated).toBe(true);
  expect("native" in delegated && delegated.reason).toContain("compaction.factsTokens");
  expect("native" in delegated && delegated.reason).toContain("pending facts need");
  expect("native" in delegated && delegated.reason).toContain("required material does not fit after lending");
  expect(memory.pendingEntries(s.id, "main", t.id)).toHaveLength(7); // nothing was processed or erased
  expect(calls).toBe(0);
});

test("28a acceptance 3 and 30 cases 10-12: the two refills are whole, recent, path-applicable, deduplicated, in source order, and never crowd out required material", () => {
  const s = session(), t = turn(s.id, "head");
  const sibling = turn(s.id, "sibling", t.id), selected = turn(s.id, "selected", t.id);
  // Refill (a)'s candidates: consolidated facts of the path, and one of a sibling branch that is not.
  const history = pendingFacts(s.id, t.id, ["HISTORY_OLD", "HISTORY_NEW"]);
  const elsewhere = pendingFacts(s.id, sibling.id, ["SIBLING_HISTORY"], "sibling");
  consolidate(s.id, history.map(f => f.id));
  consolidate(s.id, elsewhere.map(f => f.id), "sibling");
  const pending = pendingFacts(s.id, selected.id, ["PENDING_FACT"])[0]!;
  // Refill (b)'s candidates: already-extracted entries of the path. The Turn prompts are entries too.
  entry(s.id, t.id, "old", "EXTRACTED_OLD");
  const newer = entry(s.id, t.id, "new", "EXTRACTED_NEW");
  const run = memory.store.commitNotingRun({ run: { sessionId: s.id, branch: "main", kind: "noting", createdAt: time },
    facts: [], entryIds: memory.store.sourcePath(s.id, "main", selected.id).map(e => e.id) });
  expect(run.ok).toBe(true);
  const open = entry(s.id, selected.id, "open", "STILL_PENDING");
  expect(memory.pendingEntries(s.id, "main", selected.id).map(e => e.id)).toEqual([open.id]);

  const result = memory.compact(s.id, "main", selected.id);
  const text = compacted(result), windows = charged(result);
  // Required first, refills after: the pending fact and the pending entry are both there…
  expect(text).toContain("PENDING_FACT"); expect(text).toContain("STILL_PENDING");
  // …refill (a) is the path's consolidated facts, deduplicated against the pending ones by
  // construction, and a sibling branch's consolidated fact is not applicable here.
  expect(text).toContain("HISTORY_OLD"); expect(text).toContain("HISTORY_NEW");
  expect(text).not.toContain("SIBLING_HISTORY");
  expect(text.match(/PENDING_FACT/g)).toHaveLength(1); // whole items, once each
  // …and refill (b) is the path's already-extracted entries, whole, in source order.
  expect(text).toContain("EXTRACTED_OLD"); expect(text).toContain("EXTRACTED_NEW");
  expect(text.indexOf("EXTRACTED_OLD")).toBeLessThan(text.indexOf("EXTRACTED_NEW"));
  expect(text.indexOf("EXTRACTED_NEW")).toBeLessThan(text.indexOf("STILL_PENDING"));
  // The carrier lists exactly what was included, pending and refilled alike, each in the one view.
  const supplied = "native" in result ? { entries: [], factIds: [] } : result.supplied;
  expect([...supplied.factIds].sort((a, b) => a - b)).toEqual([...history.map(f => f.id), pending.id].sort((a, b) => a - b));
  expect(supplied.entries.map(e => e.id)).toEqual(memory.store.sourcePath(s.id, "main", selected.id).map(e => e.id));
  expect(new Set(supplied.entries.map(e => e.view))).toEqual(new Set(["bounded"]));
  expect(windows.knowledge + windows.facts + windows.raw).toBeLessThanOrEqual(windows.envelope);

  // 30 case 10: an entry the post-compaction context retains is not supplied a second time — and an
  // entry whose only earlier visibility was the summary being discarded is NOT excluded on that
  // account, since only the pending set and the retained set exclude anything.
  const retained = memory.compact(s.id, "main", selected.id, [newer.nativeId, open.nativeId]);
  const kept = compacted(retained);
  expect(kept).not.toContain("EXTRACTED_NEW");
  expect(kept).toContain("EXTRACTED_OLD"); // an older view of it rode a discarded summary; still refilled
  expect(kept).toContain("STILL_PENDING"); // pending is required, and "retained" never removes it
  expect("native" in retained ? [] : retained.supplied.entries.map(e => e.nativeId)).not.toContain(newer.nativeId);

  // 30 case 12: with no spare at all the refills are simply absent — no worker, no delegation, no
  // processing reset, no coverage claim, and the required material is untouched.
  const runsBefore = memory.store.listRuns(s.id).length;
  envelope(windows.knowledge + windows.required.facts + windows.required.raw, windows.knowledge);
  const tight = memory.compact(s.id, "main", selected.id);
  expect("native" in tight).toBe(false);
  const bare = compacted(tight);
  expect(bare).toContain("PENDING_FACT"); expect(bare).toContain("STILL_PENDING");
  for (const absent of ["HISTORY_OLD", "HISTORY_NEW", "EXTRACTED_OLD", "EXTRACTED_NEW"]) expect(bare).not.toContain(absent);
  expect("native" in tight ? [] : tight.supplied.factIds).toEqual([pending.id]);
  expect("native" in tight ? [] : tight.supplied.entries.map(e => e.id)).toEqual([open.id]);
  const tightWindows = charged(tight);
  expect(tightWindows.knowledge + tightWindows.facts + tightWindows.raw).toBeLessThanOrEqual(tightWindows.envelope);
  expect(memory.store.listRuns(s.id)).toHaveLength(runsBefore);
  expect(memory.pendingEntries(s.id, "main", selected.id).map(e => e.id)).toEqual([open.id]);
  expect(calls).toBe(0);
  defaultWindows();
});

test("28a: refill (a) takes the most recent consolidated facts first, whole, and stops at the remaining budget", () => {
  const s = session(), t = turn(s.id, "head");
  const older = pendingFacts(s.id, t.id, ["OLDEST " + "word ".repeat(400)])[0]!;
  const newer = pendingFacts(s.id, t.id, ["NEWEST " + "word ".repeat(400)])[0]!;
  consolidate(s.id, [older.id, newer.id]);
  expect(newer.id).toBeGreaterThan(older.id);
  const measured = charged(memory.compact(s.id, "main", t.id));
  // Room for one whole refilled fact and the receipt naming the other: freshness decides which.
  const receipt = tokens(`omitted 1 older facts; expand: F${older.id}`) + tokens("Receipts:") + 2;
  envelope(measured.knowledge + measured.required.facts + measured.required.raw + receipt + 600, measured.knowledge);
  const text = compacted(memory.compact(s.id, "main", t.id));
  expect(text).toContain("NEWEST"); expect(text).not.toContain("OLDEST");
  expect(text).toContain(`omitted 1 older facts; expand: F${older.id}`);
  defaultWindows();
});
