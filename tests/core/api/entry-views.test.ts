import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceSeededMemory, memoryFiles } from "../../source-fixture.ts";
import { TraceMemory } from "../../../src/core/api/index.ts";
import { piSourceBlocks } from "../../../src/hosts/pi/source.ts";
import { memoryPath } from "../../../src/core/model/address.ts";
import { renderTrace, renderFactPreview, renderEntry, tokens } from "../../../src/core/render/index.ts";
import { commitNoterKnowledge } from "../../noting-knowledge-fixture.ts";
import { factSources } from "../../support/seed.ts";

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).reverse().forEach(fn => fn()));
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "t93-read-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const m = sourceSeededMemory(join(dir, "db.sqlite"), async () => ({ outcome: "failure" as const, output: "not invoked" }));
  cleanup.push(() => m.close());
  const project = m.store.createProject({ name: "93-read", declaredBy: "mark" });
  const session = m.store.createSession({ projectId: project.id, host: "pi:test", enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
  const first = m.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "question", assistantText: "reply", startedAt: "now" });
  const second = m.store.appendTurn({ sessionId: session.id, kind: "turn", parentTurnId: first.id, userPrompt: "follow up", assistantText: "answer", startedAt: "later" });
  const note = m.tools({ kind: "manual", sessionId: session.id, branch: "main", currentTurnId: second.id }).find(tool => tool.name === "note")!;
  return { m, first, second, session, note };
}

test("trace:// grammar keeps whole entries, role filters and exact knowledge versions only", () => {
  const { m, session, first } = fixture();
  const files = memoryFiles(m, { sessionId: session.id, branch: "main", headTurnId: first.id });
  expect(memoryPath("trace://raw/S1/T1#E2@assistant")).toBe("trace://raw/S1/T1#E2@assistant");
  for (const old of ["trace://raw/S1/T1#E1..E3", "trace://raw/S1/T1#E1,E2", "trace://raw/S1/T1#E1@thinking",
    "trace://raw/S1/T1#E1@call", "trace://raw/T1#E1", "trace://F1-F3", "trace://F1..", "trace://K1..", "trace://K1@123"])
    expect(() => files.read(old)).toThrow();
});

test("qualified Turn and entry addresses check their real session owner", () => {
  const { m, first, session } = fixture();
  const files = memoryFiles(m, { sessionId: session.id, branch: "main", headTurnId: first.id });
  expect(files.read(`trace://raw/S${session.id}/T${first.id}#E1`).content).toContain("question");
  expect(files.read(`trace://raw/S${session.id}/T${first.id}`).content).toContain(`T${first.id}#E1`);
  expect(() => files.read(`trace://raw/S${session.id + 1}/T${first.id}`)).toThrow("does not exist");
  expect(() => files.read(`trace://raw/S${session.id + 1}/T${first.id}#E1`)).toThrow("no such path");
});

