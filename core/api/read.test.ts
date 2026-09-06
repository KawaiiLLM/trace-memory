import { afterEach, beforeEach, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { TraceMemory } from "./index.ts";

const fixture = JSON.parse(readFileSync(new URL("../../test/fixtures/note/facts.json", import.meta.url), "utf8"));
const rawFixture = JSON.parse(readFileSync(new URL("../../test/fixtures/note/turns.json", import.meta.url), "utf8"));
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
function note(sessionId: number, turnId: number, text = fixture.base, branch = "main", pending = false) {
  const result = memory.store.commitNoteRun({ run: { sessionId, branch, kind: "note", createdAt: time },
    facts: [{ turnId, text, category: "decision", actor: "user", source: [`T${turnId}#user`], createdAt: time }],
    watermark: { sessionId, branch, lastNotedTurn: turnId },
    ...(pending ? { pendingDelivery: { sessionId, branch } } : {}) });
  if (!result.ok) throw new Error(result.problems.join("\n"));
  return result;
}
function entry(sessionId: number, factId: number, category: "constraint" | "open" | "dispute" | "goal" | "mechanism" | "term" | "reference" = "constraint",
  scope: "session" | "project" | "global" = "project", text = fixture.entry, createdAt = time) {
  const result = memory.store.commitSettleRun({ run: { sessionId, branch: "main", kind: "settle", createdAt: time },
    operations: [{ op: "new", handle: "$e1", author: "fake", text, category, scope, supports: [factId], createdAt }],
    watermark: { sessionId, branch: "main", lastSettledFact: factId } });
  if (!result.ok || result.rejected.length) throw new Error(JSON.stringify(result));
  return result.committed[0]!.entryId;
}
function populated() {
  const s = session(), t = turn(s.id), n = note(s.id, t.id), f = n.facts[0]!;
  const e = entry(s.id, f.id);
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

test("injection stays byte-identical across a no-op note and has no XML attributes", async () => {
  const { s, t } = populated();
  const before = memory.inject(s.id), next = turn(s.id, fixture.observation, t.id);
  expect((await memory.note({ sessionId: s.id, branch: "main", headTurnId: next.id })).outcome).toBe("success");
  expect(memory.inject(s.id)).toBe(before);
  expect(memory.deliver(s.id, "main")).toBe(""); // the no-op note wrote no facts; its delivery is consumed anyway
  expect(memory.store.listPendingDeliveries(s.id, "main")).toEqual([]);
  expect(memory.inject(s.id)).toBe(before);
  for (const tag of before.match(/<[^>]+>/g)!) expect(tag).toMatch(/^<\/?[a-z_]+>$/);
});

test("visibility includes global, own project and own session only, excluding inactive entries", () => {
  const { s, f } = populated(), peer = session(s.projectId), foreign = session();
  const own = entry(s.id, f.id, "open", "session"), other = entry(peer.id, f.id, "open", "session");
  const outside = entry(foreign.id, f.id), global = entry(foreign.id, f.id, "goal", "global");
  const archived = entry(s.id, f.id, "reference");
  memory.store.commitSettleRun({ run: { sessionId: s.id, kind: "settle", createdAt: time },
    operations: [{ op: "archive", entryId: archived, expectedRevision: 1, because: [f.id], createdAt: time }] });
  for (const block of [memory.inject(s.id), memory.compact(s.id)]) {
    expect(block).toContain(`[E${own}@1]`); expect(block).toContain(`[E${global}@1]`);
    for (const id of [other, outside, archived]) expect(block).not.toContain(`[E${id}@`);
  }
});

test("category order, chronological ties, whole trailing category omissions; lines are never escaped", () => {
  const { s, f } = populated();
  const ids = ["reference", "term", "mechanism", "goal", "dispute", "open"].map((c) => entry(s.id, f.id, c as "goal"));
  const earlier = entry(s.id, f.id, "constraint", "project", "<&>", "2020");
  const all = memory.inject(s.id);
  expect(all.indexOf(`[E${earlier}@`)).toBeLessThan(all.indexOf("[E1@"));
  // Injected lines are trace lines byte for byte (ruling 15:14); tags only delimit blocks.
  expect(all).toContain("<&>");
  expect(all).not.toContain("&lt;");
  const tags = ["constraint", "open", "dispute", "goal", "mechanism", "term", "reference"];
  expect(tags.map((tag) => all.indexOf(`<${tag}>`))).toEqual(tags.map((tag) => all.indexOf(`<${tag}>`)).sort((a, b) => a - b));
  memory.config.render.entriesBlockTokens = 0;
  const limited = memory.inject(s.id);
  for (const tag of tags.slice(0, 3)) expect(limited).toContain(`<${tag}>`);
  for (const tag of tags.slice(3)) { expect(limited).not.toContain(`<${tag}>`); expect(limited).toContain(`1 ${tag} entries; expand:`); }
  expect(limited.indexOf("Receipts:")).toBeGreaterThan(limited.indexOf("</entries>"));
  for (const id of ids.slice(0, 4)) expect(memory.trace(`E${id}`)).toContain(`[E${id}@1]`);
});

test("compaction retains oversized raw with standard tool cuts and receipts outside XML", () => {
  const { s, t } = populated(), raw = fixture.observation.repeat(1000);
  const next = turn(s.id, raw, t.id);
  memory.store.appendToolCall({ turnId: next.id, name: "Bash", input: "pwd", result: JSON.stringify({ stdout: "x".repeat(10000) }), status: "success" });
  memory.config.render.episodicBlockTokens = 1;
  const result = memory.compact(s.id, "main", next.id);
  expect(result).toContain(raw); expect(result).toContain("omitted 1 lines, 10000 characters");
  expect(result).toContain("raw overage:"); expect(result).toContain("all unnoted raw kept");
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
  const n = note(s.id, selected.id, fixture.interpretation);
  const full = memory.compact(s.id, "main", selected.id);
  expect(full.indexOf(`[F${n.facts[0]!.id}]`)).toBeLessThan(full.indexOf("[F1]"));
  memory.config.render.episodicBlockTokens = 40;
  const limited = memory.compact(s.id, "main", selected.id);
  expect(limited).toContain(`[F${n.facts[0]!.id}]`); expect(limited).not.toContain("[F1]");
  expect(memory.store.getTurn(abandoned.id)).not.toBeNull();
});

test("pending delivery is exact to its run and branch, consumed once, including after later commits", () => {
  const s = session(), t = turn(s.id);
  const first = note(s.id, t.id, "first delivery", "main", true);
  const second = note(s.id, t.id, "second delivery", "other", true);
  expect(memory.deliver(s.id, "unrelated")).toBe("");
  const delivery = memory.deliver(s.id, "main");
  expect(delivery).toContain("first delivery"); expect(delivery).not.toContain("second delivery");
  expect(memory.deliver(s.id, "main")).toBe("");
  expect(memory.inject(s.id)).not.toContain("pending_notes");
  expect(memory.store.listPendingDeliveries(s.id, "other").map((p) => p.runId)).toEqual([second.runId]);
  expect(memory.deliver(s.id, "other")).toContain("second delivery");
  expect(JSON.parse(memory.store.getRun(first.runId)!.response!).factIds).toEqual([first.facts[0]!.id]);
});

test("marks bind to current revision, replace its mark, clear it, and do not carry into an edit", () => {
  const { s, f, e } = populated();
  expect(memory.mark({ entryId: e, kind: "verified" })).toBe(`E${e}@1: verified`);
  expect(memory.inject(s.id)).toContain("· verified");
  expect(memory.trace(`E${e}`)).toContain("· verified");
  const edit = memory.store.commitSettleRun({ run: { sessionId: s.id, kind: "settle", createdAt: time }, operations: [{
    op: "edit", entryId: e, expectedRevision: 1, text: fixture.editedEntry, category: "constraint", scope: "project", supports: [f.id], because: [f.id], createdAt: time }] });
  expect(edit.ok).toBe(true); expect(memory.inject(s.id)).not.toContain("verified");
  expect(memory.trace(`E${e}`)).not.toContain("· verified");
  expect(memory.trace(`E${e}@1`)).toContain("· verified");
  memory.mark({ entryId: e, kind: "flagged" }); expect(memory.inject(s.id)).toContain("· flagged");
  memory.mark({ entryId: e, kind: "verified" }); expect(memory.store.listMarks(e).filter((m) => m.rev === 2)).toHaveLength(1);
  memory.mark({ entryId: e, kind: "clear" }); expect(memory.inject(s.id)).not.toContain("verified");
  expect(memory.store.listMarks(e).map((m) => m.rev)).toEqual([1]);
});

test("FTS searches facts and historical entries, while raw LIKE searches only the selected session", () => {
  const s = session(), t = turn(s.id, "needle raw"), n = note(s.id, t.id, "needle fact");
  const e = entry(s.id, n.facts[0]!.id, "goal", "project", "needle entry");
  expect(memory.search("needle", "facts")).toContain("[F1]"); expect(memory.search("needle", "facts")).not.toContain("[E");
  expect(memory.search("needle", "entries")).toContain(`[E${e}@1]`); expect(memory.search("needle", "entries")).not.toContain("[F1]");
  const all = memory.search("needle", "all"); expect(all).toContain("[F1]"); expect(all).toContain(`[E${e}@1]`);
  expect(all.split("\n").filter((l) => l.startsWith("["))).toHaveLength(2);
  memory.store.commitSettleRun({ run: { sessionId: s.id, kind: "settle", createdAt: time }, operations: [{
    op: "edit", entryId: e, expectedRevision: 1, text: "replacement entry", category: "goal", scope: "project", supports: [1], because: [1], createdAt: time }] });
  expect(memory.search("needle", "entries")).toContain(`[E${e}@1]`);
  expect(memory.search("needle", "entries")).not.toContain(`[E${e}@2]`);
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
  note(s.id, t.id, fixture.base);
  const first = memory.search(fixture.base, "facts", { cap: 1 });
  const cursor = /cursor=(\S+)/.exec(first)![1]!;
  expect(cursor).not.toContain("{"); expect(first).toContain("[F1]");
  const last = memory.search("ignored", "all", { cursor });
  expect(last).toContain("[F2]"); expect(last).not.toContain("cursor="); expect(last).toContain("No hit does not mean absent");
  expect(() => memory.trace(`cursor=${cursor}`)).toThrow("unknown or expired cursor");
  for (const address of [`S${s.id}`, "mapC", `F${f.id},E${e}`, `E${e}`, `F${f.id}..`]) {
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
  const { s, t } = populated(); note(s.id, t.id, fixture.observation, "side", true);
  const status = memory.status(s.id);
  for (const text of ["Project: mapC (marker)", "Facts: 2 session; 2 project", "Entries: 1 visible active", "Watermark main: noted T1; settled F1", "Watermark side: noted T1; settled none", "Last note: run 3 success", "Last settle: run 2 success", "Pending deliveries: 1"]) expect(status).toContain(text);
});

test("project mark merges an undeclared own project, relabels facts and entries, and beats later marker reports", () => {
  const s = session(undefined, "undeclared"), t = turn(s.id), n = note(s.id, t.id), f = n.facts[0]!;
  const e = entry(s.id, f.id), own = entry(s.id, f.id, "open", "session");
  expect(memory.mark({ sessionId: s.id, project: "declared" })).toContain("declared (mark)");
  const project = memory.store.findProjectByName("declared")!;
  expect(memory.store.getProject(s.projectId)!.mergedInto).toBe(project.id);
  expect(memory.store.listProjectFacts(project.id).map((f) => f.id)).toEqual([f.id]);
  expect(memory.store.getEntry(e)!.projectId).toBe(project.id);
  const peer = session(project.id);
  expect(memory.inject(peer.id)).toContain(`[E${e}@1]`); expect(memory.inject(peer.id)).not.toContain(`[E${own}@1]`);
  memory.mark({ sessionId: s.id, project: "ignored marker", source: "marker" });
  expect(memory.store.getSession(s.id)!.projectId).toBe(project.id);
  expect(memory.store.findProjectByName("ignored marker")).toBeNull();
  memory.mark({ sessionId: s.id, project: "next" });
  expect(memory.store.getSession(peer.id)!.projectId).toBe(project.id);
  expect(memory.store.getProject(project.id)!.mergedInto).toBeNull();
  expect(memory.inject(s.id)).toContain(`[E${own}@1]`);
});

test("default listing caps continue all hits and freeze the remaining search results", () => {
  const s = session(), t = turn(s.id);
  const result = memory.store.commitNoteRun({ run: { sessionId: s.id, kind: "note", createdAt: time },
    facts: Array.from({ length: 101 }, (_, i) => ({ turnId: t.id, text: `needle ${i}`, category: "observation" as const,
      actor: "agent" as const, source: [`T${t.id}#assistant`], createdAt: time })) });
  expect(result.ok).toBe(true);
  const first = memory.search("needle");
  expect(first.split("\n").filter((l) => l.startsWith("[F"))).toHaveLength(100);
  const cursor = /cursor=(\S+)/.exec(first)![1]!;
  note(s.id, t.id, "needle added later");
  const last = memory.search("", "all", { cursor });
  expect(last).toContain("[F101]"); expect(last).not.toContain("[F102]");
  expect(last).not.toContain("cursor=");
});

test("a legacy delivery without fact ownership is preserved on render failure", () => {
  const s = session();
  const run = memory.store.recordRun({ sessionId: s.id, branch: "main", kind: "note", outcome: "success", createdAt: time, response: "{}" });
  memory.store.addPendingDelivery(run.id, s.id, "main");
  expect(() => memory.deliver(s.id)).toThrow("lacks committed fact IDs");
  expect(memory.store.listPendingDeliveries(s.id, "main")).toHaveLength(1);
});

test("first-prompt injection by project needs no session: global and project entries, no deliveries", () => {
  const { s, f } = populated();
  const p = memory.store.getSession(s.id)!.projectId;
  entry(s.id, f.id, "constraint", "session", "session-only");
  const byProject = memory.inject({ projectId: p });
  const bySession = memory.inject(s.id);
  expect(byProject).toContain("[E1@");
  expect(byProject).not.toContain("session-only");
  expect(bySession).toContain("session-only");
  expect(() => memory.inject({ projectId: 999 })).toThrow("does not exist");
});
