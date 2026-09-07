import { afterEach, beforeEach, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { TraceMemory } from "../../test/source-fixture.ts";

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
    entryIds: memory.store.sourcePath(sessionId, branch, turnId).map(e => e.id),
    ...(pending ? { pendingDelivery: { sessionId, branch } } : {}) });
  if (!result.ok) throw new Error(result.problems.join("\n"));
  return result;
}
function knowledge(sessionId: number, factId: number, category: "constraint" | "open" | "dispute" | "goal" | "mechanism" | "term" | "reference" = "constraint",
  scope: "session" | "project" | "global" = "project", text = fixture.knowledge, createdAt = time) {
  const result = memory.store.commitIntegrationRun({ run: { sessionId, branch: "main", kind: "integration", createdAt: time },
    operations: [{ op: "create", handle: "$e1", author: "fake", text, category, scope, supports: [factId], createdAt }],
    integrated: memory.store.getSession(sessionId)!.projectId === memory.store.getSession(memory.store.getTurn(memory.store.getFact(factId)!.turnId)!.sessionId)!.projectId ? [factId] : [] });
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
  const empty = memory.deliver(s.id, "main"); expect(empty.text).toBe(""); // the no-op recording wrote no facts
  memory.confirmDelivery(empty.runIds); expect(memory.store.listPendingDeliveries(s.id, "main")).toEqual([]);
  expect(memory.inject(s.id)).toBe(before);
  for (const tag of before.match(/<[^>]+>/g)!) expect(tag).toMatch(/^<\/?[a-z_]+>$/);
});