test("explicit whole-entry Raw shows stored thinking in block order while automatic entry views omit it", () => {
  const m = TraceMemory(":memory:", async () => { throw Error("offline only"); }, {}, undefined, piSourceBlocks);
  try {
    const projectId = m.store.createProject({ name: "thinking-read", declaredBy: "mark" }).id;
    const sessionId = m.store.createSession({ projectId, host: "pi:test", startedAt: "now", firstReplyAt: "now", enrollmentChoice: true }).id;
    const turnId = m.store.appendTurn({ sessionId, kind: "turn", startedAt: "now" }).id;
    const secret = "PERSISTED_PRIVATE_REASONING_".repeat(250);
    const pure = m.appendEntry({ sessionId, turnId, nativeLineage: "test", nativeId: "pure", role: "assistant", text: "", calls: [],
      raw: JSON.stringify({ role: "assistant", content: [{ type: "thinking", thinking: secret }] }) });
    const mixed = m.appendEntry({ sessionId, turnId, nativeLineage: "test", nativeId: "mixed", role: "assistant", text: "Public answer", calls: [
      { callId: "check", ordinal: 1, name: "bash", input: "{}", status: "attempted" } ],
      raw: JSON.stringify({ role: "assistant", content: [
        { type: "text", text: "Public answer" }, { type: "thinking", thinking: "MIDDLE_THINKING" },
        { type: "toolCall", id: "check", name: "bash", arguments: {} }] }) });
    m.selectEntries(sessionId, "main", [pure.id, mixed.id]);
    const files = memoryFiles(m, { sessionId, branch: "main", headTurnId: turnId });
    const exact = files.read(`trace://raw/S${sessionId}/T${turnId}#E1@assistant`).content;
    expect(exact).toContain(secret);
    expect(exact).not.toContain("[thinking omitted]");
    const whole = files.read(`trace://raw/S${sessionId}/T${turnId}#E2`).content;
    expect(whole.indexOf("Public answer")).toBeLessThan(whole.indexOf("MIDDLE_THINKING"));
    expect(whole.indexOf("MIDDLE_THINKING")).toBeLessThan(whole.indexOf("bash("));
    const bounded = files.read(`trace://raw/S${sessionId}/T${turnId}`).content;
    expect(bounded).not.toContain(secret);
    expect(bounded).not.toContain("MIDDLE_THINKING");
    expect(renderEntry(pure, m.config.render).content).toContain("[thinking omitted]");
    expect(renderEntry(mixed, m.config.render).content).not.toContain("MIDDLE_THINKING");
    expect(m.branchSummary(sessionId, "main", turnId)).not.toContain("MIDDLE_THINKING");
    const note = m.tools({ kind: "manual", sessionId, branch: "main", currentTurnId: turnId })
      .find(tool => tool.name === "note")!;
    expect(note.execute({ title: "Invalid thinking evidence", sources: factSources([
      { address: `T${turnId}#E1`, text: "Private inference" }]) })).toContain("rejected:");
    expect(m.store.listTurnFacts(turnId)).toEqual([]);
  } finally { m.close(); }
});

test("exact entry and exact knowledge retain more than 100 lines without Core paging", () => {
  const { m, first, session, note } = fixture();
  const lines = Array.from({ length: 125 }, (_, index) => `LINE_${index}`).join("\n");
  const entry = m.store.appendSourceEntry({ sessionId: session.id, turnId: first.id, nativeId: "long-lines", nativeLineage: "main",
    role: "assistant", text: lines, raw: lines, calls: [] });
  const files = memoryFiles(m, { sessionId: session.id, branch: "main", headTurnId: first.id });
  expect(files.read(`trace://raw/S${session.id}/T${first.id}#E${entry.entryOrdinal}`).content).toContain("LINE_124");
  expect(note.execute({ title: "Knowledge source", sources: factSources([{ address: `T${first.id}#E1`, text: "A source" }]) })).toContain("ok: F1");
  m.config.writing.bodyTokens = 10_000; // 125 lines is a body written before the caps could be
  const write = m.tools({ kind: "manual", sessionId: session.id, branch: "main", currentTurnId: first.id }).find(tool => tool.name === "memory")!;
  const created = JSON.parse(write.execute({ op: "create", title: "Fixture title", text: lines, category: "reference", scope: "project", topics: [], supports: ["F1"], reason: "Test whole body" }));
  expect(files.read(`trace://K${created.committed[0].knowledgeId}`).content).toContain("LINE_124");
});

test("a long title-only listing obeys its item token budget", () => {
  const title = "long title ".repeat(100);
  const preview = renderFactPreview({ id: 1, title, text: "body" } as any, new Set(["text"]), 35);
  expect(tokens(preview)).toBeLessThanOrEqual(35);
  expect(preview).toContain("[F1]");
  expect(preview).toContain("truncated");
});

test("several omitted calls in one entry report each call but one whole-entry expansion", () => {
  const source = { id: 1, turnId: 1, entryOrdinal: 1, sessionId: 1, nativeId: "one", nativeLineage: "main",
    role: "assistant", raw: "", text: "", calls: [1, 2].map(ordinal => ({ ordinal, name: "read",
      callId: `call-${ordinal}`, status: "attempted", input: JSON.stringify({ path: `file-${ordinal}`.repeat(100) }) })),
    blocks: [1, 2].map(ordinal => ({ kind: "call", call: { ordinal, name: "read", callId: `call-${ordinal}`,
      status: "attempted", input: JSON.stringify({ path: `file-${ordinal}`.repeat(100) }) } })) };
  const rendered = renderTrace({ id: 1, sessionId: 1, startedAt: "now", kind: "turn" } as any,
    [source] as any, { entryTokens: 2000, toolInputTokens: 24, toolResultTokens: 100 });
  expect(rendered.receipts[0]).toContain("2 omitted calls");
  expect(rendered.receipts).toHaveLength(2);
  expect(rendered.receipts[1]).toBe("trace://raw/S1/T1#E1");
});

