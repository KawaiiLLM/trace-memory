import { commitNoterKnowledge } from "../../noting-knowledge-fixture.ts";
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceSeededMemory, type DreamingAgentInput, type NotingAgentInput, type RunAgentResult } from "../../source-fixture.ts";
import { Store } from "../../../src/core/store/index.ts";
import { tokens } from "../../../src/core/render/index.ts";
import { REQUEST, scriptedNoter, type NoterOutput } from "../../support/noter.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
type Script = (task: NotingAgentInput) => Promise<NoterOutput> | NoterOutput;
/** `script` runs in each batch's write task and returns what the Noter writes; `dream` stands in for a Dreamer run. */
function fixture(script: Script, dream?: (task: DreamingAgentInput) => Promise<Partial<RunAgentResult> | void> | Partial<RunAgentResult> | void) {
  const dir = mkdtempSync(join(tmpdir(), "tm-92-held-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "memory.sqlite");
  const noter = scriptedNoter(() => memory, [script]);
  const memory = sourceSeededMemory(file, async raw => {
    const task = raw as NotingAgentInput | DreamingAgentInput;
    if (task.kind === "noting") return noter.agent(task);
    task.reportRequest(REQUEST);
    return { outcome: "success", output: "done", request: REQUEST, ...(await dream?.(task)) };
  }, { dreaming: { triggerTokens: 1 } });
  cleanup.push(() => memory.close());
  const project = memory.store.createProject({ name: "atomic", declaredBy: "mark" });
  const session = memory.store.createSession({ projectId: project.id, host: "pi:atomic", enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
  const turn = memory.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "User set the rule", assistantText: "Pi agent explained it", startedAt: "now" });
  const entries = memory.store.sourcePath(session.id, "main", turn.id);
  const path = { sessionId: session.id, branch: "main", headTurnId: turn.id };
  return { memory, file, session, turn, entries, path, noter, run: () => memory.noting(path) };
}
const call = (task: { tools: { name: string; execute(input: unknown): unknown }[] }, name: "note" | "memory", input: unknown) => task.tools.find(tool => tool.name === name)!.execute(input) as string;
const fact = (text = "User set the rule", source = "T1#E1") => ({ title: "Rule evidence", sources: `[${source}] ${text}` });
const knowledge = (supports = ["$1"]) => ({ op: "create", title: "Fixture title", text: "Use the stated rule", category: "constraint", scope: "session", supports, reason: "new rule", topics: [] });
const noted = (f: ReturnType<typeof fixture>) => f.entries.some(entry => f.memory.store.entryNoted(entry.id));

test("04: the batch stays private until task 2 passes, and task 2's corrections are what is published", async () => {
  const f = fixture(() => ({ noteInput: [fact(), fact("ninth, misattributed", "T1#E2")], memoryInput: knowledge(["$1", "$2"]),
    verify: files => {
      // Between the tasks and during task 2 nothing of the batch is in the database.
      const other = new Store(f.file);
      try {
        expect(other.listSessionFacts(f.session.id)).toEqual([]);
        expect(other.currentKnowledge(f.path)).toEqual([]);
        expect(f.entries.some(entry => other.entryNoted(entry.id))).toBe(false);
      } finally { other.close(); }
      return { facts: files.facts.replace("ninth, misattributed", "corrected ninth") };
    } }));
  expect(await f.run()).toMatchObject({ outcome: "success" });
  const facts = f.memory.store.listSessionFacts(f.session.id).sort((a, b) => a.id - b.id);
  expect(facts.map(item => item.text)).toEqual(["User set the rule", "corrected ninth"]);
  expect(f.memory.store.currentKnowledge(f.path)[0]!.revision.supports).toEqual([1, 2]);
  expect(f.entries.every(entry => f.memory.store.entryNoted(entry.id))).toBe(true);
});

test.each([false, true])("92: a block-source fact fails the stop check; the one correction to a whole entry recovers (%s)", async recover => {
  const f = fixture(() => ({ noteInput: [fact("selected block", "T1#E2@text")], memoryInput: {},
    ...(recover ? { fix: () => ({ facts: "## fact f1\ntitle: Rule evidence\n\n[T1#E2] Pi agent corrected it\n" }) } : {}) }));
  expect((await f.run()).outcome).toBe(recover ? "success" : "failure");
  expect(f.noter.stopMessages).toHaveLength(1); // exactly one follow-up to the write task
  const facts = f.memory.store.listSessionFacts(f.session.id);
  expect(facts).toHaveLength(recover ? 1 : 0);
  if (recover) expect(facts[0]!.roles).toEqual([{ role: "assistant", harness: "Pi agent" }]);
  expect(f.entries.every(entry => f.memory.store.entryNoted(entry.id))).toBe(recover);
});

test("04: another connection allocates the next F ID while the files exist; final mapping uses actual IDs", async () => {
  const f = fixture(() => {
    const other = new Store(f.file);
    try {
      const inserted = other.commitNotingRun({ run: { kind: "manual", sessionId: f.session.id, branch: "main", createdAt: "now" },
        facts: [{ turnId: f.turn.id, text: "Concurrent manual fact", source: ["T1#E1"], entryIds: [f.entries[0]!.id], createdAt: "now" }] });
      expect(inserted).toMatchObject({ ok: true, facts: [{ id: 1 }] });
    } finally { other.close(); }
    return { noteInput: [fact("held fact")], memoryInput: knowledge() };
  });
  expect((await f.run()).outcome).toBe("success");
  expect(f.memory.store.currentKnowledge(f.path)[0]!.revision.supports).toEqual([2]);
  expect(f.memory.store.getFact(2)!.text).toBe("held fact");
});

test("04: labels map to actual ids, a literal $3 in a body stays text, and a relation resolves to its fact", async () => {
  const f = fixture(() => ({ noteInput: [fact("first"), { ...fact("Pi agent's final explanation", "T1#E2"), support: [["$1", "strong"]] }],
    memoryInput: { ...knowledge(["$2"]), text: "Literal $3 stays text" } }));
  expect(await f.run()).toMatchObject({ outcome: "success" });
  const facts = f.memory.store.listSessionFacts(f.session.id).sort((a, b) => a.id - b.id);
  expect(facts[1]!.roles).toEqual([{ role: "assistant", harness: "Pi agent" }]);
  expect(f.memory.store.currentKnowledge(f.path)[0]!.revision.supports).toEqual([facts[1]!.id]);
  expect(f.memory.store.currentKnowledge(f.path)[0]!.revision.text).toBe("Literal $3 stays text");
  expect(f.memory.store.listFactRelations(facts[1]!.id)[0]).toMatchObject({ toFact: facts[0]!.id });
});

for (const failure of ["bad source", "bad supports", "no files", "provider", "cancel", "verify provider"])
  test(`04: ${failure} never publishes accepted siblings or processing`, async () => {
    const f = fixture(() => failure === "bad source" ? { noteInput: [fact(), fact("bad", "T1#E99")], memoryInput: {} }
      : failure === "bad supports" ? { noteInput: [fact()], memoryInput: knowledge(["$99"]) }
      : failure === "no files" ? { files: { facts: "", knowledge: "" } }
      : failure === "provider" ? { noteInput: [fact()], outcome: "failure", output: "late stream error", usage: { input: 7 } }
      : failure === "cancel" ? { noteInput: [fact()], outcome: "cancelled", output: "cancelled" }
      : { noteInput: [fact()], verifyResult: { outcome: "failure", output: "late stream error" } });
    expect((await f.run()).outcome).not.toBe("success");
    expect(f.memory.store.listSessionFacts(f.session.id)).toEqual([]);
    expect(f.memory.store.currentKnowledge(f.path)).toEqual([]);
    expect(noted(f)).toBe(false);
  });

for (const table of ["facts", "knowledge_revisions", "noted_entries"])
  test(`04: rollback after ${table} insertion leaves both layers and progress absent`, async () => {
    const f = fixture(() => {
      f.memory.store.db.exec(`CREATE TEMP TRIGGER fail_atomic AFTER INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'injected ${table}'); END`);
      return { noteInput: [fact()], memoryInput: knowledge() };
    });
    const result = await f.run();
    expect(result).toMatchObject({ outcome: "failure", problems: [expect.stringContaining(`injected ${table}`)] });
    expect(f.memory.store.listSessionFacts(f.session.id)).toEqual([]);
    expect(f.memory.store.currentKnowledge(f.path)).toEqual([]);
    expect(f.memory.pendingEntries(f.session.id, "main", f.turn.id)).toHaveLength(f.entries.length);
    // The only success run left is task 1's pass record, which owns no fact and no processed entry; the hand-off still waits for task 2.
    expect(f.memory.store.db.prepare("SELECT count(*) n FROM runs WHERE outcome='success'").get()).toMatchObject({ n: 1 });
    expect(f.memory.store.db.prepare("SELECT count(*) n FROM facts").get()).toMatchObject({ n: 0 });
    expect(f.memory.store.handoff(f.session.id, "noting")).not.toBeNull();
  });

test("116: manual writes commit one item at a time without N slots or local supports", () => {
  const f = fixture(() => ({}));
  const tools = f.memory.tools({ kind: "manual", ...f.path, currentTurnId: f.turn.id });
  const note = tools.find(tool => tool.name === "note")!, memory = tools.find(tool => tool.name === "memory")!;
  expect(JSON.parse(note.execute(fact("first"))).factIds).toEqual([1]);
  expect(JSON.parse(note.execute({ ...fact("second"), support: [["F1", "strong"]] })).factIds).toEqual([2]);
  expect(f.memory.store.listFactRelations(2)[0]).toMatchObject({ toFact: 1 });
  for (const input of [{ slot: "$1", ...fact("must not replace") }, { drop: "$1" }])
    expect(note.execute(input)).toContain("N-only");
  for (const input of [{ ...knowledge(["F1"]), slot: "M1" }, { drop: "M1" }])
    expect(memory.execute(input)).toContain("manual memory expects one");
  expect(memory.execute(knowledge())).toContain("local");
  expect(f.memory.store.listSessionFacts(f.session.id)).toHaveLength(2);
  expect(f.memory.store.currentKnowledge(f.path)).toEqual([]);
  expect(memory.execute(knowledge(["F1"]))).toContain("committed");
  expect(f.memory.store.currentKnowledge(f.path)).toHaveLength(1);
  expect(f.entries.some(entry => f.memory.store.entryNoted(entry.id))).toBe(false);
});

function seedKnowledge(f: ReturnType<typeof fixture>, scope: "session" | "project" | "global" = "session") {
  const note = f.memory.tools({ kind: "manual", ...f.path, currentTurnId: f.turn.id }).find(tool => tool.name === "note")!;
  const fid = JSON.parse(note.execute(fact("User supplied enduring evidence"))).factIds[0] as number;
  const content = { text: "Old rule", category: "constraint" as const, scope, topics: [], supports: [fid], reason: "initial", createdAt: "now" };
  const created = f.memory.store.commitConsolidationRun({ path: f.path, run: { kind: "manual", sessionId: f.session.id, createdAt: "now" },
    operations: [{ op: "create", title: "Fixture title", author: "test", handle: "$seed", ...content }] });
  if (!created.ok) throw new Error(created.problems.join("; "));
  const base = created.committed[0]!;
  const tag = `K${base.knowledgeId}#${f.memory.store.versionTag(base.knowledgeId, base.commit)}`;
  const advance = (archive = false) => {
    const other = new Store(f.file);
    try {
      const result = commitNoterKnowledge(other, { path: f.path, run: { sessionId: f.session.id, createdAt: "later" },
        operations: [archive ? { op: "archive", kind: "budget", knowledgeId: base.knowledgeId, baseCommit: base.commit, supports: [fid], reason: "retired", createdAt: "later" }
          : { op: "update", knowledgeId: base.knowledgeId, baseCommit: base.commit, ...content, text: "Concurrent rule" }] });
      if (!result.ok) throw new Error(result.problems.join("; "));
    } finally { other.close(); }
  };
  return { fid, base, tag, advance };
}


for (const when of ["write", "verify"] as const)
  test(`04: a concurrent update during ${when} preserves the original intent and audits the conversion`, async () => {
    const f = fixture(() => {
      if (when === "write") seed.advance();
      return { noteInput: [fact("User changed the rule")], memoryInput: { ...knowledge([`F${seed.fid}`, "$1"]), op: "update", id: seed.tag, text: "Requested rule" },
        verify: () => { if (when === "verify") seed.advance(); } };
    });
    const seed = seedKnowledge(f);
    const result = await f.run(); expect(result).toMatchObject({ outcome: "success" });
    const current = f.memory.store.currentKnowledge(f.path);
    expect(current).toHaveLength(2);
    expect(current.find(item => item.knowledge.id === seed.base.knowledgeId)!.revision.text).toBe("Concurrent rule");
    const created = current.find(item => item.knowledge.id !== seed.base.knowledgeId)!;
    expect(created.revision.text).toContain(seed.tag);
    expect(created.revision.supports).toHaveLength(2);
    expect(f.memory.store.pendingVersions(`session:${f.session.id}`, f.path).some(item => item.revisionId === created.revision.id)).toBe(true);
    if (!("runId" in result)) throw new Error("missing run");
    const audit = JSON.parse(f.memory.store.getRun(result.runId!)!.response!);
    expect(audit.knowledgeOperations[0].requested.op).toBe("update");
    expect(audit.knowledgeOperations[0].applied?.op).toBe("create");
    expect(audit.labels).toEqual({ f1: expect.stringMatching(/^F\d+$/) });
  });

// 144 supersedes the ruling that the final conflict annotation obeys the cap: the cap is checked when the file is written, and the
// note the system appends to a converted update afterwards is not checked again.
for (const when of ["write", "verify"] as const) test(`144/04: a body at the cap keeps its appended conflict annotation when the conflict is found during ${when}`, async () => {
  let body = "";
  while (tokens(`${body}x `) <= 200) body += "x ";
  expect(tokens(body)).toBe(200);
  const f = fixture(() => {
    if (when === "write") seed.advance();
    return { noteInput: [fact("Refinement")], memoryInput: { ...knowledge(), op: "update", id: seed.tag, text: body }, verify: () => { if (when === "verify") seed.advance(); } };
  });
  const seed = seedKnowledge(f);
  expect(await f.run()).toMatchObject({ outcome: "success" });
  const created = f.memory.store.currentKnowledge(f.path).find(item => item.knowledge.id !== seed.base.knowledgeId)!;
  expect(created.revision.text.startsWith(body.trimEnd())).toBe(true); // the file's body is trimmed
  expect(tokens(created.revision.text)).toBeGreaterThan(200);
});

test("04: an archived descendant is a legitimate advance", async () => {
  const f = fixture(() => { seed.advance(true); return { noteInput: [fact()], memoryInput: { ...knowledge(), op: "update", id: seed.tag } }; });
  const seed = seedKnowledge(f);
  const result = await f.run();
  expect(result, JSON.stringify(result)).toMatchObject({ outcome: "success" });
  expect(f.memory.store.currentKnowledge(f.path)).toHaveLength(1);
  expect(f.memory.store.currentKnowledge(f.path)[0]!.revision.text).toContain(seed.tag);
});

test.each([["an unknown version", "K1#zzzzzzzz"], ["evidence that does not exist", "F999"]])("04: %s never converts; the check refuses it", async (_label, bad) => {
  const f = fixture(() => ({ noteInput: [fact()], memoryInput: bad.startsWith("K")
    ? { ...knowledge(), op: "update", id: bad } : { ...knowledge([bad]), op: "update", id: seed.tag } }), undefined);
  const seed = seedKnowledge(f);
  const result = await f.run();
  expect(result.outcome).toBe("failure");
  expect(noted(f)).toBe(false);
});

test("04: a converted new identity is reconciled by ordinary D merge without a special queue", async () => {
  const f = fixture(() => { seed.advance(); return { noteInput: [fact("User supplied a refinement")], memoryInput: { ...knowledge(), op: "update", id: seed.tag } }; }, task => {
    const current = f.memory.store.currentKnowledge(f.path).sort((a, b) => a.knowledge.id - b.knowledge.id);
    expect(current).toHaveLength(2);
    const address = (index: number) => `K${current[index]!.knowledge.id}#${f.memory.store.versionTag(current[index]!.knowledge.id, current[index]!.revision.id)}`;
    expect(call(task, "memory", { op: "merge", id: address(0), absorb: [address(1)], text: "Resolved rule",
      category: "constraint", scope: "session", topics: [], supports: [], reason: "Reconciled concurrent proposal with current evidence" })).not.toContain("rejected:");
    task.tools.find(tool => tool.name === "check")!.execute({});
  });
  const seed = seedKnowledge(f);
  expect((await f.run()).outcome).toBe("success");
  expect(f.memory.store.listRuns(f.session.id).filter(run => run.kind === "dreaming")).toEqual([]);
  expect((await f.memory.dream(f.path)).outcome).toBe("success");
  expect(f.memory.store.currentKnowledge(f.path)).toHaveLength(1);
  expect(f.memory.store.currentKnowledge(f.path)[0]!.revision.text).toBe("Resolved rule");
});

test("04: failure after execution-success update rolls back warmed views and every business write", async () => {
  const f = fixture(() => {
    // Warm both read-side paths before entering the outer business transaction.
    expect(f.memory.store.currentKnowledge(f.path)).toEqual([]);
    expect(f.memory.pendingEntries(f.session.id, "main", f.turn.id)).toHaveLength(f.entries.length);
    f.memory.store.db.exec(`CREATE TEMP TRIGGER fail_success AFTER UPDATE OF outcome ON task_executions
      WHEN NEW.outcome='success' BEGIN SELECT RAISE(ABORT, 'injected execution success'); END`);
    return { noteInput: [fact()], memoryInput: knowledge() };
  });
  const result = await f.run();
  expect(result).toMatchObject({ outcome: "failure", problems: [expect.stringContaining("injected execution success")] });
  const other = new Store(f.file);
  try { for (const store of [f.memory.store, other]) {
    expect(store.currentKnowledge(f.path)).toEqual([]);
    expect(store.listSessionFacts(f.session.id)).toEqual([]);
    expect(store.pendingEntries(f.session.id, "main", f.turn.id)).toHaveLength(f.entries.length);
    expect(store.db.prepare("SELECT count(*) n FROM task_executions WHERE outcome='success'").get()).toMatchObject({ n: 0 });
    expect(store.db.prepare("SELECT count(*) n FROM task_executions WHERE outcome='failure'").get()).toMatchObject({ n: 1 });
    expect(store.db.prepare("SELECT count(*) n FROM knowledge_version_tags").get()).toMatchObject({ n: 0 });
  } } finally { other.close(); }
});

for (const structural of ["merge", "split"] as const)
  test(`04: legitimate D ${structural} descendants permit concurrency conversion`, async () => {
    const f = fixture(async () => {
      expect((await f.memory.dream(f.path)).outcome).toBe("success");
      return { noteInput: [fact("User refinement")], memoryInput: { ...knowledge(), op: "update", id: seed.tag } };
    }, task => {
      const current = f.memory.store.currentKnowledge(f.path).sort((a, b) => a.knowledge.id - b.knowledge.id);
      const tag = (index: number) => `K${current[index]!.knowledge.id}#${f.memory.store.versionTag(current[index]!.knowledge.id, current[index]!.revision.id)}`;
      const operation = structural === "merge"
        ? { op: "merge", id: tag(0), absorb: [tag(1)], text: "Merged rule", category: "constraint", scope: "session", topics: [], supports: [], reason: "combine" }
        : { op: "split", id: tag(0), text: "Primary part.", category: "constraint", scope: "project", topics: [], children: [{ title: "Fixture child", text: "First rule", category: "constraint", topics: [] }, { title: "Fixture child", text: "Second rule", category: "constraint", topics: [] }], supports: [], reason: "separate" };
      expect(call(task, "memory", operation)).not.toContain("rejected:");
      task.tools.find(tool => tool.name === "check")!.execute({});
    });
    const seed = seedKnowledge(f);
    if (structural === "merge") {
      const write = f.memory.tools({ kind: "manual", ...f.path, currentTurnId: f.turn.id }).find(tool => tool.name === "memory")!;
      expect(write.execute({ ...knowledge([`F${seed.fid}`]), text: "Related rule" })).not.toContain("rejected:");
    }
    expect(await f.run()).toMatchObject({ outcome: "success" });
    const current = f.memory.store.currentKnowledge(f.path);
    expect(current).toHaveLength(structural === "merge" ? 2 : 4); // a split keeps its item as the primary part beside two children
    expect(current.filter(item => item.revision.text.includes(seed.tag))).toHaveLength(1);
  });

test("04: a globally selected successor outside reader scope is not a conversion grant", async () => {
  let refused = "";
  const f = fixture(() => {
    const otherProject = f.memory.store.createProject({ name: "foreign", declaredBy: "mark" });
    const other = f.memory.store.createSession({ host: "pi:foreign", projectId: otherProject.id, enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
    const turn = f.memory.store.appendTurn({ sessionId: other.id, kind: "turn", userPrompt: "Foreign evidence", startedAt: "now" });
    const path = { sessionId: other.id, branch: "main", headTurnId: turn.id };
    const tools = f.memory.tools({ kind: "manual", ...path, currentTurnId: turn.id });
    const fid = JSON.parse(tools.find(tool => tool.name === "note")!.execute({ title: "Foreign evidence", sources: `[T${turn.id}#E1] Foreign evidence` })).factIds[0];
    const changed = commitNoterKnowledge(f.memory.store, { path, run: { sessionId: other.id, createdAt: "later" }, operations: [{
      op: "update", knowledgeId: seed.base.knowledgeId, baseCommit: seed.base.commit, text: "Foreign session-only rule", category: "constraint", scope: "session",
      topics: [], supports: [fid], reason: "narrow scope", createdAt: "later" }] });
    expect(changed.ok).toBe(true);
    return { noteInput: [fact()], memoryInput: { ...knowledge(), op: "update", id: seed.tag } };
  });
  const seed = seedKnowledge(f, "global");
  const result = await f.run();
  expect(result.outcome).toBe("failure");
  refused = "problems" in result ? (result.problems ?? []).join("\n") : "";
  expect(refused).toContain("K");
  expect(refused).not.toMatch(/K\d+@\d+(?!\d*v)/); // never a raw history address
  expect(refused).not.toContain("Foreign session-only rule");
  expect(f.memory.store.listSessionFacts(f.session.id)).toHaveLength(1); // only the seed fact
});

for (const kind of ["path", "project", "off", "cancel"] as const)
  test(`04: terminal ${kind} invalidation prevents publication`, async () => {
    const f = fixture(() => {
      if (kind === "path") f.memory.store.selectSourcePath(f.session.id, "main", []);
      if (kind === "project") {
        const other = f.memory.store.createProject({ name: "other", declaredBy: "mark" });
        f.memory.store.db.prepare("UPDATE sessions SET project_id=? WHERE id=?").run(other.id, f.session.id);
      }
      if (kind === "off") f.memory.store.setEnrollment(f.session.id, false);
      if (kind === "cancel") f.memory.cancelTasks();
      return { noteInput: [fact()], memoryInput: knowledge() };
    });
    const result = await f.run();
    expect(result.outcome).not.toBe("success");
    expect(f.memory.store.listSessionFacts(f.session.id)).toEqual([]);
    expect(f.memory.store.db.prepare("SELECT count(*) n FROM knowledge_revisions").get()).toMatchObject({ n: 0 });
    expect(noted(f)).toBe(false);
  });