test("visibility includes global, own project and own session only, excluding inactive knowledge", () => {
  const { s, f } = populated(), peer = session(s.projectId), foreign = session();
  const own = knowledge(s.id, f.id, "open", "session"), other = knowledge(peer.id, recording(peer.id, turn(peer.id).id).facts[0]!.id, "open", "session");
  const outside = knowledge(foreign.id, recording(foreign.id, turn(foreign.id).id).facts[0]!.id), global = knowledge(foreign.id, f.id, "goal", "global");
  const archived = knowledge(s.id, f.id, "reference");
  memory.store.commitIntegrationRun({ run: { sessionId: s.id, kind: "integration", createdAt: time },
    operations: [{ op: "archive", knowledgeId: archived, baseCommit: archived, because: [f.id], createdAt: time }] });
  for (const block of [memory.inject(s.id), memory.compact(s.id)]) {
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
  memory.config.render.knowledgeBlockTokens = 0;
  const limited = memory.inject(s.id);
  for (const tag of tags.slice(0, 3)) expect(limited).toContain(`<${tag}>`);
  for (const tag of tags.slice(3)) { expect(limited).not.toContain(`<${tag}>`); expect(limited).toContain(`1 ${tag} knowledge; expand:`); }
  expect(limited.indexOf("Receipts:")).toBeGreaterThan(limited.indexOf("</knowledge>"));
  for (const id of ids.slice(0, 4)) expect(memory.trace(`K${id}`)).toContain(`[K${id}@${id}]`);
});

test("compaction retains oversized raw with standard tool cuts and receipts outside XML", () => {
  const { s, t } = populated(), raw = fixture.observation.repeat(1000);
  const next = turn(s.id, raw, t.id);
  memory.store.appendToolCall({ turnId: next.id, name: "Bash", input: "pwd", result: JSON.stringify({ stdout: "x".repeat(10000) }), status: "success" });
  memory.config.render.episodicBlockTokens = 70;
  const result = memory.compact(s.id, "main", next.id);
  // 17a supersedes unbounded user Raw: both excerpts retain head, omission count and tail.
  expect(result).not.toContain(raw); expect(result).toContain("middle not inspected");
  expect(result).toContain(raw.slice(0, 40)); expect(result).toContain(raw.slice(-40));
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
  // 17a: an omitted head resolves one path, never a union of sibling queues.
  expect(memory.compact(s.id)).not.toContain("abandoned raw");
  const n = recording(s.id, selected.id, fixture.interpretation);
  const full = memory.compact(s.id, "main", selected.id);
  expect(full.indexOf(`[F${n.facts[0]!.id}]`)).toBeLessThan(full.indexOf("[F1]"));
  memory.config.render.episodicBlockTokens = 70;
  const limited = memory.compact(s.id, "main", selected.id);
  expect(limited).toContain(`[F${n.facts[0]!.id}]`); expect(limited).not.toContain("[F1]");
  expect(memory.store.getTurn(abandoned.id)).not.toBeNull();
});

test("pending delivery is exact to its run and branch, consumed once, including after later commits", () => {
  const s = session(), t = turn(s.id);
  const first = recording(s.id, t.id, "first delivery", "main", true);
  const second = recording(s.id, t.id, "second delivery", "other", true);
  expect(memory.deliver(s.id, "unrelated").text).toBe("");
  const delivery = memory.deliver(s.id, "main");
  expect(delivery.text).toContain("first delivery"); expect(delivery.text).not.toContain("second delivery");
  expect(memory.deliver(s.id, "main").text).toContain("first delivery"); // unconfirmed: delivered again, never silently lost
  memory.confirmDelivery(delivery.runIds);
  expect(memory.deliver(s.id, "main").text).toBe("");
  expect(memory.inject(s.id)).not.toContain("recorded");
  expect(memory.store.listPendingDeliveries(s.id, "other").map((p) => p.runId)).toEqual([second.runId]);
  expect(memory.deliver(s.id, "other").text).toContain("second delivery");
  expect(JSON.parse(memory.store.getRun(first.runId)!.response!).factIds).toEqual([first.facts[0]!.id]);
});

test("delivery and branch facts use run ownership independently of audit JSON", () => {
  const s = session(), t = turn(s.id);
  const first = recording(s.id, t.id, "recorded", "main", true);
  memory.tools({ kind: "manual", sessionId: s.id, branch: "other", currentTurnId: t.id })[2]!.execute({
    facts: [{ category: "decision", actor: "user", text: "manual", source: [`T${t.id}#user`] }] });
  const manual = memory.store.listRuns(s.id).at(-1)!;
  memory.store.db.exec("UPDATE runs SET response = 'not JSON'");
  expect(memory.store.listBranchFacts(s.id, "main").map(f => f.text)).toEqual(["recorded", "manual"]); // facts belong to their turn, whichever branch wrote them
  expect(memory.store.listBranchFacts(s.id, "other").map(f => f.text)).toEqual(["recorded", "manual"]); // same turn, same path
  expect(memory.deliver(s.id).text).toContain("recorded");
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
    op: "update", knowledgeId: e, baseCommit: 1, text: fixture.editedKnowledge, category: "constraint", scope: "project", supports: [f.id], because: [f.id], createdAt: time }] });
  expect(edit.ok).toBe(true); expect(memory.inject(s.id)).not.toContain("verified");
  expect(memory.trace(`K${e}`)).not.toContain("· verified");
  expect(memory.trace(`K${e}@1`)).toContain("· verified");
  memory.mark(e, "flagged"); expect(memory.inject(s.id)).toContain("· flagged");
  memory.mark(e, "verified"); expect(memory.store.listKnowledgeMarks(e).filter((m) => m.commitId === 2)).toHaveLength(1);
  memory.mark(e, "clear"); expect(memory.inject(s.id)).not.toContain("verified");
  expect(memory.store.listKnowledgeMarks(e).map((m) => m.commitId)).toEqual([1]);
});

