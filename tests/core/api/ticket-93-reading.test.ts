import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceSeededMemory } from "../../source-fixture.ts";
import { TraceMemory } from "../../../src/core/api/index.ts";
import { piSourceBlocks } from "../../../src/hosts/pi/source.ts";
import { publicTraceTargets } from "../../../src/core/model/address.ts";
import { renderTrace, renderFactPreview, renderEntry, tokens } from "../../../src/core/render/index.ts";
import { commitNoterKnowledge } from "../../noting-knowledge-fixture.ts";

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

test("public grammar keeps whole entries, role filters and exact knowledge versions only", () => {
  expect(publicTraceTargets("T1#E1..E3,T2@observation,F1,K2#abcd,K2@v1..v3")).toHaveLength(5);
  expect(publicTraceTargets("trace-memory")).toEqual(["trace-memory"]);
  expect(publicTraceTargets("S1/T1,S1/T1#E2")).toEqual(["S1/T1", "S1/T1#E2"]);
  for (const old of ["T1@text", "T1#E1@thinking", "T1#E1@call", "T1@F*", "T1#E1,E2", "T1#user", "F1-F3", "F1..", "K1..", "K1@123"])
    expect(() => publicTraceTargets(old)).toThrow();
});

test("qualified Turn and entry addresses check their real session owner", () => {
  const { m, first, session } = fixture();
  expect(m.trace(`S${session.id}/T${first.id}#E1`)).toContain("question");
  expect(m.trace(`S${session.id}/T${first.id}`)).toContain(`T${first.id}#E1`);
  expect(() => m.trace(`S${session.id + 1}/T${first.id}`)).toThrow("does not exist");
  expect(() => m.trace(`S${session.id + 1}/T${first.id}#E1`)).toThrow("does not exist");
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
    const exact = m.trace(`T${turnId}#E1@assistant`, { full: true, pageBudget: null });
    expect(exact).toContain(secret);
    expect(exact).not.toContain("[thinking omitted]");
    const whole = m.trace(`T${turnId}#E2`, { full: true });
    expect(whole.indexOf("Public answer")).toBeLessThan(whole.indexOf("MIDDLE_THINKING"));
    expect(whole.indexOf("MIDDLE_THINKING")).toBeLessThan(whole.indexOf("bash("));
    const bounded = m.trace(`T${turnId}#E1`, { itemBudget: 100 });
    expect(bounded).toContain("characters truncated");
    expect(bounded).not.toContain(secret);
    const first = m.trace(`T${turnId}#E1,T${turnId}#E2`, { cap: 1, full: true });
    let cursor = /cursor=([0-9a-f-]+)/.exec(first)?.[1];
    expect(cursor).toBeDefined();
    let pages = first;
    while (cursor) {
      const next = m.trace(`cursor=${cursor}`);
      pages += next;
      cursor = /cursor=([0-9a-f-]+)/.exec(next)?.[1];
    }
    expect(pages).toContain("MIDDLE_THINKING");
    expect(renderEntry(pure, m.config.render).content).toContain("[thinking omitted]");
    expect(renderEntry(mixed, m.config.render).content).not.toContain("MIDDLE_THINKING");
    expect(m.branchSummary(sessionId, "main", turnId)).not.toContain("MIDDLE_THINKING");
    const note = m.tools({ kind: "manual", sessionId, branch: "main", currentTurnId: turnId })
      .find(tool => tool.name === "note")!;
    expect(note.execute({ facts: [{ title: "Invalid thinking evidence", sources: [
      { address: `T${turnId}#E1`, text: "Private inference" }] }] })).toContain("rejected:");
    expect(m.store.listTurnFacts(turnId)).toEqual([]);
  } finally { m.close(); }
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
  expect(rendered.receipts[1]).toContain('"address":"T1#E1"');
});

test("trace rejects tool selection at direct, bound and continuation boundaries; whole entry retains call IDs", () => {
  const { m, first, session } = fixture();
  const bound = m.tools({ kind: "manual", sessionId: session.id, branch: "main", currentTurnId: first.id });
  const trace = bound.find(tool => tool.name === "trace")!;
  expect((trace.parameters.properties as Record<string, unknown>).tool).toBeUndefined();
  expect(trace.execute({ address: `T${first.id}#E2`, tool: 1 })).toMatch(/^rejected:/);
  expect(() => m.trace(`T${first.id}#E2`, { tool: 1 } as never)).toThrow(/tool parameter is removed/);
  const firstPage = m.trace(`T${first.id}#E1,T${first.id}#E2`, { cap: 1 });
  const cursor = /cursor=([0-9a-f-]+)/.exec(firstPage)?.[1];
  expect(cursor).toBeDefined();
  expect(trace.execute({ address: "cursor=" + cursor, tool: 1 })).toMatch(/^rejected:/);
  expect(() => m.trace(`T${first.id}#E2`, { cursor, tool: 1 } as never)).toThrow(/tool parameter is removed/);
  expect(m.trace(`T${first.id}#E2`)).toContain("assistant: reply");
});