test("model tools have no trace and an exact entry retains its source content", () => {
  const { m, first, session } = fixture();
  expect(m.tools({ kind: "manual", sessionId: session.id, branch: "main", currentTurnId: first.id })
    .map(tool => tool.name)).not.toContain("trace");
  expect(memoryFiles(m, { sessionId: session.id, branch: "main", headTurnId: first.id })
    .read(`trace://raw/S${session.id}/T${first.id}#E2`).content).toContain("assistant: reply");
});

test("knowledge injection charges IDs only while an explicit trace displays support titles", () => {
  const { m, first, second, session, note } = fixture();
  expect(note.execute({ title: "A descriptive episode title", sources: factSources([{ address: `T${first.id}#E1`, text: "User asks a question" }]) })).toContain("ok: F1");
  const memory = m.tools({ kind: "manual", sessionId: session.id, branch: "main", currentTurnId: second.id }).find(tool => tool.name === "memory")!;
  const result = JSON.parse(memory.execute({ op: "create", title: "Fixture title", text: "A lasting rule", category: "constraint",
    scope: "project", topics: [], reason: "user choice", supports: ["F1"] }));
  expect(result.committed).toHaveLength(1);
  const id = result.committed[0].knowledgeId;
  const injected = m.injection(session.id);
  expect(injected.text).toContain("supports: F1");
  expect(injected.text).not.toContain("A descriptive episode title");
  expect(injected.knowledgeTokens).toBe(tokens(injected.text.split("\n\n").slice(1).join("\n\n")));
  expect(tokens(injected.text)).toBeGreaterThan(injected.knowledgeTokens!);
  expect(memoryFiles(m, { sessionId: session.id, branch: "main", headTurnId: second.id }).read(`trace://K${id}`).content).toContain("F1 A descriptive episode title");
});


test("Turn local source selection follows authored path order, not allocated entry ids or input order", () => {
  const { m, first, second, session, note } = fixture();
  const entries = m.store.sourcePath(session.id, "main", second.id);
  const firstE1 = entries.find(entry => entry.turnId === first.id && entry.entryOrdinal === 1)!;
  const firstE2 = entries.find(entry => entry.turnId === first.id && entry.entryOrdinal === 2)!;
  const secondE1 = entries.find(entry => entry.turnId === second.id && entry.entryOrdinal === 1)!;
  m.store.publishSourcePath(session.id, "main", [firstE2.id, firstE1.id, secondE1.id], second.id, "reverse");
  expect(note.execute({ title: "Reversed native order", sources: factSources([
    { address: `T${second.id}#E1`, text: "later" },
    { address: `T${first.id}#E1`, text: "early by allocation" },
    { address: `T${first.id}#E2`, text: "first on path" },
  ]) })).toContain("ok: F1");
  const fact = m.store.getFact(1)!;
  expect(fact.segments).toEqual(["first on path", "early by allocation", "later"]);
  const turn = memoryFiles(m, { sessionId: session.id, branch: "main", headTurnId: second.id }).read(`trace://facts/S${session.id}/T${first.id}`).content;
  expect(turn.indexOf("first on path")).toBeLessThan(turn.indexOf("early by allocation"));
  expect(turn).not.toContain("later");
});

test("exact full entry preserves uncut pending Raw", () => {
  const { m, first, session } = fixture();
  const long = "raw-payload-".repeat(1000);
  m.store.appendSourceEntry({ sessionId: session.id, turnId: first.id, nativeId: "long-raw", nativeLineage: "main",
    role: "assistant", text: long, raw: long, calls: [] });
  const files = memoryFiles(m, { sessionId: session.id, branch: "main", headTurnId: first.id });
  const full = files.read(`trace://raw/S${session.id}/T${first.id}#E3`);
  expect(full.unbounded).toBe(true);
  expect(full.content).toContain(long);
  expect(files.read(`trace://raw/S${session.id}/T${first.id}`).content).not.toContain(long);
});