test("literal search finds facts, historical knowledge and raw across projects", () => {
  const s = session(), t = turn(s.id, "needle raw"), n = recording(s.id, t.id, "needle fact");
  const e = knowledge(s.id, n.facts[0]!.id, "goal", "project", "needle knowledge");
  expect(memory.search("needle", "facts")).toContain("[F1]"); expect(memory.search("needle", "facts")).not.toContain("[K");
  expect(memory.search("needle", "knowledge")).toContain(`[K${e}@${e}]`); expect(memory.search("needle", "knowledge")).not.toContain("[F1]");
  const all = memory.search("needle", "all"); expect(all).toContain("[F1]"); expect(all).toContain(`[K${e}@${e}]`); expect(all).toContain(`[S${s.id}/T${t.id}]`);
  expect(all.split("\n").filter((l) => l.startsWith("["))).toHaveLength(3);
  memory.store.commitIntegrationRun({ run: { sessionId: s.id, kind: "integration", createdAt: time }, operations: [{
    op: "update", knowledgeId: e, baseCommit: 1, text: "replacement knowledge", category: "goal", scope: "project", supports: [1], because: [1], createdAt: time }] });
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
      const f = recording(owner.id, t.id, content).facts[0]!;
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
  expect(status).not.toContain("Watermark");
  for (const text of ["Project: mapC (marker)", "Facts: 2 session; 2 project", "Knowledge: 1 visible active", "Last recording: run 3 success", "Last integration: run 2 success", "Pending deliveries: 1"]) expect(status).toContain(text);
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
  const s = session(), t = turn(s.id, "rule raw"), n = recording(s.id, t.id, "pnpm rule fact");
  const a = knowledge(s.id, n.facts[0]!.id, "constraint", "project", "Use pnpm for installs");
  const b = knowledge(s.id, n.facts[0]!.id, "constraint", "project", "pnpm is the package manager");
  const c = knowledge(s.id, n.facts[0]!.id, "constraint", "project", "pnpm lockfile is committed");
  const run = { sessionId: s.id, kind: "integration" as const, createdAt: time };
  memory.store.commitIntegrationRun({ run, operations: [{ op: "update", knowledgeId: a, baseCommit: 1, text: "Use npm for installs", category: "constraint", scope: "project", supports: [1], because: [1], createdAt: time }] });
  memory.store.commitIntegrationRun({ run, operations: [{ op: "merge", intoKnowledgeId: b, intoBaseCommit: b, absorb: [{ knowledgeId: c, baseCommit: c }], text: "pnpm is the package manager and its lockfile is committed", category: "constraint", scope: "project", supports: [1], because: [1], createdAt: time }] });
  memory.store.commitIntegrationRun({ run, operations: [{ op: "archive", knowledgeId: b, baseCommit: 5, because: [1], createdAt: time }] });
  const hits = memory.search("pnpm", "knowledge");
  expect(hits).toContain(`[K${a}@1]`); expect(hits).toContain(`note: superseded by K${a}@4`);
  expect(hits.split("\n").find(l => l.startsWith(`[K${c}@3]`))).toContain("note: archived");
  expect(hits).toContain("note: archived");
  const current = memory.search("for installs", "knowledge").split("\n").find((l) => l.startsWith(`[K${a}@4]`))!;
  expect(current).toContain("note: tip"); // unbound reads label tips without claiming current
});

test("reads resolve any existing address: another session's history, current revision, and a missing revision is rejected as missing", () => {
  const s = session(), t = turn(s.id, "scope raw"), n = recording(s.id, t.id, "scoped fact");
  const k = knowledge(s.id, n.facts[0]!.id, "goal", "project", "shared-then-private goal");
  memory.store.commitIntegrationRun({ run: { sessionId: s.id, kind: "integration", createdAt: time }, operations: [{ op: "update", knowledgeId: k, baseCommit: 1, text: "private goal now", category: "goal", scope: "session", supports: [1], because: [1], createdAt: time }] });
  const peer = session(memory.store.getSession(s.id)!.projectId), pt = turn(peer.id, "peer raw");
  memory.store.updateTurn(pt.id, { assistantText: "ok" });
  const trace = memory.tools({ kind: "manual", sessionId: peer.id, branch: "main", currentTurnId: pt.id }).find((d) => d.name === "trace")!;
  expect(memory.search("shared-then-private", "knowledge", { sessionId: peer.id })).toContain(`[K${k}@${k}]`);
  expect(trace.execute({ address: `K${k}@1` })).toContain("shared-then-private goal");
  expect(trace.execute({ address: `K${k}` })).toContain("shared-then-private goal");
  expect(trace.execute({ address: `K${k}@2` })).toContain("private goal now");
  expect(trace.execute({ address: `K${k}@3` })).toContain("does not exist");
});