test("knowledge injection charges IDs only while explicit trace/search display support titles", () => {
  const { m, first, second, session, note } = fixture();
  expect(note.execute({ facts: [{ title: "A descriptive episode title", sources: [{ address: `T${first.id}#E1`, text: "User asks a question" }] }] })).toContain("ok: F1");
  const memory = m.tools({ kind: "manual", sessionId: session.id, branch: "main", currentTurnId: second.id }).find(tool => tool.name === "memory")!;
  const result = JSON.parse(memory.execute({ operations: [{ op: "create", text: "A lasting rule", category: "constraint",
    scope: "project", topics: [], reason: "user choice", supports: ["F1"] }], skipped: [] }));
  expect(result.committed).toHaveLength(1);
  const id = result.committed[0].knowledgeId;
  const injected = m.injection(session.id);
  expect(injected.text).toContain("supports: F1");
  expect(injected.text).not.toContain("A descriptive episode title");
  expect(injected.knowledgeTokens).toBe(tokens(injected.text));
  expect(m.trace(`K${id}`, { sessionId: session.id, branch: "main", headTurnId: second.id })).toContain("F1 A descriptive episode title");
  expect(m.search("lasting rule", "knowledge", { sessionId: session.id, branch: "main", headTurnId: second.id,
    fields: ["text", "supports"] })).toContain("F1 A descriptive episode title");
});

test("named project remains a readable collection", () => {
  const { m } = fixture();
  expect(m.trace("93-read")).toContain("selected: project 93-read");
});

test("named projects keep the Store's original name lookup, including punctuation", () => {
  const { m } = fixture();
  const name = "client/app: staging";
  m.store.createProject({ name, declaredBy: "mark" });
  expect(m.trace(name)).toContain(`selected: project ${name}`);
});

test("Turn local source selection follows authored path order, not allocated entry ids or input order", () => {
  const { m, first, second, session, note } = fixture();
  const entries = m.store.sourcePath(session.id, "main", second.id);
  const firstE1 = entries.find(entry => entry.turnId === first.id && entry.entryOrdinal === 1)!;
  const firstE2 = entries.find(entry => entry.turnId === first.id && entry.entryOrdinal === 2)!;
  const secondE1 = entries.find(entry => entry.turnId === second.id && entry.entryOrdinal === 1)!;
  m.store.publishSourcePath(session.id, "main", [firstE2.id, firstE1.id, secondE1.id], second.id, "reverse");
  expect(note.execute({ facts: [{ title: "Reversed native order", sources: [
    { address: `T${second.id}#E1`, text: "later" },
    { address: `T${first.id}#E1`, text: "early by allocation" },
    { address: `T${first.id}#E2`, text: "first on path" },
  ] }] })).toContain("ok: F1");
  const fact = m.store.getFact(1)!;
  expect(fact.segments).toEqual(["first on path", "early by allocation", "later"]);
  const turn = m.trace(`T${first.id}`, { sessionId: session.id, branch: "main", headTurnId: second.id });
  expect(turn.indexOf("first on path")).toBeLessThan(turn.indexOf("early by allocation"));
  expect(turn).not.toContain("later");
});

test("plain Turn full and null content ceilings preserve the same uncut pending Raw", () => {
  const { m, first, session } = fixture();
  const long = "raw-payload-".repeat(1000);
  m.store.appendSourceEntry({ sessionId: session.id, turnId: first.id, nativeId: "long-raw", nativeLineage: "main",
    role: "assistant", text: long, raw: long, calls: [] });
  const full = m.trace(`T${first.id}`, { full: true, pageBudget: null });
  const unbounded = m.trace(`T${first.id}`, { itemBudget: null, toolCallBudget: null, toolResultBudget: null, pageBudget: null });
  expect(full).toBe(unbounded);
  expect(full).toContain("question");
  expect(full).toContain("reply");
  expect(full).toContain(long);
});