test("a fact backlink groups citing history under visible current identity, including current archive", () => {
  const { m, first, second, session, note } = fixture();
  expect(note.execute({ title: "First finding", sources: factSources([{ address: `T${first.id}#E1`, text: "Original evidence" }]) })).toContain("ok: F1");
  expect(note.execute({ title: "Later finding", sources: factSources([{ address: `T${second.id}#E1`, text: "Later evidence" }]) })).toContain("ok: F2");
  const context = { kind: "manual" as const, sessionId: session.id, branch: "main", currentTurnId: second.id };
  const memory = m.tools(context).find(tool => tool.name === "memory")!;
  const create = JSON.parse(memory.execute({ op: "create", title: "Fixture title", text: "Rule", category: "constraint",
    scope: "session", topics: [], reason: "first", supports: ["F1"] }));
  const id = create.committed[0].knowledgeId;
  const firstCommit = m.store.resolveVersionOrdinal(id, 1);
  const tag = m.store.versionTag(id, firstCommit);
  const archive = JSON.parse(memory.execute({ op: "archive", kind: "invalid", text: "Withdrawn: the user retired this and nothing replaces it, per the cited fact.", id: `K${id}#${tag}`,
    reason: "reconsidered", supports: ["F2"] }));
  expect(archive.committed).toHaveLength(1);
  const files = memoryFiles(m, { sessionId: session.id, branch: "main", headTurnId: second.id });
  const text = [files.read("trace://F1").content, files.read("trace://F2").content].join("\n");
  expect(text).toContain(`K${id}@v2 — cited by v1; current v2 (archived)`);
  expect(m.search("finding", "facts", { sessionId: session.id, branch: "main", headTurnId: second.id })).toContain("First finding");
  const bodyHit = m.search("Original evidence", "facts", { sessionId: session.id, branch: "main", headTurnId: second.id });
  expect(bodyHit).toContain("First finding");
  expect(bodyHit).toContain("Original evidence");
  expect(files.read(`trace://K${id}@v1`).content).toContain("F1 First finding");
  expect(text).not.toContain(`K${id}#`);
});

test("legacy block source renders every actually bound native entry, never its retired spelling", () => {
  const { m, first, second, session } = fixture();
  const before = m.store.sourcePath(session.id, "main", second.id);
  const extra = m.store.appendSourceEntry({ sessionId: session.id, turnId: first.id, nativeId: "legacy-extra",
    nativeLineage: "main", role: "assistant", text: "another answer", raw: "another answer", calls: [] });
  const start = before.filter(entry => entry.turnId === first.id);
  const end = before.filter(entry => entry.turnId === second.id);
  m.store.publishSourcePath(session.id, "main", [...start.map(entry => entry.id), extra.id, ...end.map(entry => entry.id)], second.id, "main");
  const assistants = [...start.filter(entry => entry.entryOrdinal === 2).map(entry => entry.id), extra.id];
  const saved = m.store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, branch: "main", createdAt: "now" },
    facts: [{ turnId: first.id, category: "decision", text: "historic decision", createdAt: "now",
      source: [`T${first.id}#assistant`], entryIds: assistants }] });
  expect(saved.ok).toBe(true);
  const text = memoryFiles(m, { sessionId: session.id, branch: "main", headTurnId: second.id }).read("trace://F1").content;
  expect(text).toContain(`T${first.id}#E2`);
  expect(text).toContain(`T${first.id}#E${extra.entryOrdinal}`);
  expect(text).not.toContain(`#assistant`);
});

test("legacy display uses only actual bindings even when the source alias matches more entries", () => {
  const { m, first, session } = fixture();
  const original = m.store.listSourceEntries(session.id, first.id).find(e => e.entryOrdinal === 2)!;
  const extra = m.store.appendSourceEntry({ sessionId: session.id, turnId: first.id, nativeId: "legacy-extra",
    nativeLineage: "main", role: "assistant", text: "second reply", raw: "second reply", calls: [] });
  const saved = m.store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, branch: "main", createdAt: "now" },
    facts: [{ turnId: first.id, category: "decision", text: "bound historical", createdAt: "now",
      source: [`T${first.id}#assistant`], entryIds: [original.id] }] });
  expect(saved.ok).toBe(true);
  const changed = () => (m.store.db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
  const before = changed();
  const files = memoryFiles(m, { sessionId: session.id, branch: "main", headTurnId: first.id });
  expect(files.read("trace://F1").content).toContain(`T${first.id}#E${original.entryOrdinal}`);
  expect(files.read("trace://F1").content).not.toContain(`T${first.id}#E${extra.entryOrdinal}`);
  expect(files.read(`trace://facts/S${session.id}/T${first.id}`).content).toContain("bound historical");
  expect(changed()).toBe(before);
});

