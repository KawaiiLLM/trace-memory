import { afterEach, beforeEach, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { TraceMemory, compacted, renderEntry, tokens, ENTRY_VIEW_VERSION } from "../../source-fixture.ts";

const fixture = JSON.parse(readFileSync(new URL("../../fixtures/noting/facts.json", import.meta.url), "utf8"));
const rawFixture = JSON.parse(readFileSync(new URL("../../fixtures/noting/turns.json", import.meta.url), "utf8"));
const time = "2026-09-06T00:00:00Z";
let memory: TraceMemory, calls: number;
beforeEach(() => { calls = 0; memory = TraceMemory(":memory:", async () => { calls++; return { outcome: "success", output: [], request: {} }; }); });
afterEach(() => memory.close());
function session(projectId?: number, declaration: "marker" | "undeclared" = "marker") {
  const project = projectId ?? memory.store.createProject({ name: "mapC", declaredBy: "marker" }).id;
  return memory.store.createSession({ enrollmentChoice: true, host: "fake", startedAt: time, firstReplyAt: time, projectId: project, projectDeclaration: declaration });
}
function turn(sessionId: number, text = fixture.base, parentTurnId?: number) {
  return memory.store.appendTurn({ sessionId, userPrompt: text, assistantText: null, parentTurnId, kind: "turn", startedAt: time });
}
function noting(sessionId: number, turnId: number, text = fixture.base, branch = "main", pending = false) {
  const result = memory.store.commitNotingRun({ run: { sessionId, branch, kind: "noting", createdAt: time },
    facts: [{ turnId, text, category: "decision", actor: "user", source: [`T${turnId}#user`], createdAt: time }],
    entryIds: memory.store.sourcePath(sessionId, branch, turnId).map(e => e.id),
    ...(pending ? { pendingDelivery: { sessionId, branch } } : {}) });
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

test("injection and compaction match Chinese fixture goldens without a model call", () => {
  const { s, t } = populated();
  turn(s.id, rawFixture[1].userPrompt, t.id);
  expect(memory.inject(s.id)).toBe(golden("inject"));
  expect(compacted(memory.compact(s.id, "main"))).toBe(golden("compact"));
  expect(calls).toBe(0);
});

test("injection stays byte-identical across a no-op noting and has no XML attributes", async () => {
  const { s, t } = populated();
  const before = memory.inject(s.id), next = turn(s.id, fixture.observation, t.id);
  expect((await memory.noting({ sessionId: s.id, branch: "main", headTurnId: next.id })).outcome).toBe("success");
  expect(memory.inject(s.id)).toBe(before);
  const empty = memory.deliver(s.id, "main"); expect(empty.text).toBe(""); // the no-op noting wrote no facts
  memory.confirmDelivery(empty.runIds); expect(memory.store.listPendingDeliveries(s.id, "main")).toEqual([]);
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

test("compaction retains oversized raw with standard tool cuts, in its primary views", () => {
  const { s, t } = populated(), raw = fixture.observation.repeat(1000);
  const next = turn(s.id, raw, t.id);
  memory.store.appendToolCall({ turnId: next.id, name: "Bash", input: "pwd", result: JSON.stringify({ stdout: "x".repeat(10000) }), status: "success" });
  // 20c: tier 1 applies only while the primary views fit both shared caps. This case is about those
  // views' own cuts, not about escalation, so it gives them the room; the tiers have their own tests.
  memory.config.noting.batchTokens = 100_000; memory.config.render.episodicBlockTokens = 200_000;
  const compaction = memory.compact(s.id, "main", next.id);
  expect(compaction.tier).toBe("primary");
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
  const full = compacted(memory.compact(s.id, "main", selected.id));
  expect(full.indexOf("[F1]")).toBeLessThan(full.indexOf(`[F${n.facts[0]!.id}]`)); // chronological presentation
  // 20b charges the block titles and the joining separators too, so the same "one fact fits, the
  // older one does not" budget is a little larger than 17a's bare fact-line arithmetic.
  memory.config.render.episodicBlockTokens = 100 + tokens(`[T${selected.id}] ${selected.startedAt} (selected facts)\n`);
  const limited = compacted(memory.compact(s.id, "main", selected.id));
  expect(limited).toContain(`[F${n.facts[0]!.id}]`); expect(limited).not.toContain("[F1]");
  expect(memory.store.getTurn(abandoned.id)).not.toBeNull();
});

// ---- Ticket 20 "Compaction escalation" (20c): the three tiers over one frozen read snapshot ----

test("20c 2026-09-08 scenario 9: all pending primary views fit, historical facts take the remaining shared space, and no worker starts or progress changes", () => {
  const { s, t } = populated();
  const selected = turn(s.id, "selected raw", t.id);
  const second = noting(s.id, t.id, fixture.interpretation).facts[0]!; // a newer fact on an already-processed turn
  const pending = memory.pendingEntries(s.id, "main", selected.id);
  const runsBefore = memory.store.listRuns(s.id).length;
  const result = memory.compact(s.id, "main", selected.id);
  expect(result.tier).toBe("primary");
  const text = compacted(result);
  // Every pending entry is present in its normal shared view, and both historical facts fit beside them.
  for (const entry of pending) expect(text).toContain(renderEntry(entry, memory.config.render).content);
  expect(text).toContain(`[F${second.id}]`); expect(text).toContain("[F1]");
  expect(text).not.toContain("compact-only");
  // Reading a snapshot is not extraction: no model call, no run, no progress, no claim.
  expect(calls).toBe(0);
  expect(memory.store.listRuns(s.id)).toHaveLength(runsBefore);
  expect(memory.pendingEntries(s.id, "main", selected.id).map(e => e.id)).toEqual(pending.map(e => e.id));
  // Historical facts fill only what the selected material and the framing left, and the honest
  // omission receipt for the rest sits outside the block, as every other receipt does.
  memory.config.render.episodicBlockTokens = 105 + tokens(`[T${t.id}] ${t.startedAt} (selected facts)\n`); // one fact plus its Turn heading
  const limited = compacted(memory.compact(s.id, "main", selected.id));
  expect(limited).toContain(`[F${second.id}]`); expect(limited).not.toContain("[F1]");
  expect(limited).toContain("omitted 1 older facts; expand: F1");
  expect(limited.indexOf("Receipts:")).toBeGreaterThan(limited.indexOf("</episodic>"));
});

test("20c/23 2026-09-08 scenario 10: primary views over the shared ceiling become tier-2 views of the same renderer, still every entry, under the tier-2 profile", () => {
  const { s, t } = populated();
  const body = "word ".repeat(12_000);
  const next = turn(s.id, `USER_HEAD ${body} USER_TAIL`, t.id);
  memory.store.appendToolCall({ turnId: next.id, name: "Bash", input: JSON.stringify({ command: "SECRET_ARGUMENT" }),
    result: JSON.stringify({ stdout: "SECRET_RESULT " + "x".repeat(4_000) }), status: "success" });
  const pending = memory.pendingEntries(s.id, "main", next.id);
  const result = memory.compact(s.id, "main", next.id);
  expect(result.tier).toBe("secondary");
  const text = compacted(result);
  // Explicitly labelled, and named with the view version and the profile that produced these views,
  // so a reader knows which rule truncated the text in front of them (23, superseding 20c's own view).
  expect(text).toContain(`Raw (tier-2 entry views, ${ENTRY_VIEW_VERSION}, tool call budget 100 tokens, entry budget 1000 tokens):`);
  expect(text).not.toContain("\nRaw:\n");
  // Every selected entry is represented, in order, by the addresses its labels carry; native identity
  // stays in storage and in the run audit, never in the model-facing text.
  const profile = { toolCallTokens: 100, entryTokens: 1000 };
  for (const entry of pending) {
    const view = renderEntry(entry, profile, memory.resultText).content;
    expect(text).toContain(view);
    expect(tokens(view)).toBeLessThanOrEqual(1000);
  }
  expect(text).not.toContain(`[entry ${JSON.stringify([pending[0]!.nativeLineage, pending[0]!.nativeId])}]`);
  expect(text.indexOf(`[T${next.id}#user]:`)).toBeLessThan(text.indexOf(`[T${next.id}#t1]`));
  // Tool identity and status remain, and so does what the tighter budget can hold of the payload.
  expect(text).toContain(`[T${next.id}#t1] Bash(command="SECRET_ARGUMENT")`);
  expect(text).toContain(`[T${next.id}#t1] Bash success: `);
  expect(text).toContain("SECRET_RESULT"); expect(text).not.toContain("x".repeat(4_000));
  // User text is excerpted, and the omission is marked in the wording the tier-1 view already uses.
  expect(text).toContain("USER_HEAD"); expect(text).not.toContain(body);
  expect(text).toMatch(/\[\.\.\. \d+ characters truncated\]/);
  // Deterministic local work: the same snapshot renders the same bytes, and no model was called.
  expect(compacted(memory.compact(s.id, "main", next.id))).toBe(text);
  expect(calls).toBe(0);
  // The stored evidence is untouched by any of it: `full` still renders it uncut, and the assembled
  // read without `full` (23b) is the same tier-1 view of the same entry, cut only where `E` bites.
  expect(memory.trace(`T${next.id}#user`, { full: true })).toContain(body);
  expect(memory.trace(`T${next.id}#user`)).toContain("USER_HEAD");
  expect(memory.trace(`T${next.id}`, { tool: 1, full: true })).toContain("SECRET_ARGUMENT");
  expect(memory.trace(`T${next.id}`, { tool: 1, full: true })).toContain("SECRET_RESULT");
});

/** The compact-only secondary view ticket 23 deleted (20c's `renderEntrySecondary`, copied from
 * e7cd633 and kept here alone): the conversation-dense acceptance below compares tier 2's total
 * against the total this retired view produced on the same frozen set. Nothing else uses it. */
function retiredSecondaryView(entry: { sessionId: number; turnId: number; nativeLineage: string; nativeId: string; role: string; text: string; calls: { ordinal: number; name: string; callId: string; status: string }[] }): string {
  const excerpt = (label: string, body: string, cap: number) => {
    const whole = `${label}\n${body}`, characters = [...body];
    const at = (kept: number) => `${label}\n${characters.slice(0, Math.ceil(kept / 2)).join("")}\n[omitted ${characters.length - kept} characters; middle not inspected]\n${Math.floor(kept / 2) ? characters.slice(-Math.floor(kept / 2)).join("") : ""}`;
    if (tokens(whole) <= cap) return whole;
    let low = 0, high = characters.length - 1;
    while (low < high) { const mid = Math.ceil((low + high) / 2); if (tokens(at(mid)) <= cap) low = mid; else high = mid - 1; }
    return at(low);
  };
  const lines = [`[S${entry.sessionId}/T${entry.turnId}] [entry ${JSON.stringify([entry.nativeLineage, entry.nativeId])}] [compact-only view 20c-v1-bounded-excerpts]`];
  if (entry.text || entry.role === "user") {
    const role = entry.role === "user" ? "user" : "assistant";
    lines.push(excerpt(`[Source entry id: T${entry.turnId}#${role}]`, entry.text || "[non-text content omitted]", role === "user" ? 120 : 60));
  }
  for (const call of entry.calls) lines.push(`[T${entry.turnId}#t${call.ordinal}] tool=${call.name} call=${call.callId} status=${call.status} [${entry.role === "toolResult" ? "result" : "arguments"} omitted]`);
  return lines.join("\n");
}

test("23 2026-09-09 conversation-dense acceptance, amended by the user the same day (tier-2 E = 1,000): a dozen long replies escalate to native with the reason, four longer ones fit tier 2", () => {
  const s = session();
  // Long replies with few tool calls: the shape the retired view handled and tier 1 cannot.
  let parent: number | undefined;
  for (let i = 0; i < 12; i++) {
    const t = turn(s.id, `Question ${i}: ` + "word ".repeat(30), parent);
    memory.store.updateTurn(t.id, { assistantText: `Answer ${i}: ` + "word ".repeat(1_000) });
    parent = t.id;
  }
  memory.store.appendToolCall({ turnId: parent!, name: "bash", input: JSON.stringify({ command: "npm test" }), result: "ok", status: "success" });
  const pending = memory.pendingEntries(s.id, "main", parent!);
  const profile = { toolCallTokens: memory.config.render.secondaryToolCallTokens, entryTokens: memory.config.render.secondaryEntryTokens };
  const total = (views: string[]) => tokens(views.join("\n\n"));
  const tier1 = total(pending.map(e => renderEntry(e, memory.config.render).content));
  const tier2 = total(pending.map(e => renderEntry(e, profile, memory.resultText).content));
  const retired = total(pending.map(retiredSecondaryView));
  // Tier 1 is over the shared Raw ceiling, so this set escalates; the retired view fitted it.
  expect(tier1).toBeGreaterThan(memory.config.noting.batchTokens);
  expect(retired).toBeLessThan(memory.config.noting.batchTokens);
  // The user raised the tier-2 E from 150 to 1,000 (2026-09-09): a long reply keeps up to a thousand
  // tokens instead of a label and a few lines, so tier 2 no longer guarantees what the retired view
  // fitted. A dozen such replies exceed the raw ceiling under tier 2 as well, and compact says so
  // instead of cutting harder than the profile allows.
  expect(tier2).toBeGreaterThan(memory.config.noting.batchTokens);
  const result = memory.compact(s.id, "main", parent!);
  expect(result.tier).toBe("native");
  expect((result as { reason: string }).reason).toContain("tier-2 views");
  for (const entry of pending) expect(tokens(renderEntry(entry, profile, memory.resultText).content)).toBeLessThanOrEqual(profile.entryTokens);
  // Four replies three times as long are over the ceiling for tier 1 (kept whole) and fit tier 2
  // (each cut to E), every entry represented under the tier-2 profile.
  const s2 = session();
  let parent2: number | undefined;
  for (let i = 0; i < 4; i++) {
    const t = turn(s2.id, `Question ${i}: ` + "word ".repeat(30), parent2);
    memory.store.updateTurn(t.id, { assistantText: `Answer ${i}: ` + "word ".repeat(3_000) });
    parent2 = t.id;
  }
  expect(total(memory.pendingEntries(s2.id, "main", parent2!).map(e => renderEntry(e, memory.config.render).content))).toBeGreaterThan(memory.config.noting.batchTokens);
  const fewer = memory.compact(s2.id, "main", parent2!);
  expect(fewer.tier).toBe("secondary");
  for (const entry of memory.pendingEntries(s2.id, "main", parent2!)) expect(compacted(fewer)).toContain(renderEntry(entry, profile, memory.resultText).content);
});

test("20c 2026-09-08 scenario 11: when even secondary views miss a cap compact asks for native compaction with the reason, and changes nothing", () => {
  const { s, t } = populated();
  let parent = t.id;
  for (let i = 0; i < 40; i++) parent = turn(s.id, `entry ${i}`, parent).id;
  const pending = memory.pendingEntries(s.id, "main", parent).map(e => e.id);
  expect(pending.length).toBeGreaterThanOrEqual(40);
  // Many tiny entries: their identities and labels alone exceed the enclosing budget.
  memory.config.render.episodicBlockTokens = 200;
  const outer = memory.compact(s.id, "main", parent);
  expect(outer.tier).toBe("native");
  expect(outer.tier === "native" && outer.reason).toContain("the episodic budget by");
  expect(outer.tier === "native" && outer.reason).toContain(`tier-2 views of ${pending.length} pending entries`);
  expect("text" in outer).toBe(false); // not an empty success, and no oversized block either
  // The same escalation on the inner ceiling names that cap instead.
  memory.config.render.episodicBlockTokens = 200_000; memory.config.noting.batchTokens = 50;
  const inner = memory.compact(s.id, "main", parent);
  expect(inner.tier).toBe("native");
  expect(inner.tier === "native" && inner.reason).toContain("the raw ceiling by");
  // Delegation is a request, not a summary: nothing was read differently, processed or erased.
  expect(memory.pendingEntries(s.id, "main", parent).map(e => e.id)).toEqual(pending);
  expect(memory.trace(`T${parent}#user`)).toContain("entry 39");
  expect(calls).toBe(0);
});

test("pending delivery is exact to its run and branch, consumed once, including after later commits", () => {
  const s = session(), t = turn(s.id);
  const first = noting(s.id, t.id, "first delivery", "main", true);
  const second = noting(s.id, t.id, "second delivery", "other", true);
  expect(memory.deliver(s.id, "unrelated").text).toBe("");
  const delivery = memory.deliver(s.id, "main");
  expect(delivery.text).toContain("first delivery"); expect(delivery.text).not.toContain("second delivery");
  expect(memory.deliver(s.id, "main").text).toContain("first delivery"); // unconfirmed: delivered again, never silently lost
  memory.confirmDelivery(delivery.runIds);
  expect(memory.deliver(s.id, "main").text).toBe("");
  expect(memory.inject(s.id)).not.toContain("noted");
  expect(memory.store.listPendingDeliveries(s.id, "other").map((p) => p.runId)).toEqual([second.runId]);
  expect(memory.deliver(s.id, "other").text).toContain("second delivery");
  expect(JSON.parse(memory.store.getRun(first.runId)!.response!).factIds).toEqual([first.facts[0]!.id]);
});

test("delivery and branch facts use run ownership independently of audit JSON", () => {
  const s = session(), t = turn(s.id);
  const first = noting(s.id, t.id, "noted", "main", true);
  memory.tools({ kind: "manual", sessionId: s.id, branch: "other", currentTurnId: t.id })[2]!.execute({
    facts: [{ category: "decision", actor: "user", text: "manual", source: [`T${t.id}#user`] }] });
  const manual = memory.store.listRuns(s.id).at(-1)!;
  memory.store.db.exec("UPDATE runs SET response = 'not JSON'");
  expect(memory.store.listBranchFacts(s.id, "main").map(f => f.text)).toEqual(["noted", "manual"]); // facts belong to their turn, whichever branch wrote them
  expect(memory.store.listBranchFacts(s.id, "other").map(f => f.text)).toEqual(["noted", "manual"]); // same turn, same path
  expect(memory.deliver(s.id).text).toContain("noted");
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

test("status reports attribution, counts, every watermark, last runs and pending deliveries", () => {
  const { s, t } = populated(); noting(s.id, t.id, fixture.observation, "side", true);
  const status = memory.status(s.id);
  expect(status).not.toContain("Watermark");
  for (const text of ["Project: mapC (marker)", "Facts: 2 session; 2 project", "Knowledge: 1 visible active", "Last noting: run 3 success", "Last consolidation: run 2 success", "Pending deliveries: 1"]) expect(status).toContain(text);
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

test("default listing caps continue all hits and freeze the remaining search results", () => {
  const s = session(), t = turn(s.id);
  const result = memory.store.commitNotingRun({ run: { sessionId: s.id, kind: "noting", createdAt: time },
    facts: Array.from({ length: 101 }, (_, i) => ({ turnId: t.id, text: `needle ${i}`, category: "observation" as const,
      actor: "agent" as const, source: [`T${t.id}#assistant`], createdAt: time })) });
  expect(result.ok).toBe(true);
  const first = memory.search("needle");
  expect(first.split("\n").filter((l) => l.startsWith("[F"))).toHaveLength(100);
  const cursor = /cursor=(\S+)/.exec(first)![1]!;
  noting(s.id, t.id, "needle added later");
  const last = memory.search("", "all", { cursor });
  expect(last).toContain("[F101]"); expect(last).not.toContain("[F102]");
  expect(last).not.toContain("cursor=");
});

test("a delivery is preserved on render failure", () => {
  const s = session(), t = turn(s.id);
  noting(s.id, t.id, "pending fact", "main", true);
  expect(() => memory.store.deliver(s.id, "main", () => { throw new Error("render failed"); })).toThrow("render failed");
  expect(memory.store.listPendingDeliveries(s.id, "main")).toHaveLength(1);
  expect(memory.deliver(s.id).text).toContain("pending fact");
});

test("first-prompt injection by project needs no session: global and project knowledge, no deliveries", () => {
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
