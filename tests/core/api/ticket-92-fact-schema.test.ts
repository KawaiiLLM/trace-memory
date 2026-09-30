import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceSeededMemory, type NotingAgentInput } from "../../source-fixture.ts";
import { renderFact, renderFactPreview, renderFactGroups } from "../../../src/core/render/index.ts";
import { toolDefinitions, canonicalToolNames } from "../../../src/core/api/index.ts";
import { assignVersionTag } from "../../../src/core/store/version-tags.ts";
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
const slice = (text: string, addresses: string[]) => ({ title: "Source-backed claim",
  sources: addresses.map((address, index) => ({ address, text: index === 0 ? text : `Contributed at ${address}` })) });

test("92: one note schema derives ordered entry roles and original harness, not fact-wide actor", () => {
  const f = fixture();
  try {
    const schema = (toolDefinitions.find(t => t.name === "note")!.parameters.properties as any).facts.items;
    expect(Object.keys(schema.properties)).toEqual(["slot", "title", "sources", "support", "negate"]);
    expect(schema.properties.slot.description).toContain("N only");
    const result = JSON.parse(f.note.execute({ facts: [slice("User proposed A; Pi agent reported B; tool returned C.", f.source)] }));
    expect(result.factIds).toHaveLength(1);
    const fact = f.memory.store.getFact(result.factIds[0])!;
    expect(fact).toMatchObject({ category: null, actor: null, quote: null, status: null, source: f.source,
      roles: [{ role: "user" }, { role: "assistant", harness: "Pi agent" }, { role: "assistant", harness: "Pi agent" }, { role: "observation" }] });
    expect(f.memory.store.factEntries(fact.id)).toEqual(f.entries.map(e => e.id));
    expect(renderFact(fact, [])).toContain(`[${f.source[1]}@assistant]`);
    expect(renderFact(fact, [])).toContain(`[${f.source[3]}@observation]`);
    expect(renderFactPreview(fact, new Set(["text"]))).not.toContain("[null/null]");
    const next = f.memory.tools({ kind: "manual", sessionId: f.session.id, currentTurnId: f.turn.id, branch: "main" })
      .find(tool => tool.name === "note")!;
    const related = JSON.parse(next.execute({ facts: [{ ...slice("User confirmed the proposal", [f.source[0]!]),
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
      `T${f.turn.id}#E1..E2`, `T${f.turn.id}#E1,E2`, `T${f.turn.id}#E1@thinking`,
      `${f.source[1]}@text`, `${f.source[2]}@call-1`]) {
      const receipt = f.note.execute({ facts: [slice("wrong source", [source])] });
      expect(receipt).toContain("rejected:");
    }
    expect(f.memory.store.listTurnFacts(f.turn.id)).toEqual([]);
    expect(f.note.execute({ facts: [{ ...slice("wrong actor", [f.source[1]!]), actor: "user" }] })).toContain("unexpected field");
    const accepted = JSON.parse(f.note.execute({ facts: [slice("Claude Code stated B", [f.source[1]!])] }));
    const fact = f.memory.store.getFact(accepted.factIds[0])!;
    expect(fact.roles).toEqual([{ role: "assistant", harness: "Claude Code" }]);
    expect(renderFact(fact, [])).toContain(`[${f.source[1]}@assistant]`);
  } finally { f.memory.close(); }
});

test("92: legacy knowledge is found as understanding in search and exact history without rewriting category", () => {
  const f = fixture();
  try {
    const written = JSON.parse(f.note.execute({ facts: [slice("User identified a lasting design mechanism", [f.source[0]!])] }));
    const factId = written.factIds[0];
    const runId = Number((f.memory.store.db.prepare("SELECT run_id FROM facts WHERE id=?").get(factId) as { run_id: number }).run_id);
    const knowledgeId = Number(f.memory.store.db.prepare("INSERT INTO knowledge (project_id,origin_session_id,author) VALUES (?,?,'legacy')")
      .run(f.session.projectId, f.session.id).lastInsertRowid);
    const commit = Number(f.memory.store.db.prepare(`INSERT INTO knowledge_revisions
      (knowledge_id,parent_id,text,category,scope,supports,support_semantics,op,reason,topics,run_id,created_at,actor_role)
      VALUES (?,NULL,'legacy mechanism needle','mechanism','session',?,'change','create','legacy','[]',?,'now','manual')`)
      .run(knowledgeId, JSON.stringify([factId]), runId).lastInsertRowid);
    assignVersionTag(f.memory.store.db, knowledgeId, commit);
    const options = { sessionId: f.session.id, branch: "main", headTurnId: f.turn.id, category: "understanding" as const };
    expect(f.memory.search("legacy mechanism needle", "knowledge", options)).toContain(`[K${knowledgeId}@${commit}] [understanding/session]`);
    expect(f.memory.trace(`K${knowledgeId}@v1`, options)).toContain("[understanding/session]");
    expect(f.memory.search("legacy mechanism needle", "knowledge", { ...options, category: "open" })).not.toContain(`[K${knowledgeId}@${commit}]`);
    expect(f.memory.store.getKnowledgeRevision(knowledgeId, commit)!.category).toBe("mechanism");
    const tools = f.memory.tools({ kind: "manual", sessionId: f.session.id, currentTurnId: f.turn.id, branch: "main" });
    expect(tools.find(tool => tool.name === "trace")!.execute({ address: `K${knowledgeId}@v1` })).toContain("legacy mechanism needle");
    const archived = JSON.parse(tools.find(tool => tool.name === "memory")!.execute({ operations: [
      { op: "archive", kind: "budget", id: `K${knowledgeId}#${f.memory.store.versionTag(knowledgeId, commit)}`, supports: [`F${factId}`], reason: "Legacy item retired" }], skipped: [] }));
    expect(archived.committed).toHaveLength(1);
    expect(f.memory.store.getKnowledgeRevision(knowledgeId, f.memory.store.resolveVersionOrdinal(knowledgeId, 2))!.category).toBe("mechanism");
  } finally { f.memory.close(); }
});

test("92: CC adapter writes against the borrowed target and renders legacy category filters", async () => {
  const f = fixture("pi:borrowed");
  try {
    const projection = { memory: f.memory, coreSessionId: f.session.id, branch: "main", headTurnId: f.turn.id,
      triggerEntryId: f.entries.at(-1)!.id, entryIds: f.entries.map(entry => entry.id) };
    const adapter = new CcForegroundTools({ forkToolCall: () => null, waitForToolCall: async () => projection,
      toolProjection: async () => ({ memory: f.memory, binding: projection }) } as unknown as CcCoordinator);
    const meta = { "claudecode/toolUseId": "borrowed-call" };
    expect((await adapter.call("note", { facts: [{ ...slice("wrong", [f.source[1]!]), actor: "agent" }] }, meta)).isError).toBe(true);
    const written = await adapter.call("note", { facts: [slice("Pi agent explained the rule; the tool returned evidence", [f.source[1]!, f.source[3]!])] }, meta);
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
    assignVersionTag(f.memory.store.db, knowledgeId, commit);
    const searched = await adapter.call("search", { query: "borrowed legacy reference", layer: "knowledge", category: "understanding" }, null);
    expect(searched.content[0]!.text).toContain(`[K${knowledgeId}@v1] [understanding/session]`);
    const injected = f.memory.injection({ sessionId: f.session.id, branch: "main", headTurnId: f.turn.id });
    const tag = injected.text.match(new RegExp(`K${knowledgeId}#[a-z]{4,}`))![0];
    const archived = await adapter.call("memory", { operations: [{ op: "archive", kind: "budget", id: tag, supports: [`F${id}`], reason: "retired" }], skipped: [] }, meta);
    expect(archived.isError).toBeUndefined();
    expect(JSON.parse(archived.content[0]!.text).committed[0].version).toBe(`K${knowledgeId}@v2`);
    const unbound = new CcForegroundTools({ toolProjection: async () => ({ memory: f.memory }) } as unknown as CcCoordinator);
    const historical = await unbound.call("trace", { address: `K${knowledgeId}@v1` }, null);
    expect(historical.content[0]!.text).toContain(tag);
    expect(historical.content[0]!.text).not.toMatch(/K\d+@\d+/);
  } finally { f.memory.close(); }
});

test("92: essential quoted identifiers stay literal and legacy groups name only their session context", () => {
  const f = fixture("cc:legacy");
  try {
    const text = 'Claude Code received the error 「unknown knowledge K12」 and 「missing F9」.';
    const receipt = JSON.parse(f.note.execute({ facts: [slice(text, [f.source[0]!])] }));
    expect(receipt.factIds).toHaveLength(1);
    expect(f.memory.store.getFact(receipt.factIds[0])!.text).toBe(text);
    expect(f.memory.store.listFactRelations(receipt.factIds[0])).toEqual([]);
    const next = f.memory.tools({ kind: "manual", sessionId: f.session.id, currentTurnId: f.turn.id, branch: "main" }).find(t => t.name === "note")!;
    expect(next.execute({ facts: [slice("This adopts K12", [f.source[0]!])] })).toContain("must not embed");
    expect(next.execute({ facts: [{ ...slice(text, [f.source[0]!]), support: [["F99999", "strong"]] }] })).toContain("rejected:");
    const legacy = f.memory.store.commitNotingRun({ run: { kind: "manual", sessionId: f.session.id, createdAt: "now" }, facts: [{
      turnId: f.turn.id, category: "observation", actor: "agent", text: "A pasted discussion", source: [`T${f.turn.id}#assistant`], entryIds: [f.entries[1]!.id], createdAt: "now",
    }] });
    if (!legacy.ok) throw new Error(legacy.problems.join("; "));
    const before = f.memory.store.db.prepare("SELECT * FROM facts WHERE id=?").get(legacy.facts[0]!.id);
    const metadata = f.memory.store.factTurnTimes(legacy.facts);
    const shown = renderFactGroups(legacy.facts, fact => renderFact(fact, []), metadata).join("\n");
    expect(shown).toContain("session harness: Claude Code (context, not claim attribution)");
    expect(shown).toContain("[observation/agent]");
    expect(f.memory.store.db.prepare("SELECT * FROM facts WHERE id=?").get(legacy.facts[0]!.id)).toEqual(before);
  } finally { f.memory.close(); }
});

test("92: N material carries legacy owner-session harness context without rewriting the old fact", async () => {
  let inputText = "";
  const memory = sourceSeededMemory(":memory:", async raw => {
    const input = raw as NotingAgentInput;
    inputText = input.text;
    input.reportRequest({ fixture: "legacy N" });
    input.tools.find(t => t.name === "note")!.execute({ facts: [] });
    input.tools.find(t => t.name === "memory")!.execute({ operations: [], skipped: [] });
    return { outcome: "success", output: "done", request: { fixture: "legacy N" } };
  });
  try {
    const project = memory.store.createProject({ name: "legacy-N", declaredBy: "mark" });
    const session = memory.store.createSession({ projectId: project.id, host: "cc:legacy-N", startedAt: "now", firstReplyAt: "now", enrollmentChoice: true });
    const old = memory.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "older", assistantText: "Legacy claim", startedAt: "now" });
    const entries = memory.store.sourcePath(session.id, "main", old.id);
    const result = memory.store.commitNotingRun({ run: { kind: "noting", sessionId: session.id, branch: "main", createdAt: "now" }, entryIds: entries.map(e => e.id), facts: [{
      turnId: old.id, text: "Legacy actor episode", category: "observation", actor: "agent", source: [`T${old.id}#assistant`], entryIds: [entries[1]!.id], createdAt: "now",
    }] });
    if (!result.ok) throw new Error(result.problems.join("; "));
    const before = memory.store.db.prepare("SELECT * FROM facts WHERE id=?").get(result.facts[0]!.id);
    const next = memory.store.appendTurn({ sessionId: session.id, parentTurnId: old.id, kind: "turn", userPrompt: "new question", startedAt: "later" });
    const noting = await memory.noting({ sessionId: session.id, branch: "main", headTurnId: next.id, toolNames: canonicalToolNames });
    expect(noting.outcome, JSON.stringify(noting)).toBe("success");
    expect(inputText).toContain("Legacy actor episode");
    expect(inputText).toContain("[observation/agent]");
    expect(inputText).toContain("session harness: Claude Code (context, not claim attribution)");
    expect(memory.store.db.prepare("SELECT * FROM facts WHERE id=?").get(result.facts[0]!.id)).toEqual(before);
  } finally { memory.close(); }
});

test("92: Store recalculates source roles; caller cannot supply borrowed or reordered labels", () => {
  const f = fixture();
  try {
    const run = { kind: "manual" as const, sessionId: f.session.id, createdAt: "now" };
    const selected = f.memory.store.commitNotingRun({ run, facts: [{ turnId: f.turn.id, text: "block source", source: [`${f.source[0]}@text`], entryIds: [f.entries[0]!.id], createdAt: "now" }] });
    expect(selected.ok).toBe(false);
    expect(f.memory.store.listTurnFacts(f.turn.id)).toEqual([]);
    expect(f.memory.trace(`${f.source[0]}@user`)).toContain("User proposed A");
    const malformed = f.memory.store.commitNotingRun({ run, facts: [{ turnId: f.turn.id, text: "not bound to citation", source: [f.source[1]!], entryIds: [f.entries[0]!.id], createdAt: "now" }] });
    expect(malformed.ok).toBe(false);
    const valid = f.memory.store.commitNotingRun({ run, facts: [{ turnId: f.turn.id, text: "actual user", source: [f.source[0]!], entryIds: [f.entries[0]!.id], createdAt: "now" }] });
    if (!valid.ok) throw new Error(valid.problems.join("; "));
    expect(valid.facts[0]!.roles).toEqual([{ role: "user" }]);
  } finally { f.memory.close(); }
});