test("missing legacy bindings are corruption; titled corruption remains rejected", () => {
  const { m, first, session, note } = fixture();
  const entry = m.store.listSourceEntries(session.id, first.id).find(e => e.entryOrdinal === 2)!;
  const saved = m.store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, branch: "main", createdAt: "now" },
    facts: [{ turnId: first.id, category: "decision", text: "old", createdAt: "now",
      source: [`T${first.id}#assistant`], entryIds: [entry.id] }] });
  expect(saved.ok).toBe(true);
  m.store.db.prepare("DELETE FROM fact_sources WHERE fact_id=1").run();
  const files = memoryFiles(m, { sessionId: session.id, branch: "main", headTurnId: first.id });
  expect(() => files.read("trace://F1")).toThrow("F1: missing legacy source bindings");
  expect(() => files.read(`trace://facts/S${session.id}/T${first.id}`)).toThrow("F1: missing legacy source bindings");
  m.store.db.prepare("UPDATE facts SET source=? WHERE id=1")
    .run(JSON.stringify([`S${session.id}/T${first.id}#assistant`]));
  expect(() => files.read(`trace://facts/S${session.id}/T${first.id}`)).toThrow("F1: missing legacy source bindings");
  expect(() => files.read("trace://F1")).toThrow("F1: missing legacy source bindings");
  expect(note.execute({ title: "new", sources: factSources([{ address: `T${first.id}#E1`, text: "segment" }]) })).toContain("ok: F2");
  m.store.db.prepare("UPDATE facts SET text = 'damaged' WHERE id=2").run();
  expect(() => files.read("trace://F2")).toThrow("source segments, roles and body disagree");
});

test("a partially lost legacy binding fails every read and is readable after restoration", () => {
  const { m, first, second, session } = fixture();
  const firstEntry = m.store.listSourceEntries(session.id, first.id).find(e => e.entryOrdinal === 1)!;
  const secondEntry = m.store.listSourceEntries(session.id, second.id).find(e => e.entryOrdinal === 2)!;
  const source = [`S${session.id}/T${first.id}#user`, `S${session.id}/T${second.id}#assistant`];
  const saved = m.store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, branch: "main", createdAt: "now" },
    facts: [{ turnId: first.id, category: "decision", text: "two contributions", createdAt: "now",
      source, entryIds: [firstEntry.id, secondEntry.id] }] });
  expect(saved.ok).toBe(true);
  // This historical entry selector remains stored even when the projection has no block metadata.
  source[0] = `S${session.id}/T${first.id}#E1@text`;
  m.store.db.prepare("UPDATE facts SET source=? WHERE id=1").run(JSON.stringify(source));
  expect(m.store.getFact(1)!.source).toEqual(source);
  const files = memoryFiles(m, { sessionId: session.id, branch: "main", headTurnId: second.id });
  expect(files.read("trace://F1").content).toContain("two contributions");
  expect(files.read(`trace://facts/S${session.id}/T${first.id}`).content).toContain("two contributions");
  expect(files.read(`trace://facts/S${session.id}/T${second.id}`).content).toContain("two contributions");
  m.store.db.prepare("DELETE FROM fact_sources WHERE fact_id=1 AND entry_id=?").run(secondEntry.id);
  const unchanged = () => (m.store.db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
  const before = unchanged();
  for (const target of ["trace://F1", `trace://facts/S${session.id}/T${first.id}`, `trace://facts/S${session.id}/T${second.id}`])
    expect(() => files.read(target)).toThrow("F1: missing legacy source bindings");
  expect(unchanged()).toBe(before);
  m.store.db.prepare("INSERT INTO fact_sources(fact_id,entry_id) VALUES(1,?)").run(secondEntry.id);
  expect(files.read("trace://F1").content).toContain("two contributions");
  expect(files.read(`trace://facts/S${session.id}/T${first.id}`).content).toContain("two contributions");
  expect(files.read(`trace://facts/S${session.id}/T${second.id}`).content).toContain("two contributions");
});

