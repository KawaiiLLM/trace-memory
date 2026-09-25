import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceSeededMemory } from "../../source-fixture.ts";
import { renderFact, renderFactPreview } from "../../../src/core/render/index.ts";
import { toolDefinitions } from "../../../src/core/api/tools.ts";
import { CcForegroundTools } from "../../../src/hosts/cc/tools.ts";
import type { CcCoordinator } from "../../../src/hosts/cc/lifecycle.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(host = "pi:fixture") {
  const dir = mkdtempSync(join(tmpdir(), "tm-92-source-")); dirs.push(dir);
  const memory = sourceSeededMemory(join(dir, "memory.sqlite"), async () => ({ outcome: "failure", output: "not invoked" }));
  const project = memory.store.createProject({ name: "entry-roles", declaredBy: "mark" });
  const session = memory.store.createSession({ projectId: project.id, host, startedAt: "now", firstReplyAt: "now", enrollmentChoice: true });
  const turn = memory.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "User proposed A", assistantText: "Pi agent reported B", startedAt: "now" });
  memory.store.appendToolCall({ turnId: turn.id, name: "test", input: "{}", result: "observed C", status: "success" });
  const entries = memory.store.sourcePath(session.id, "main", turn.id);
  const source = entries.map(entry => `T${turn.id}#E${entry.entryOrdinal}`);
  const note = memory.tools({ kind: "manual", sessionId: session.id, currentTurnId: turn.id, branch: "main" }).find(tool => tool.name === "note")!;
  return { memory, session, turn, source, entries, note };
}

test("92: one note schema derives ordered entry roles and original harness, not fact-wide actor", () => {
  const f = fixture();
  try {
    const schema = (toolDefinitions.find(t => t.name === "note")!.parameters.properties as any).facts.items;
    expect(Object.keys(schema.properties)).toEqual(["text", "source", "support", "negate"]);
    const result = JSON.parse(f.note.execute({ facts: [{ text: "User proposed A; Pi agent reported B; tool returned C.", source: f.source }] }));
    expect(result.factIds).toHaveLength(1);
    const fact = f.memory.store.getFact(result.factIds[0])!;
    expect(fact).toMatchObject({ category: null, actor: null, quote: null, status: null, source: f.source,
      roles: [{ role: "user" }, { role: "assistant", harness: "Pi agent" }, { role: "assistant", harness: "Pi agent" }, { role: "observation" }] });
    expect(f.memory.store.factEntries(fact.id)).toEqual(f.entries.map(e => e.id));
    expect(renderFact(fact, [])).toContain(`${f.source[1]} (Pi agent)`);
    expect(renderFact(fact, [])).toContain(`${f.source[3]} (observation)`);
    expect(renderFactPreview(fact, new Set(["text"]))).not.toContain("[null/null]");
    const next = f.memory.tools({ kind: "manual", sessionId: f.session.id, currentTurnId: f.turn.id, branch: "main" })
      .find(tool => tool.name === "note")!;
    const related = JSON.parse(next.execute({ facts: [{ text: "User confirmed the proposal", source: [f.source[0]],
      support: [[`F${fact.id}`, "strong"]] }] }));
    expect(related.factIds).toHaveLength(1);
    expect(f.memory.store.listFactRelationsOnPathOf([related.factIds[0]], { sessionId: f.session.id, branch: "main", headTurnId: f.turn.id })
      .get(related.factIds[0])).toEqual(expect.arrayContaining([expect.objectContaining({ fromFact: related.factIds[0], toFact: fact.id, kind: "support" })]));
  } finally { f.memory.close(); }
});

test("92: entry-only citations reject legacy, whole-Turn and multi-entry selectors without accepting sibling evidence", () => {
  const f = fixture("cc:fixture");
  try {
    for (const source of [`T${f.turn.id}`, `T${f.turn.id}@assistant`, `T${f.turn.id}#assistant`,
      `T${f.turn.id}#E1..E2`, `T${f.turn.id}#E1,E2`, `T${f.turn.id}#E1@thinking`]) {
      const receipt = f.note.execute({ facts: [{ text: "wrong source", source: [source] }] });
      expect(receipt).toContain("rejected:");
    }
    expect(f.memory.store.listTurnFacts(f.turn.id)).toEqual([]);
    expect(f.note.execute({ facts: [{ text: "wrong actor", actor: "user", source: [f.source[1]] }] })).toContain("unexpected field");
    const accepted = JSON.parse(f.note.execute({ facts: [{ text: "Claude Code stated B", source: [`${f.source[1]}@text`] }] }));
    const fact = f.memory.store.getFact(accepted.factIds[0])!;
    expect(fact.roles).toEqual([{ role: "assistant", harness: "Claude Code" }]);
    expect(renderFact(fact, [])).toContain("(Claude Code)");
  } finally { f.memory.close(); }
});

