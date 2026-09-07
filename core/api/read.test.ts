import { afterEach, beforeEach, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { TraceMemory } from "./index.ts";

const fixture = JSON.parse(readFileSync(new URL("../../test/fixtures/recording/facts.json", import.meta.url), "utf8"));
const rawFixture = JSON.parse(readFileSync(new URL("../../test/fixtures/recording/turns.json", import.meta.url), "utf8"));
const time = "2026-09-06T00:00:00Z";
let memory: TraceMemory, calls: number;
beforeEach(() => { calls = 0; memory = TraceMemory(":memory:", async () => { calls++; return { outcome: "success", output: [], request: {} }; }); });
afterEach(() => memory.close());
function session(projectId?: number, declaration: "marker" | "undeclared" = "marker") {
  const project = projectId ?? memory.store.createProject({ name: "mapC", declaredBy: "marker" }).id;
  return memory.store.createSession({ host: "fake", startedAt: time, firstReplyAt: time, projectId: project, projectDeclaration: declaration });
}
function turn(sessionId: number, text = fixture.base, parentTurnId?: number) {
  return memory.store.appendTurn({ sessionId, userPrompt: text, assistantText: null, parentTurnId, kind: "turn", startedAt: time });
}
function recording(sessionId: number, turnId: number, text = fixture.base, branch = "main", pending = false) {
  const result = memory.store.commitRecordingRun({ run: { sessionId, branch, kind: "recording", createdAt: time },
    facts: [{ turnId, text, category: "decision", actor: "user", source: [`T${turnId}#user`], createdAt: time }],
    watermark: { sessionId, branch, lastRecordedTurn: turnId },
    ...(pending ? { pendingDelivery: { sessionId, branch } } : {}) });
  if (!result.ok) throw new Error(result.problems.join("\n"));
  return result;
}
function knowledge(sessionId: number, factId: number, category: "constraint" | "open" | "dispute" | "goal" | "mechanism" | "term" | "reference" = "constraint",
  scope: "session" | "project" | "global" = "project", text = fixture.knowledge, createdAt = time) {
  const result = memory.store.commitIntegrationRun({ run: { sessionId, branch: "main", kind: "integration", createdAt: time },
    operations: [{ op: "create", handle: "$e1", author: "fake", text, category, scope, supports: [factId], createdAt }],
    watermark: { sessionId, branch: "main", lastIntegratedFact: factId } });
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.committed[0]!.knowledgeId;
}
function populated() {
  const s = session(), t = turn(s.id), n = recording(s.id, t.id), f = n.facts[0]!;
  const e = knowledge(s.id, f.id);
  return { s, t, f, e };
}
const golden = (name: string) => readFileSync(new URL(`../../test/fixtures/read/${name}.txt`, import.meta.url), "utf8").trimEnd();

test("injection and compaction match Chinese fixture goldens without a model call", () => {
  const { s, t } = populated();
  turn(s.id, rawFixture[1].userPrompt, t.id);
  expect(memory.inject(s.id)).toBe(golden("inject"));
  expect(memory.compact(s.id, "main")).toBe(golden("compact"));
  expect(calls).toBe(0);
});

test("injection stays byte-identical across a no-op recording and has no XML attributes", async () => {
  const { s, t } = populated();
  const before = memory.inject(s.id), next = turn(s.id, fixture.observation, t.id);
  expect((await memory.record({ sessionId: s.id, branch: "main", headTurnId: next.id })).outcome).toBe("success");
  expect(memory.inject(s.id)).toBe(before);
  expect(memory.deliver(s.id, "main")).toBe(""); // the no-op recording wrote no facts; its delivery is consumed anyway
  expect(memory.store.listPendingDeliveries(s.id, "main")).toEqual([]);
  expect(memory.inject(s.id)).toBe(before);
  for (const tag of before.match(/<[^>]+>/g)!) expect(tag).toMatch(/^<\/?[a-z_]+>$/);
});

test("visibility includes global, own project and own session only, excluding inactive knowledge", () => {
  const { s, f } = populated(), peer = session(s.projectId), foreign = session();
  const own = knowledge(s.id, f.id, "open", "session"), other = knowledge(peer.id, f.id, "open", "session");
  const outside = knowledge(foreign.id, f.id), global = knowledge(foreign.id, f.id, "goal", "global");
  const archived = knowledge(s.id, f.id, "reference");
  memory.store.commitIntegrationRun({ run: { sessionId: s.id, kind: "integration", createdAt: time },
    operations: [{ op: "archive", knowledgeId: archived, expectedRevision: 1, because: [f.id], createdAt: time }] });
  for (const block of [memory.inject(s.id), memory.compact(s.id)]) {
    expect(block).toContain(`[K${own}@1]`); expect(block).toContain(`[K${global}@1]`);
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
  memory.config.render.knowledgeBlockTokens = 0;
  const limited = memory.inject(s.id);
  for (const tag of tags.slice(0, 3)) expect(limited).toContain(`<${tag}>`);
  for (const tag of tags.slice(3)) { expect(limited).not.toContain(`<${tag}>`); expect(limited).toContain(`1 ${tag} knowledge; expand:`); }
  expect(limited.indexOf("Receipts:")).toBeGreaterThan(limited.indexOf("</knowledge>"));
  for (const id of ids.slice(0, 4)) expect(memory.trace(`K${id}`)).toContain(`[K${id}@1]`);
});

test("compaction retains oversized raw with standard tool cuts and receipts outside XML", () => {
  const { s, t } = populated(), raw = fixture.observation.repeat(1000);
  const next = turn(s.id, raw, t.id);
  memory.store.appendToolCall({ turnId: next.id, name: "Bash", input: "pwd", result: JSON.stringify({ stdout: "x".repeat(10000) }), status: "success" });
  memory.config.render.episodicBlockTokens = 1;
  const result = memory.compact(s.id, "main", next.id);
  expect(result).toContain(raw); expect(result).toContain("omitted 1 lines, 10000 characters");
  expect(result).toContain("raw overage:"); expect(result).toContain("all unrecorded raw kept");
  expect(result).toContain("omitted 1 older facts; expand: F1");
  expect(result.indexOf("Receipts:")).toBeGreaterThan(result.indexOf("</episodic>"));
  expect(calls).toBe(0);
});

test("compaction uses supplied ancestry and newest facts fit before older facts", () => {
  const { s, t } = populated();
  const abandoned = turn(s.id, "abandoned raw", t.id), selected = turn(s.id, "selected raw", t.id);
  const precise = memory.compact(s.id, "main", selected.id);
  expect(precise).toContain("selected raw"); expect(precise).not.toContain("abandoned raw");
  expect(memory.compact(s.id)).toContain("abandoned raw");
  const n = recording(s.id, selected.id, fixture.interpretation);
  const full = memory.compact(s.id, "main", selected.id);
  expect(full.indexOf(`[F${n.facts[0]!.id}]`)).toBeLessThan(full.indexOf("[F1]"));
  memory.config.render.episodicBlockTokens = 40;
  const limited = memory.compact(s.id, "main", selected.id);
  expect(limited).toContain(`[F${n.facts[0]!.id}]`); expect(limited).not.toContain("[F1]");
  expect(memory.store.getTurn(abandoned.id)).not.toBeNull();
});

test("pending delivery is exact to its run and branch, consumed once, including after later commits", () => {
  const s = session(), t = turn(s.id);
  const first = recording(s.id, t.id, "first delivery", "main", true);
  const second = recording(s.id, t.id, "second delivery", "other", true);
  expect(memory.deliver(s.id, "unrelated")).toBe("");
  const delivery = memory.deliver(s.id, "main");
  expect(delivery).toContain("first delivery"); expect(delivery).not.toContain("second delivery");
  expect(memory.deliver(s.id, "main")).toBe("");
  expect(memory.inject(s.id)).not.toContain("recorded");
  expect(memory.store.listPendingDeliveries(s.id, "other").map((p) => p.runId)).toEqual([second.runId]);
  expect(memory.deliver(s.id, "other")).toContain("second delivery");
  expect(JSON.parse(memory.store.getRun(first.runId)!.response!).factIds).toEqual([first.facts[0]!.id]);
});

test("delivery and branch facts use run ownership independently of audit JSON", () => {
  const s = session(), t = turn(s.id);
  const first = recording(s.id, t.id, "recorded", "main", true);
  memory.tools({ kind: "manual", sessionId: s.id, branch: "other", currentTurnId: t.id })[2]!.execute({
    facts: [{ category: "decision", actor: "user", text: "manual", source: [`T${t.id}#user`] }] });
  const manual = memory.store.listRuns(s.id).at(-1)!;
  memory.store.db.exec("UPDATE runs SET response = 'not JSON'");
  expect(memory.store.listBranchFacts(s.id, "main").map(f => f.text)).toEqual(["recorded"]);
  expect(memory.store.listBranchFacts(s.id, "other").map(f => f.text)).toEqual(["manual"]);
  expect(memory.deliver(s.id)).toContain("recorded");
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
  const edit = memory.store.commitIntegrationRun({ run: { sessionId: s.id, kind: "integration", createdAt: time }, operations: [{
    op: "update", knowledgeId: e, expectedRevision: 1, text: fixture.editedKnowledge, category: "constraint", scope: "project", supports: [f.id], because: [f.id], createdAt: time }] });
  expect(edit.ok).toBe(true); expect(memory.inject(s.id)).not.toContain("verified");
  expect(memory.trace(`K${e}`)).not.toContain("· verified");
  expect(memory.trace(`K${e}@1`)).toContain("· verified");
  memory.mark(e, "flagged"); expect(memory.inject(s.id)).toContain("· flagged");
  memory.mark(e, "verified"); expect(memory.store.listKnowledgeMarks(e).filter((m) => m.rev === 2)).toHaveLength(1);
  memory.mark(e, "clear"); expect(memory.inject(s.id)).not.toContain("verified");
  expect(memory.store.listKnowledgeMarks(e).map((m) => m.rev)).toEqual([1]);
});

test("FTS searches facts and historical knowledge, while raw LIKE searches only the selected session", () => {
  const s = session(), t = turn(s.id, "needle raw"), n = recording(s.id, t.id, "needle fact");
  const e = knowledge(s.id, n.facts[0]!.id, "goal", "project", "needle knowledge");
  expect(memory.search("needle", "facts")).toContain("[F1]"); expect(memory.search("needle", "facts")).not.toContain("[K");
  expect(memory.search("needle", "knowledge")).toContain(`[K${e}@1]`); expect(memory.search("needle", "knowledge")).not.toContain("[F1]");
  const all = memory.search("needle", "all"); expect(all).toContain("[F1]"); expect(all).toContain(`[K${e}@1]`);
  expect(all.split("\n").filter((l) => l.startsWith("["))).toHaveLength(2);
  memory.store.commitIntegrationRun({ run: { sessionId: s.id, kind: "integration", createdAt: time }, operations: [{
    op: "update", knowledgeId: e, expectedRevision: 1, text: "replacement knowledge", category: "goal", scope: "project", supports: [1], because: [1], createdAt: time }] });
  expect(memory.search("needle", "knowledge")).toContain(`[K${e}@1]`);
  expect(memory.search("needle", "knowledge")).not.toContain(`[K${e}@2]`);
  const other = session(), foreign = turn(other.id, "needle foreign");
  memory.store.appendToolCall({ turnId: t.id, name: "Bash", input: "toolonly", result: "literal%_", status: "success" });
  const raw = memory.search("toolonly", "raw", { sessionId: s.id });
  expect(raw).toContain(`[S${s.id}/T${t.id}]`); expect(raw).toContain("literal LIKE"); expect(raw).not.toContain(`T${foreign.id}`);
  expect(memory.search("%_", "raw", { sessionId: s.id })).toContain(`[S${s.id}/T${t.id}]`);
  expect(() => memory.search("needle", "raw")).toThrow("requires an existing sessionId");
  expect(memory.search("nohits", "all")).toContain("No hit does not mean absent.");
});

test("opaque cursors continue search snapshots and trace session, comma, revision and negation listings", () => {
  const { s, t, f, e } = populated();
  turn(s.id, "second turn", t.id);
  recording(s.id, t.id, fixture.base);
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
  const { s, t } = populated(); recording(s.id, t.id, fixture.observation, "side", true);
  const status = memory.status(s.id);
  for (const text of ["Project: mapC (marker)", "Facts: 2 session; 2 project", "Knowledge: 1 visible active", "Watermark main: recorded T1; integrated F1", "Watermark side: recorded T1; integrated none", "Last recording: run 3 success", "Last integration: run 2 success", "Pending deliveries: 1"]) expect(status).toContain(text);
});

test("project mark merges an undeclared own project, relabels facts and knowledge, and beats later marker reports", () => {
  const s = session(undefined, "undeclared"), t = turn(s.id), n = recording(s.id, t.id), f = n.facts[0]!;
  const e = knowledge(s.id, f.id), own = knowledge(s.id, f.id, "open", "session");
  expect(memory.declareProject(s.id, "declared")).toContain("declared (mark)");
  const project = memory.store.findProjectByName("declared")!;
  expect(memory.store.getProject(s.projectId)!.mergedInto).toBe(project.id);
  expect(memory.store.listProjectFacts(project.id).map((f) => f.id)).toEqual([f.id]);
  expect(memory.store.getKnowledge(e)!.projectId).toBe(project.id);
  const peer = session(project.id);
  expect(memory.inject(peer.id)).toContain(`[K${e}@1]`); expect(memory.inject(peer.id)).not.toContain(`[K${own}@1]`);
  memory.declareProject(s.id, "ignored marker", "marker");
  expect(memory.store.getSession(s.id)!.projectId).toBe(project.id);
  expect(memory.store.findProjectByName("ignored marker")).toBeNull();
  memory.declareProject(s.id, "next");
  expect(memory.store.getSession(peer.id)!.projectId).toBe(project.id);
  expect(memory.store.getProject(project.id)!.mergedInto).toBeNull();
  expect(memory.inject(s.id)).toContain(`[K${own}@1]`);
});

test("default listing caps continue all hits and freeze the remaining search results", () => {
  const s = session(), t = turn(s.id);
  const result = memory.store.commitRecordingRun({ run: { sessionId: s.id, kind: "recording", createdAt: time },
    facts: Array.from({ length: 101 }, (_, i) => ({ turnId: t.id, text: `needle ${i}`, category: "observation" as const,
      actor: "agent" as const, source: [`T${t.id}#assistant`], createdAt: time })) });
  expect(result.ok).toBe(true);
  const first = memory.search("needle");
  expect(first.split("\n").filter((l) => l.startsWith("[F"))).toHaveLength(100);
  const cursor = /cursor=(\S+)/.exec(first)![1]!;
  recording(s.id, t.id, "needle added later");
  const last = memory.search("", "all", { cursor });
  expect(last).toContain("[F101]"); expect(last).not.toContain("[F102]");
  expect(last).not.toContain("cursor=");
});

test("a delivery is preserved on render failure", () => {
  const s = session(), t = turn(s.id);
  recording(s.id, t.id, "pending fact", "main", true);
  expect(() => memory.store.deliver(s.id, "main", () => { throw new Error("render failed"); })).toThrow("render failed");
  expect(memory.store.listPendingDeliveries(s.id, "main")).toHaveLength(1);
  expect(memory.deliver(s.id)).toContain("pending fact");
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