test("118: facts lists pending and processed uncited entries only by path", () => {
  const { m, second, session } = fixture();
  const entries = m.store.sourcePath(session.id, "main", second.id).filter(entry => entry.turnId === second.id);
  expect(m.store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, branch: "main", createdAt: "now" },
    entryIds: [entries[0]!.id], facts: [] }).ok).toBe(true);
  const turn = memoryFiles(m, { sessionId: session.id, branch: "main", headTurnId: second.id }).read(`trace://facts/S${session.id}/T${second.id}`).content;
  expect(turn).toContain(`Events without a fact: trace://raw/S${session.id}/T${second.id}#E1 trace://raw/S${session.id}/T${second.id}#E2`);
  expect(turn).not.toContain("follow up");
  expect(turn).not.toContain("answer");
  expect(m.store.entryNoted(entries[0]!.id)).toBe(true);
  expect(m.store.entryNoted(entries[1]!.id)).toBe(false);
});

test("invisible global current successor hides an earlier visible project identity without leaking its version", () => {
  const { m, first, second, session, note } = fixture();
  expect(note.execute({ title: "Shared source", sources: factSources([{ address: `T${first.id}#E1`, text: "Public evidence" }]) })).toContain("ok: F1");
  const memory = m.tools({ kind: "manual", sessionId: session.id, branch: "main", currentTurnId: second.id })
    .find(tool => tool.name === "memory")!;
  const create = JSON.parse(memory.execute({ op: "create", title: "Fixture title", text: "Project rule", category: "constraint",
    scope: "project", topics: [], reason: "original", supports: ["F1"] }));
  const id = create.committed[0].knowledgeId;
  const peer = m.store.createSession({ projectId: m.store.getSession(session.id)!.projectId,
    host: "pi:peer", enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
  const peerTurn = m.store.appendTurn({ sessionId: peer.id, kind: "turn", userPrompt: "private", startedAt: "now" });
  const privateNote = m.tools({ kind: "manual", sessionId: peer.id, branch: "main", currentTurnId: peerTurn.id }).find(tool => tool.name === "note")!;
  expect(privateNote.execute({ title: "Private source", sources: factSources([{ address: `T${peerTurn.id}#E1`, text: "Private evidence" }]) })).toContain("ok: F2");
  const changed = commitNoterKnowledge(m.store, { path: { sessionId: peer.id, branch: "main", headTurnId: peerTurn.id },
    run: { sessionId: peer.id, branch: "main", createdAt: "later" }, operations: [{ op: "update", knowledgeId: id,
      baseCommit: m.store.resolveVersionOrdinal(id, 1), text: "Private successor", category: "constraint", scope: "session",
      topics: [], reason: "restricted", supports: [2], createdAt: "later" }] });
  expect(changed.ok).toBe(true);
  const text = memoryFiles(m, { sessionId: session.id, branch: "main", headTurnId: second.id }).read("trace://F1").content;
  expect(text).not.toContain(`K${id}@v`);
  expect(text).not.toContain(`K${id}#`);
  expect(text).not.toContain("Private successor");
});

test("Turn includes the contributing slice from another Turn's owner; exact entry enforces role", () => {
  const { m, first, second, session, note } = fixture();
  const result = note.execute({ title: "Conversation advances", sources: factSources([
    { address: `T${first.id}#E1`, text: "Question is raised" },
    { address: `T${second.id}#E2`, text: "Pi agent answers" },
  ]) });
  expect(result).toContain("ok: F1");
  const files = memoryFiles(m, { sessionId: session.id, branch: "main", headTurnId: second.id });
  const turn = files.read(`trace://facts/S${session.id}/T${second.id}`).content;
  expect(turn).toContain("Conversation advances");
  expect(turn).toContain(`[T${second.id}#E2@assistant] Pi agent answers`);
  expect(turn).not.toContain("Question is raised");
  expect(files.read(`trace://raw/S${session.id}/T${second.id}#E1@user`).content).toContain("follow up");
  expect(() => files.read(`trace://raw/S${session.id}/T${second.id}#E1@assistant`)).toThrow(/role does not match/);
  expect(files.read("trace://F1").content).toContain("Conversation advances");
});