test("a fact backlink groups citing history under visible current identity, including current archive", () => {
  const { m, first, second, session, note } = fixture();
  expect(note.execute({ facts: [
    { title: "First finding", sources: [{ address: `T${first.id}#E1`, text: "Original evidence" }] },
    { title: "Later finding", sources: [{ address: `T${second.id}#E1`, text: "Later evidence" }] },
  ] })).toContain("ok: F2");
  const context = { kind: "manual" as const, sessionId: session.id, branch: "main", currentTurnId: second.id };
  const memory = m.tools(context).find(tool => tool.name === "memory")!;
  const create = JSON.parse(memory.execute({ operations: [{ op: "create", text: "Rule", category: "constraint",
    scope: "session", topics: [], reason: "first", supports: ["F1"] }], skipped: [] }));
  const id = create.committed[0].knowledgeId;
  const firstCommit = m.store.resolveVersionOrdinal(id, 1);
  const tag = m.store.versionTag(id, firstCommit);
  const archive = JSON.parse(memory.execute({ operations: [{ op: "archive", id: `K${id}#${tag}`,
    reason: "reconsidered", supports: ["F2"] }], skipped: [] }));
  expect(archive.committed).toHaveLength(1);
  const prepare = m.store.db.prepare.bind(m.store.db);
  const reads = { citations: 0, ordinals: 0, searchFacts: 0 };
  m.store.db.prepare = ((sql: string) => {
    if (/SELECT j.value AS fact_id, r.knowledge_id/.test(sql)) reads.citations++;
    if (/SELECT commit_id, ordinal FROM knowledge_version_tags/.test(sql)) reads.ordinals++;
    if (/SELECT \* FROM facts WHERE id IN/.test(sql)) reads.searchFacts++;
    return prepare(sql);
  }) as typeof m.store.db.prepare;
  const text = m.trace("F1,F2", { sessionId: session.id, branch: "main", headTurnId: second.id, pageBudget: null });
  expect(text).toContain(`K${id}@v2 — cited by v1; current v2 (archived)`);
  expect(reads.citations).toBe(1);
  expect(reads.ordinals).toBe(1);
  expect(m.search("finding", "facts", { sessionId: session.id, branch: "main", headTurnId: second.id, pageBudget: null })).toContain("First finding");
  expect(reads.searchFacts).toBe(1);
  const bodyHit = m.search("Original evidence", "facts", { sessionId: session.id, branch: "main", headTurnId: second.id });
  expect(bodyHit).toContain("First finding");
  expect(bodyHit).toContain("Original evidence");
  expect(m.trace(`K${id}@v1`, { sessionId: session.id, branch: "main", headTurnId: second.id })).toContain("F1 First finding");
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
  const text = m.trace("F1");
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
  expect(m.trace("F1")).toContain(`T${first.id}#E${original.entryOrdinal}`);
  expect(m.trace("F1")).not.toContain(`T${first.id}#E${extra.entryOrdinal}`);
  expect(m.trace(`T${first.id}`)).toContain("bound historical");
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
  expect(() => m.trace("F1")).toThrow("F1: missing legacy source bindings");
  expect(() => m.trace(`T${first.id}`)).toThrow("F1: missing legacy source bindings");
  expect(() => m.trace(`T${first.id}`, { sessionId: session.id, branch: "main", headTurnId: first.id }))
    .toThrow("F1: missing legacy source bindings");
  m.store.db.prepare("UPDATE facts SET source=? WHERE id=1")
    .run(JSON.stringify([`S${session.id}/T${first.id}#assistant`]));
  expect(() => m.trace(`T${first.id}`)).toThrow("F1: missing legacy source bindings");
  expect(() => m.trace("F1")).toThrow("F1: missing legacy source bindings");
  expect(note.execute({ facts: [{ title: "new", sources: [{ address: `T${first.id}#E1`, text: "segment" }] }] })).toContain("ok: F2");
  m.store.db.prepare("UPDATE facts SET text = 'damaged' WHERE id=2").run();
  expect(() => m.trace("F2")).toThrow("source segments, roles and body disagree");
});