test("92: legacy knowledge is found as understanding in search and exact history without rewriting category", () => {
  const f = fixture();
  try {
    const written = JSON.parse(f.note.execute({ facts: [{ text: "User identified a lasting design mechanism", source: [f.source[0]] }] }));
    const factId = written.factIds[0];
    const runId = Number((f.memory.store.db.prepare("SELECT run_id FROM facts WHERE id=?").get(factId) as { run_id: number }).run_id);
    const knowledgeId = Number(f.memory.store.db.prepare("INSERT INTO knowledge (project_id,origin_session_id,author) VALUES (?,?,'legacy')")
      .run(f.session.projectId, f.session.id).lastInsertRowid);
    const commit = Number(f.memory.store.db.prepare(`INSERT INTO knowledge_revisions
      (knowledge_id,parent_id,text,category,scope,supports,support_semantics,op,reason,topics,run_id,created_at,actor_role)
      VALUES (?,NULL,'legacy mechanism needle','mechanism','session',?,'change','create','legacy','[]',?,'now','manual')`)
      .run(knowledgeId, JSON.stringify([factId]), runId).lastInsertRowid);
    const options = { sessionId: f.session.id, branch: "main", headTurnId: f.turn.id, category: "understanding" as const };
    expect(f.memory.search("legacy mechanism needle", "knowledge", options)).toContain(`[K${knowledgeId}@${commit}] [understanding/session]`);
    expect(f.memory.trace(`K${knowledgeId}@${commit}`, options)).toContain("[understanding/session]");
    expect(f.memory.search("legacy mechanism needle", "knowledge", { ...options, category: "open" })).not.toContain(`[K${knowledgeId}@${commit}]`);
    expect(f.memory.store.getKnowledgeRevision(knowledgeId, commit)!.category).toBe("mechanism");
    const tools = f.memory.tools({ kind: "manual", sessionId: f.session.id, currentTurnId: f.turn.id, branch: "main" });
    expect(tools.find(tool => tool.name === "trace")!.execute({ address: `K${knowledgeId}@${commit}` })).toContain("legacy mechanism needle");
    const archived = JSON.parse(tools.find(tool => tool.name === "memory")!.execute({ operations: [
      { op: "archive", id: `K${knowledgeId}@${commit}`, supports: [`F${factId}`], reason: "Legacy item retired" }], skipped: [] }));
    expect(archived.committed).toHaveLength(1);
    expect(f.memory.store.getKnowledgeRevision(knowledgeId, archived.committed[0].commit)!.category).toBe("understanding");
  } finally { f.memory.close(); }
});

test("92: CC adapter writes against the borrowed target and renders legacy category filters", async () => {
  const f = fixture("pi:borrowed");
  try {
    const projection = { memory: f.memory, coreSessionId: f.session.id, branch: "main", headTurnId: f.turn.id,
      triggerEntryId: f.entries.at(-1)!.id, entryIds: f.entries.map(entry => entry.id) };
    const adapter = new CcForegroundTools({ waitForToolCall: async () => projection,
      toolProjection: async () => ({ memory: f.memory, binding: projection }) } as unknown as CcCoordinator);
    const meta = { "claudecode/toolUseId": "borrowed-call" };
    expect((await adapter.call("note", { facts: [{ text: "wrong", source: [f.source[1]], actor: "agent" }] }, meta)).isError).toBe(true);
    const written = await adapter.call("note", { facts: [{ text: "Pi agent explained the rule; the tool returned evidence", source: [f.source[1], f.source[3]] }] }, meta);
    expect(written.isError).toBeUndefined();
    const id = JSON.parse(written.content[0]!.text).factIds[0];
    expect(f.memory.store.getFact(id)!.roles).toEqual([{ role: "assistant", harness: "Pi agent" }, { role: "observation" }]);
    const runId = Number((f.memory.store.db.prepare("SELECT run_id FROM facts WHERE id=?").get(id) as { run_id: number }).run_id);
    const knowledgeId = Number(f.memory.store.db.prepare("INSERT INTO knowledge (project_id,origin_session_id,author) VALUES (?,?,'legacy')")
      .run(f.session.projectId, f.session.id).lastInsertRowid);
    const commit = Number(f.memory.store.db.prepare(`INSERT INTO knowledge_revisions
      (knowledge_id,parent_id,text,category,scope,supports,support_semantics,op,reason,topics,run_id,created_at,actor_role)
      VALUES (?,NULL,'borrowed legacy reference','term','session',?,'change','create','legacy','[]',?,'now','manual')`)
      .run(knowledgeId, JSON.stringify([id]), runId).lastInsertRowid);
    const searched = await adapter.call("search", { query: "borrowed legacy reference", layer: "knowledge", category: "understanding" }, null);
    expect(searched.content[0]!.text).toContain(`[K${knowledgeId}@${commit}] [understanding/session]`);
  } finally { f.memory.close(); }
});

test("92: Store recalculates source roles; caller cannot supply borrowed or reordered labels", () => {
  const f = fixture();
  try {
    const run = { kind: "manual" as const, sessionId: f.session.id, createdAt: "now" };
    const malformed = f.memory.store.commitNotingRun({ run, facts: [{ turnId: f.turn.id, text: "not bound to citation", source: [f.source[1]!], entryIds: [f.entries[0]!.id], createdAt: "now" }] });
    expect(malformed.ok).toBe(false);
    const valid = f.memory.store.commitNotingRun({ run, facts: [{ turnId: f.turn.id, text: "actual user", source: [f.source[0]!], entryIds: [f.entries[0]!.id], createdAt: "now" }] });
    if (!valid.ok) throw new Error(valid.problems.join("; "));
    expect(valid.facts[0]!.roles).toEqual([{ role: "user" }]);
  } finally { f.memory.close(); }
});
