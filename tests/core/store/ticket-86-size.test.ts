import { afterEach, expect, test } from "vitest";
import { tokens } from "../../../src/core/render/index.ts";
import { Store } from "../../../src/core/store/index.ts";
import { sourceSeededMemory, type NotingAgentInput } from "../../source-fixture.ts";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

function fixture() {
  const store = new Store(":memory:"); stores.push(store);
  const project = store.createProject({ name: "size", declaredBy: "mark" });
  const session = store.createSession({ host: "test", projectId: project.id, enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
  const turn = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "evidence", startedAt: "now" });
  const path = { sessionId: session.id, branch: "main", headTurnId: turn.id };
  const fact = (text: string, kind: "manual" | "noting" = "manual") => store.commitNotingRun({ run: { kind, sessionId: session.id, createdAt: "now" }, facts: [
    { turnId: turn.id, text, category: "decision", actor: "user", source: [`T${turn.id}#user`], createdAt: "now" },
  ] });
  const evidence = fact("An accepted direct observation");
  if (!evidence.ok) throw Error(evidence.problems.join("; "));
  return { store, project, session, path, fact, evidence: evidence.facts[0]! };
}

function sized(size: number) {
  // An estimator-accurate boundary, including its trailing space and no hidden framing.
  let text = "word ".repeat(size);
  while (tokens(text) > size) text = text.slice(0, -1);
  while (tokens(text) < size) text += "x";
  expect(tokens(text)).toBe(size);
  return text;
}

test("86: N fact write accepts 1000, rejects 1001 and rolls back the entire batch; manual note is unchanged", () => {
  const f = fixture(), exact = sized(1000), over = sized(1001);
  expect(f.fact(exact, "noting").ok).toBe(true);
  const before = f.store.listTurnFacts(f.path.headTurnId).length;
  const refused = f.store.commitNotingRun({ run: { kind: "noting", sessionId: f.session.id, createdAt: "now" }, facts: [
    { turnId: f.path.headTurnId, text: "accepted before rejection", category: "decision", actor: "user", source: [`T${f.path.headTurnId}#user`], createdAt: "now" },
    { turnId: f.path.headTurnId, text: over, category: "decision", actor: "user", source: [`T${f.path.headTurnId}#user`], createdAt: "now" },
  ] });
  expect(refused.ok).toBe(false);
  if (!refused.ok) expect(refused.problems.join(" ")).toMatch(/Fact.*1000-token limit: 1001 tokens/);
  expect(f.store.listTurnFacts(f.path.headTurnId)).toHaveLength(before);
  expect(f.fact(over, "manual").ok).toBe(true);
});

test("92: held N create/update cap resulting text at 1000; manual memory remains unrestricted", async () => {
  const exact = sized(1000), over = sized(1001);
  let script!: (task: NotingAgentInput) => void;
  const memory = sourceSeededMemory(":memory:", async raw => {
    const task = raw as NotingAgentInput;
    script(task);
    return { outcome: "success", output: "done", request: { exact: "size test" } };
  });
  try {
    const store = memory.store;
    const project = store.createProject({ name: "size", declaredBy: "mark" });
    const session = store.createSession({ host: "pi:size", projectId: project.id, enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
    const turn = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "User gave evidence", startedAt: "now" });
    const path = { sessionId: session.id, branch: "main", headTurnId: turn.id };
    const call = (task: NotingAgentInput, name: "note" | "memory", payload: unknown) => task.tools.find(tool => tool.name === name)!.execute(payload);
    const operation = (text: string, id?: string) => ({ op: id ? "update" : "create", ...(id ? { id } : {}),
      text, category: "constraint", scope: "project", supports: ["$1"], topics: [], reason: "User evidence" });
    script = task => {
      expect(call(task, "note", { facts: [{ text: "User gave evidence", source: [`T${turn.id}#E1`] }] })).toContain("held: $1");
      expect(call(task, "memory", { operations: [operation("would roll back"), operation(over)], skipped: [] }))
        .toMatch(/Knowledge item.*1000-token limit: 1001 tokens/);
    };
    const pending = store.pendingEntryIds(session.id, "main", turn.id);
    const rejectedCreate = await memory.noting(path);
    expect(rejectedCreate.outcome).toBe("bounced");
    expect("problems" in rejectedCreate && rejectedCreate.problems?.join(" ")).toMatch(/1000-token limit: 1001 tokens/);
    expect(store.listKnowledgeRevisions()).toHaveLength(0);
    expect(store.listSessionFacts(session.id)).toEqual([]);
    expect(store.pendingEntryIds(session.id, "main", turn.id)).toEqual(pending);
    script = task => {
      expect(call(task, "note", { facts: [{ text: "User gave evidence", source: [`T${turn.id}#E1`] }] })).toContain("held: $1");
      expect(call(task, "memory", { operations: [operation(exact)], skipped: [] })).toContain("held: M1");
    };
    expect((await memory.noting(path)).outcome).toBe("success");
    const base = store.currentKnowledge(path)[0]!;
    expect(tokens(base.revision.text)).toBe(1000);
    const next = store.appendTurn({ sessionId: session.id, parentTurnId: turn.id, kind: "turn", userPrompt: "User revised evidence", startedAt: "later" });
    const nextPath = { ...path, headTurnId: next.id };
    const tag = `K${base.knowledge.id}#${store.versionTag(base.knowledge.id, base.revision.id)}`;
    script = task => {
      expect(call(task, "note", { facts: [{ text: "User revised evidence", source: [`T${next.id}#E1`] }] })).toContain("held: $1");
      expect(call(task, "memory", { operations: [operation(over, tag)], skipped: [] }))
        .toMatch(/Knowledge item.*1000-token limit: 1001 tokens/);
    };
    const nextPending = store.pendingEntryIds(session.id, "main", next.id);
    const factsBefore = store.listSessionFacts(session.id);
    const rejectedUpdate = await memory.noting(nextPath);
    expect(rejectedUpdate.outcome).toBe("bounced");
    expect("problems" in rejectedUpdate && rejectedUpdate.problems?.join(" ")).toMatch(/1000-token limit: 1001 tokens/);
    expect(store.currentKnowledge(nextPath)[0]!.revision.id).toBe(base.revision.id);
    expect(store.listSessionFacts(session.id)).toEqual(factsBefore);
    expect(store.pendingEntryIds(session.id, "main", next.id)).toEqual(nextPending);
    script = task => {
      expect(call(task, "note", { facts: [{ text: "User revised evidence", source: [`T${next.id}#E1`] }] })).toContain("held: $1");
      expect(call(task, "memory", { operations: [operation(exact, tag)], skipped: [] })).toContain("held: M1");
    };
    expect((await memory.noting(nextPath)).outcome).toBe("success");
    expect(tokens(store.currentKnowledge(nextPath)[0]!.revision.text)).toBe(1000);
    const manual = store.commitConsolidationRun({ path: nextPath, run: { kind: "manual", sessionId: session.id, createdAt: "now" },
      operations: [{ op: "create", handle: "$manual", author: "test", text: over, category: "constraint", scope: "project",
        supports: [store.listTurnFacts(turn.id)[0]!.id], topics: [], reason: "manual exception", createdAt: "now" }] });
    expect(manual.ok).toBe(true);
  } finally { memory.close(); }
});