test("a paged search keeps the selected fact preview after later writes", () => {
  const { m, first, second, note } = fixture();
  expect(note.execute({ facts: [
    { title: "First frozen", sources: [{ address: `T${first.id}#E1`, text: "shared finding first" }] },
    { title: "Second frozen", sources: [{ address: `T${second.id}#E1`, text: "shared finding second" }] },
  ] })).toContain("ok: F2");
  const firstPage = m.search("shared finding", "facts", { cap: 1, maxTokens: 500 });
  const cursor = /cursor=([0-9a-f-]+)/.exec(firstPage)?.[1];
  expect(cursor).toBeDefined();
  expect(note.execute({ facts: [{ title: "Third added", sources: [{ address: `T${second.id}#E2`, text: "shared finding third" }] }] })).toContain("ok: F3");
  const page = m.search("", "facts", { cursor });
  expect(page).toContain("Second frozen");
  expect(page).not.toContain("Third added");
});

test("Turn shows pending Raw and processed uncited entries only by address", () => {
  const { m, second, session } = fixture();
  const entries = m.store.sourcePath(session.id, "main", second.id).filter(entry => entry.turnId === second.id);
  expect(m.store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, branch: "main", createdAt: "now" },
    entryIds: [entries[0]!.id], facts: [] }).ok).toBe(true);
  const turn = m.trace(`T${second.id}`, { sessionId: session.id, branch: "main", headTurnId: second.id });
  expect(turn).toContain(`Processed, not cited: T${second.id}#E1`);
  expect(turn).not.toContain("follow up");
  expect(turn).toContain("answer");
});

test("invisible global current successor hides an earlier visible project identity without leaking its version", () => {
  const { m, first, second, session, note } = fixture();
  expect(note.execute({ facts: [{ title: "Shared source", sources: [{ address: `T${first.id}#E1`, text: "Public evidence" }] }] })).toContain("ok: F1");
  const memory = m.tools({ kind: "manual", sessionId: session.id, branch: "main", currentTurnId: second.id })
    .find(tool => tool.name === "memory")!;
  const create = JSON.parse(memory.execute({ operations: [{ op: "create", text: "Project rule", category: "constraint",
    scope: "project", topics: [], reason: "original", supports: ["F1"] }], skipped: [] }));
  const id = create.committed[0].knowledgeId;
  const peer = m.store.createSession({ projectId: m.store.getSession(session.id)!.projectId,
    host: "pi:peer", enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
  const peerTurn = m.store.appendTurn({ sessionId: peer.id, kind: "turn", userPrompt: "private", startedAt: "now" });
  const privateNote = m.tools({ kind: "manual", sessionId: peer.id, branch: "main", currentTurnId: peerTurn.id }).find(tool => tool.name === "note")!;
  expect(privateNote.execute({ facts: [{ title: "Private source", sources: [{ address: `T${peerTurn.id}#E1`, text: "Private evidence" }] }] })).toContain("ok: F2");
  const changed = commitNoterKnowledge(m.store, { path: { sessionId: peer.id, branch: "main", headTurnId: peerTurn.id },
    run: { sessionId: peer.id, branch: "main", createdAt: "later" }, operations: [{ op: "update", knowledgeId: id,
      baseCommit: m.store.resolveVersionOrdinal(id, 1), text: "Private successor", category: "constraint", scope: "session",
      topics: [], reason: "restricted", supports: [2], createdAt: "later" }] });
  expect(changed.ok).toBe(true);
  const text = m.trace("F1", { sessionId: session.id, branch: "main", headTurnId: second.id });
  expect(text).not.toContain(`K${id}@v`);
  expect(text).not.toContain(`K${id}#`);
  expect(text).not.toContain("Private successor");
});

test("Turn includes the contributing slice from another Turn's owner; exact entry enforces role", () => {
  const { m, first, second, session, note } = fixture();
  const result = note.execute({ facts: [{ title: "Conversation advances", sources: [
    { address: `T${first.id}#E1`, text: "Question is raised" },
    { address: `T${second.id}#E2`, text: "Pi agent answers" },
  ] }] });
  expect(result).toContain("ok: F1");
  const options = { sessionId: session.id, branch: "main", headTurnId: second.id, pageBudget: null };
  const turn = m.trace(`T${second.id}`, options);
  expect(turn).toContain("Conversation advances");
  expect(turn).toContain(`[T${second.id}#E2@assistant] Pi agent answers`);
  expect(turn).not.toContain("Question is raised");
  expect(turn).toContain(`T${second.id}#E1..E2`);
  expect(m.trace(`T${second.id}#E1@user`, options)).toContain("follow up");
  expect(() => m.trace(`T${second.id}#E1@assistant`, options)).toThrow(/role does not match/);
  expect(m.trace("F1", options)).toContain("Conversation advances");
});
