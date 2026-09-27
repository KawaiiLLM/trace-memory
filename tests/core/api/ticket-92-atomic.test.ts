import { commitNoterKnowledge } from "../../noting-knowledge-fixture.ts";
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceSeededMemory, type NotingAgentInput, type RunAgentResult } from "../../source-fixture.ts";
import { Store } from "../../../src/core/store/index.ts";
import { tokens } from "../../../src/core/render/index.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const request = { messages: [{ role: "user", content: "frozen task" }] };
function fixture(script: (task: NotingAgentInput) => Promise<Partial<RunAgentResult> | void> | Partial<RunAgentResult> | void) {
  const dir = mkdtempSync(join(tmpdir(), "tm-92-held-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "memory.sqlite");
  const memory = sourceSeededMemory(file, async raw => {
    const task = raw as NotingAgentInput;
    task.reportRequest(request);
    const result = await script(task);
    return { outcome: "success", output: "done", request, ...result };
  }, { dreaming: { triggerTokens: 1 } });
  cleanup.push(() => memory.close());
  const project = memory.store.createProject({ name: "atomic", declaredBy: "mark" });
  const session = memory.store.createSession({ projectId: project.id, host: "pi:atomic", enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
  const turn = memory.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "User set the rule", assistantText: "Pi agent explained it", startedAt: "now" });
  const entries = memory.store.sourcePath(session.id, "main", turn.id);
  const path = { sessionId: session.id, branch: "main", headTurnId: turn.id };
  return { memory, file, session, turn, entries, path, run: () => memory.noting(path) };
}
const call = (task: NotingAgentInput, name: "note" | "memory", input: unknown) => task.tools.find(tool => tool.name === name)!.execute(input);
const fact = (text = "User set the rule", source = "T1#E1") => ({ title: "Rule evidence", sources: [{ address: source, text }] });
const knowledge = (supports = ["$1"]) => ({ op: "create", text: "Use the stated rule", category: "constraint", scope: "session", supports, reason: "new rule", topics: [] });
const emptyMemory = (task: NotingAgentInput) => call(task, "memory", { operations: [], skipped: [] });

test("04: nine facts, only rejected ninth corrected; two layers stay private until normal terminal", async () => {
  const f = fixture(task => {
    const other = new Store(f.file); try {
      const receipt = call(task, "note", { facts: [...Array.from({ length: 8 }, (_, i) => fact(`Episode ${i}`)), fact("ninth", "T1#E99")] });
      expect(receipt).toContain("held: $8"); expect(receipt).toContain("rejected: $9");
      expect(call(task, "note", { facts: [{ slot: "$9", ...fact("corrected ninth") }] })).toContain("held: $9");
      expect(call(task, "memory", { operations: [knowledge(["$1", "$9"])], skipped: [] })).toContain("held: M1");
      expect(other.listSessionFacts(f.session.id)).toEqual([]);
      expect(other.currentKnowledge(f.path)).toEqual([]);
      expect(f.entries.some(entry => other.entryNoted(entry.id))).toBe(false);
    } finally { other.close(); }
  });
  expect(await f.run()).toMatchObject({ outcome: "success" });
  expect(f.memory.store.listSessionFacts(f.session.id)).toHaveLength(9);
  expect(f.memory.store.currentKnowledge(f.path)[0]!.revision.supports).toEqual([1, 9]);
  expect(f.entries.every(entry => f.memory.store.entryNoted(entry.id))).toBe(true);
});

test.each([false, true])("92: block-source replacement cannot publish; whole-entry correction recovers (%s)", async recover => {
  const f = fixture(task => {
    call(task, "note", { facts: [fact()] });
    expect(call(task, "note", { facts: [{ slot: "$1", ...fact("selected block", "T1#E2@text") }] })).toContain("rejected:");
    call(task, "note", { facts: [] });
    if (recover) expect(call(task, "note", { facts: [{ slot: "$1", ...fact("Pi agent corrected it", "T1#E2") }] })).toContain("held: $1");
    emptyMemory(task);
  });
  expect((await f.run()).outcome).toBe(recover ? "success" : "bounced");
  const facts = f.memory.store.listSessionFacts(f.session.id);
  expect(facts).toHaveLength(recover ? 1 : 0);
  if (recover) expect(facts[0]!.roles).toEqual([{ role: "assistant", harness: "Pi agent" }]);
  expect(f.entries.every(entry => f.memory.store.entryNoted(entry.id))).toBe(recover);
});

test("04: another connection allocates the next F ID while drafts exist; final mapping uses actual IDs", async () => {
  const f = fixture(task => {
    call(task, "note", { facts: [fact("held fact")] });
    call(task, "memory", { operations: [knowledge()], skipped: [] });
    const other = new Store(f.file);
    try {
      const inserted = other.commitNotingRun({ run: { kind: "manual", sessionId: f.session.id, branch: "main", createdAt: "now" },
        facts: [{ turnId: f.turn.id, text: "Concurrent manual fact", source: ["T1#E1"], entryIds: [f.entries[0]!.id], createdAt: "now" }] });
      expect(inserted).toMatchObject({ ok: true, facts: [{ id: 1 }] });
    } finally { other.close(); }
  });
  expect((await f.run()).outcome).toBe("success");
  expect(f.memory.store.currentKnowledge(f.path)[0]!.revision.supports).toEqual([2]);
  expect(f.memory.store.getFact(2)!.text).toBe("held fact");
});

test("04: repeated edits, gaps, structured mapping and source correction", async () => {
  const f = fixture(task => {
    call(task, "note", { facts: [fact("first"), fact("drop"), fact("third")] });
    call(task, "note", { facts: [], drop: ["$2"] });
    call(task, "memory", { operations: [{ ...knowledge(["$3"]), text: "Literal $3 stays text" }], skipped: [] });
    call(task, "note", { facts: [{ slot: "$3", ...fact("Pi agent's corrected final explanation", "T1#E2"), support: [["$1", "strong"]] }] });
    call(task, "note", { facts: [fact("fourth") ] });
    expect(call(task, "note", { facts: [], drop: ["$3"] })).toContain("cannot drop referenced");
    call(task, "note", { facts: [] }); // clears the top-level failed drop, not any slot rejection
  });
  expect(await f.run()).toMatchObject({ outcome: "success" });
  const facts = f.memory.store.listSessionFacts(f.session.id).sort((a,b) => a.id-b.id);
  expect(facts).toHaveLength(3);
  expect(facts[1]!.roles).toEqual([{ role: "assistant", harness: "Pi agent" }]);
  expect(f.memory.store.currentKnowledge(f.path)[0]!.revision.supports).toEqual([facts[1]!.id]);
  expect(f.memory.store.currentKnowledge(f.path)[0]!.revision.text).toBe("Literal $3 stays text");
  expect(f.memory.store.listFactRelations(facts[1]!.id)[0]).toMatchObject({ toFact: facts[0]!.id });
});

for (const failure of ["slot", "top", "knowledge", "missing note", "missing memory", "provider", "cancel"])
  test(`04: ${failure} never publishes accepted siblings or processing`, async () => {
    const f = fixture(task => {
      if (failure !== "missing note") call(task, "note", { facts: [fact()] });
      if (failure !== "missing memory") emptyMemory(task);
      if (failure === "slot") { call(task, "note", { facts: [{ slot: "$1", ...fact("invalid", "T1#E99") }] }); call(task, "note", { facts: [] }); }
      if (failure === "top") call(task, "note", { facts: "wrong" });
      if (failure === "knowledge") { call(task, "memory", { operations: [knowledge(["$99"])], skipped: [] }); emptyMemory(task); }
      if (failure === "provider") return { outcome: "failure", output: "late stream error", usage: { input: 7 } };
      if (failure === "cancel") return { outcome: "cancelled", output: "cancelled" };
    });
    expect((await f.run()).outcome).not.toBe("success");
    expect(f.memory.store.listSessionFacts(f.session.id)).toEqual([]);
    expect(f.memory.store.currentKnowledge(f.path)).toEqual([]);
    expect(f.entries.some(entry => f.memory.store.entryNoted(entry.id))).toBe(false);
  });

for (const kind of ["note", "memory"] as const) test(`04: explicit empties recover ${kind} top-level errors without targets`, async () => {
  const f = fixture(task => {
    call(task, kind, { bad: true }); call(task, "note", { facts: [] }); emptyMemory(task);
  });
  expect((await f.run()).outcome).toBe("success");
  expect(f.entries.every(entry => f.memory.store.entryNoted(entry.id))).toBe(true);
});

for (const table of ["facts", "knowledge_revisions", "noted_entries"])
  test(`04: rollback after ${table} insertion leaves both layers and progress absent`, async () => {
    const f = fixture(task => {
      call(task, "note", { facts: [fact()] }); call(task, "memory", { operations: [knowledge()], skipped: [] });
      f.memory.store.db.exec(`CREATE TEMP TRIGGER fail_atomic AFTER INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'injected ${table}'); END`);
    });
    const result = await f.run();
    expect(result).toMatchObject({ outcome: "failure", problems: [expect.stringContaining(`injected ${table}`)] });
    expect(f.memory.store.listSessionFacts(f.session.id)).toEqual([]);
    expect(f.memory.store.currentKnowledge(f.path)).toEqual([]);
    expect(f.memory.pendingEntries(f.session.id, "main", f.turn.id)).toHaveLength(f.entries.length);
    expect(f.memory.store.db.prepare("SELECT count(*) n FROM runs WHERE outcome='success'").get()).toMatchObject({ n: 0 });
  });

test("04: shared schema does not grant manual draft semantics or remove within-call relation handles", () => {
  const f = fixture(() => {});
  const tools = f.memory.tools({ kind: "manual", ...f.path, currentTurnId: f.turn.id });
  const note = tools.find(tool => tool.name === "note")!, memory = tools.find(tool => tool.name === "memory")!;
  const written = JSON.parse(note.execute({ facts: [fact("first"), { ...fact("second"), support: [["$1", "strong"]] }] }));
  expect(written.factIds).toEqual([1, 2]);
  expect(f.memory.store.listFactRelations(2)[0]).toMatchObject({ toFact: 1 });
  for (const input of [{ facts: [{ slot: "$1", ...fact("must not replace") }] }, { facts: [], drop: [] }])
    expect(note.execute(input)).toContain("N-only");
  for (const input of [
    { operations: [knowledge()], skipped: [] },
    { operations: [{ ...knowledge(["F1"]), slot: "M1" }], skipped: [] },
    { operations: [], skipped: [], drop: [] },
  ]) expect(memory.execute(input)).toContain("N-only");
  expect(f.memory.store.listSessionFacts(f.session.id)).toHaveLength(2);
  expect(f.memory.store.currentKnowledge(f.path)).toEqual([]);
  expect(memory.execute({ operations: [knowledge(["F1"])], skipped: [] })).toContain("committed");
  expect(f.memory.store.currentKnowledge(f.path)).toHaveLength(1);
  expect(f.entries.some(entry => f.memory.store.entryNoted(entry.id))).toBe(false);
});

test("04: duplicate native refusal IDs allocate one rejected append slot; empties expose it without clearing", async () => {
  const f = fixture(task => {
    call(task, "note", { facts: [fact()] });
    for (let i = 0; i < 2; i++) task.reportToolRejection("same-native-id", "note", { facts: [{ source: ["T1#E1"] }] }, "missing text");
    const inspected = JSON.parse(call(task, "note", { facts: [] }));
    expect(inspected.rejected).toEqual({ "$2": "missing text" });
    call(task, "note", { facts: [{ slot: "$2", ...fact("corrected") }, fact("appended") ] });
    emptyMemory(task);
  });
  expect((await f.run()).outcome).toBe("success");
  expect(f.memory.store.listSessionFacts(f.session.id)).toHaveLength(3);
});

for (const kind of ["note", "memory"] as const)
  for (const defect of ["unexpected", "drop", ...(kind === "memory" ? ["skipped"] : [])])
    for (const native of [false, true]) for (const recovery of ["empty", "replace", "drop"] as const)
      test(`04: ${kind} top-level ${defect}, native=${native}, recovery=${recovery}`, async () => {
        const f = fixture(task => {
          call(task, "note", { facts: [fact("original one"), fact("original two"), fact("sibling")] });
          call(task, "memory", { operations: kind === "memory" ? [knowledge(), knowledge(), { ...knowledge(), text: "sibling" }] : [], skipped: [] });
          const prefix = kind === "note" ? "$" : "M";
          const field = kind === "note" ? "facts" : "operations";
          const value = (text: string) => kind === "note" ? fact(text) : { ...knowledge(), text };
          const base = kind === "note" ? {} : { skipped: [] };
          const refused = { ...base, [field]: [...[1, 2].map(id => ({ slot: `${prefix}${id}`, ...value("refused") })), value("refused append")],
            [defect]: defect === "unexpected" ? true : defect === "drop" ? [42] : [{ fact: "F1", because: "not allowed in N" }] };
          if (native) for (let i = 0; i < 2; i++) task.reportToolRejection("same-envelope", kind, refused, "native refusal");
          else expect(call(task, kind, refused)).toContain("rejected:");
          const inspected = JSON.parse(call(task, kind, { ...base, [field]: [] }));
          expect(inspected.held).toEqual([`${prefix}3`]);
          expect(Object.keys(inspected.rejected)).toEqual([`${prefix}1`, `${prefix}2`]);
          if (recovery === "replace") {
            expect(call(task, kind, { ...base, [field]: [1, 2].map(id => ({ slot: `${prefix}${id}`, ...value(`corrected ${id}`) })) })).toContain(`held: ${prefix}2`);
          } else if (recovery === "drop") {
            expect(call(task, kind, { ...base, [field]: [], drop: [`${prefix}1`, `${prefix}2`] })).toContain(`dropped: ${prefix}2`);
          }
          if (recovery !== "empty") {
            // A repeated host callback after correction/drop must not reapply the refusal.
            if (native) task.reportToolRejection("same-envelope", kind, refused, "native refusal");
            const appended = JSON.parse(call(task, kind, { ...base, [field]: [value("appended")] }));
            expect(appended.results).toContain(`held: ${prefix}4`);
            expect(appended.rejected).toEqual({});
          }
        });
        expect((await f.run()).outcome).toBe(recovery === "empty" ? "bounced" : "success");
        const texts = kind === "note" ? f.memory.store.listSessionFacts(f.session.id).map(row => row.text)
          : f.memory.store.currentKnowledge(f.path).map(row => row.revision.text);
        expect(texts.sort()).toEqual(recovery === "empty" ? [] : recovery === "replace"
          ? ["appended", "corrected 1", "corrected 2", "sibling"] : ["appended", "sibling"]);
        expect(f.entries.some(entry => f.memory.store.entryNoted(entry.id))).toBe(recovery !== "empty");
      });

function seedKnowledge(f: ReturnType<typeof fixture>, scope: "session" | "project" | "global" = "session") {
  const note = f.memory.tools({ kind: "manual", ...f.path, currentTurnId: f.turn.id }).find(tool => tool.name === "note")!;
  const fid = JSON.parse(note.execute({ facts: [fact("User supplied enduring evidence")] })).factIds[0] as number;
  const content = { text: "Old rule", category: "constraint" as const, scope, topics: [], supports: [fid], reason: "initial", createdAt: "now" };
  const created = f.memory.store.commitConsolidationRun({ path: f.path, run: { kind: "manual", sessionId: f.session.id, createdAt: "now" },
    operations: [{ op: "create", author: "test", handle: "$seed", ...content }] });
  if (!created.ok) throw new Error(created.problems.join("; "));
  const base = created.committed[0]!;
  const tag = `K${base.knowledgeId}#${f.memory.store.versionTag(base.knowledgeId, base.commit)}`;
  const advance = (archive = false) => {
    const other = new Store(f.file);
    try {
      const result = commitNoterKnowledge(other, { path: f.path, run: { sessionId: f.session.id, createdAt: "later" },
        operations: [archive ? { op: "archive", knowledgeId: base.knowledgeId, baseCommit: base.commit, supports: [fid], reason: "retired", createdAt: "later" }
          : { op: "update", knowledgeId: base.knowledgeId, baseCommit: base.commit, ...content, text: "Concurrent rule" }] });
      if (!result.ok) throw new Error(result.problems.join("; "));
    } finally { other.close(); }
  };
  return { fid, base, tag, advance };
}

for (const when of ["before staging", "before publication"]) for (const op of ["update", "archive"] as const)
  test(`04: concurrent ${op} ${when} preserves original intent and audits conversion`, async () => {
    const f = fixture(task => {
      call(task, "note", { facts: [fact("User changed the rule")] });
      if (when === "before staging") seed.advance();
      const operation = op === "update" ? { ...knowledge([`F${seed.fid}`, "$1"]), op, id: seed.tag, text: "Requested rule" }
        : { op, id: seed.tag, supports: [`F${seed.fid}`, "$1"], reason: "remove rule" };
      expect(call(task, "memory", { operations: [operation], skipped: [] })).toContain("held: M1");
      if (when === "before publication") seed.advance();
    });
    const seed = seedKnowledge(f);
    const result = await f.run(); expect(result).toMatchObject({ outcome: "success" });
    const current = f.memory.store.currentKnowledge(f.path);
    expect(current).toHaveLength(op === "update" ? 2 : 1);
    expect(current.find(item => item.knowledge.id === seed.base.knowledgeId)!.revision.text).toBe("Concurrent rule");
    if (op === "update") {
      const created = current.find(item => item.knowledge.id !== seed.base.knowledgeId)!;
      expect(created.revision.text).toContain(seed.tag);
      expect(created.revision.supports).toHaveLength(2);
      expect(f.memory.store.pendingVersions(`session:${f.session.id}`, f.path).some(item => item.revisionId === created.revision.id)).toBe(true);
    }
    if (!("runId" in result)) throw new Error("missing run");
    const audit = JSON.parse(f.memory.store.getRun(result.runId!)!.response!);
    expect(audit.held.operations[0].original.id).toBe(seed.tag);
    expect(audit.knowledgeOperations[0].requested.op).toBe(op);
    expect(audit.knowledgeOperations[0].applied?.op ?? null).toBe(op === "update" ? "create" : null);
  });

for (const when of ["stage", "terminal"] as const) test(`04: final conflict annotation obeys the 1000-token cap at ${when}`, async () => {
  let body = "";
  while (tokens(`${body}x `) <= 1000) body += "x ";
  expect(tokens(body)).toBe(1000);
  const f = fixture(task => {
    call(task, "note", { facts: [fact("Refinement")] });
    if (when === "stage") seed.advance();
    const receipt = call(task, "memory", { operations: [{ ...knowledge(), op: "update", id: seed.tag, text: body }], skipped: [] });
    expect(receipt).toContain(when === "stage" ? "exceeds 1000-token limit" : "held: M1");
    if (when === "terminal") seed.advance();
  });
  const seed = seedKnowledge(f);
  const result = await f.run();
  expect(result).toMatchObject({ outcome: when === "stage" ? "bounced" : "failure", problems: [expect.stringContaining("exceeds 1000-token limit")] });
  expect(f.memory.store.listSessionFacts(f.session.id)).toHaveLength(1);
  expect(f.memory.store.currentKnowledge(f.path)).toHaveLength(1);
  expect(f.entries.some(entry => f.memory.store.entryNoted(entry.id))).toBe(false);
});

test("04: stale archive still validates local sources after replacement", async () => {
  const f = fixture(task => {
    call(task, "note", { facts: [fact()] }); seed.advance();
    expect(call(task, "memory", { operations: [{ op: "archive", id: seed.tag, supports: ["$1"], reason: "remove" }], skipped: [] })).toContain("held: M1");
    expect(call(task, "note", { facts: [{ slot: "$1", ...fact("invalid", "T1#E99") }] })).toContain("rejected:");
    emptyMemory(task);
  });
  const seed = seedKnowledge(f);
  expect((await f.run()).outcome).toBe("bounced");
  expect(f.memory.store.listSessionFacts(f.session.id)).toHaveLength(1);
  expect(f.entries.some(entry => f.memory.store.entryNoted(entry.id))).toBe(false);
});

test("04: stale archive no-op revalidates mapped evidence scope after another owner moves", async () => {
  const f = fixture(task => {
    call(task, "note", { facts: [fact("Archive evidence")] });
    seed.advance();
    expect(call(task, "memory", { operations: [{ op: "archive", id: seed.tag, supports: ["$1", `F${foreignFact}`], reason: "remove" }], skipped: [] })).toContain("held: M1");
    const other = f.memory.store.createProject({ name: "moved", declaredBy: "mark" });
    f.memory.store.db.prepare("UPDATE sessions SET project_id=? WHERE id=?").run(other.id, foreign.id);
  });
  const seed = seedKnowledge(f, "project");
  const foreign = f.memory.store.createSession({ host: "pi:foreign", projectId: f.session.projectId, enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
  const turn = f.memory.store.appendTurn({ sessionId: foreign.id, kind: "turn", userPrompt: "Supporting evidence", startedAt: "now" });
  const note = f.memory.tools({ kind: "manual", sessionId: foreign.id, branch: "main", currentTurnId: turn.id }).find(tool => tool.name === "note")!;
  const foreignFact = JSON.parse(note.execute({ facts: [{ title: "Supporting evidence", sources: [{ address: `T${turn.id}#E1`, text: "Supporting evidence" }] }] })).factIds[0];
  const result = await f.run();
  expect(result).toMatchObject({ outcome: "failure", problems: [expect.stringContaining("not an available fact for project scope")] });
  expect(f.memory.store.listSessionFacts(f.session.id)).toHaveLength(1);
  expect(f.entries.some(entry => f.memory.store.entryNoted(entry.id))).toBe(false);
});

test("04: archived descendant is a legitimate advance, unknown tag and bad evidence never convert", async () => {
  const f = fixture(task => {
    call(task, "note", { facts: [fact()] }); seed.advance(true);
    expect(call(task, "memory", { operations: [{ ...knowledge(), op: "update", id: seed.tag }], skipped: [] })).toContain("held: M1");
    expect(call(task, "memory", { operations: [{ ...knowledge(["F999"]), op: "update", id: seed.tag }], skipped: [] })).toContain("rejected: M2");
    expect(call(task, "memory", { operations: [{ ...knowledge(), op: "update", id: "K1#zzzzzzzz" }], skipped: [] })).toContain("rejected: M3");
    expect(call(task, "memory", { operations: [], skipped: [], drop: ["M2", "M3"] })).not.toContain("rejected:");
  });
  const seed = seedKnowledge(f);
  expect(await f.run()).toMatchObject({ outcome: "success" });
  expect(f.memory.store.currentKnowledge(f.path)).toHaveLength(1);
  expect(f.memory.store.currentKnowledge(f.path)[0]!.revision.text).toContain(seed.tag);
});

test("04: converted new identity is reconciled by ordinary D merge without a special queue", async () => {
  const f = fixture(task => {
    if ((task as { kind: string }).kind === "dreaming") {
      const current = f.memory.store.currentKnowledge(f.path).sort((a,b) => a.knowledge.id-b.knowledge.id);
      expect(current).toHaveLength(2);
      const address = (index: number) => `K${current[index]!.knowledge.id}#${f.memory.store.versionTag(current[index]!.knowledge.id, current[index]!.revision.id)}`;
      expect(call(task, "memory", { operations: [{ op: "merge", id: address(0), absorb: [address(1)], text: "Resolved rule",
        category: "constraint", scope: "session", topics: [], supports: [], reason: "Reconciled concurrent proposal with current evidence" }], skipped: [] })).not.toContain("rejected:");
      task.tools.find(tool => tool.name === "check")!.execute({});
      return;
    }
    call(task, "note", { facts: [fact("User supplied a refinement")] });
    seed.advance();
    call(task, "memory", { operations: [{ ...knowledge(), op: "update", id: seed.tag }], skipped: [] });
  });
  const seed = seedKnowledge(f);
  expect((await f.run()).outcome).toBe("success");
  expect(f.memory.store.listRuns(f.session.id).filter(run => run.kind === "dreaming")).toEqual([]);
  expect((await f.memory.dream(f.path)).outcome).toBe("success");
  expect(f.memory.store.currentKnowledge(f.path)).toHaveLength(1);
  expect(f.memory.store.currentKnowledge(f.path)[0]!.revision.text).toBe("Resolved rule");
});

test("04: failure after execution-success update rolls back warmed views and every business write", async () => {
  const f = fixture(task => {
    // Warm both read-side paths before entering the outer business transaction.
    expect(f.memory.store.currentKnowledge(f.path)).toEqual([]);
    expect(f.memory.pendingEntries(f.session.id, "main", f.turn.id)).toHaveLength(f.entries.length);
    call(task, "note", { facts: [fact()] }); call(task, "memory", { operations: [knowledge()], skipped: [] });
    f.memory.store.db.exec(`CREATE TEMP TRIGGER fail_success AFTER UPDATE OF outcome ON task_executions
      WHEN NEW.outcome='success' BEGIN SELECT RAISE(ABORT, 'injected execution success'); END`);
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
    const f = fixture(async task => {
      if ((task as { kind: string }).kind === "dreaming") {
        const current = f.memory.store.currentKnowledge(f.path).sort((a,b) => a.knowledge.id-b.knowledge.id);
        const tag = (index: number) => `K${current[index]!.knowledge.id}#${f.memory.store.versionTag(current[index]!.knowledge.id, current[index]!.revision.id)}`;
        const operation = structural === "merge"
          ? { op: "merge", id: tag(0), absorb: [tag(1)], text: "Merged rule", category: "constraint", scope: "session", topics: [], supports: [], reason: "combine" }
          : { op: "split", id: tag(0), children: [{ text: "First rule", category: "constraint", topics: [] }, { text: "Second rule", category: "constraint", topics: [] }], supports: [], reason: "separate" };
        expect(call(task, "memory", { operations: [operation], skipped: [] })).not.toContain("rejected:");
        task.tools.find(tool => tool.name === "check")!.execute({});
        return;
      }
      call(task, "note", { facts: [fact("User refinement")] });
      expect((await f.memory.dream(f.path)).outcome).toBe("success");
      expect(call(task, "memory", { operations: [{ ...knowledge(), op: "update", id: seed.tag }], skipped: [] })).toContain("held: M1");
    });
    const seed = seedKnowledge(f);
    if (structural === "merge") {
      const write = f.memory.tools({ kind: "manual", ...f.path, currentTurnId: f.turn.id }).find(tool => tool.name === "memory")!;
      expect(write.execute({ operations: [{ ...knowledge([`F${seed.fid}`]), text: "Related rule" }], skipped: [] })).not.toContain("rejected:");
    }
    expect(await f.run()).toMatchObject({ outcome: "success" });
    const current = f.memory.store.currentKnowledge(f.path);
    expect(current).toHaveLength(structural === "merge" ? 2 : 3);
    expect(current.filter(item => item.revision.text.includes(seed.tag))).toHaveLength(1);
  });

test("04: a globally selected successor outside reader scope is not a conversion grant", async () => {
  const f = fixture(task => {
    call(task, "note", { facts: [fact()] });
    const otherProject = f.memory.store.createProject({ name: "foreign", declaredBy: "mark" });
    const other = f.memory.store.createSession({ host: "pi:foreign", projectId: otherProject.id, enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
    const turn = f.memory.store.appendTurn({ sessionId: other.id, kind: "turn", userPrompt: "Foreign evidence", startedAt: "now" });
    const path = { sessionId: other.id, branch: "main", headTurnId: turn.id };
    const tools = f.memory.tools({ kind: "manual", ...path, currentTurnId: turn.id });
    const fid = JSON.parse(tools.find(tool => tool.name === "note")!.execute({ facts: [{ title: "Foreign evidence", sources: [{ address: `T${turn.id}#E1`, text: "Foreign evidence" }] }] })).factIds[0];
    const changed = commitNoterKnowledge(f.memory.store, { path, run: { sessionId: other.id, createdAt: "later" }, operations: [{
      op: "update", knowledgeId: seed.base.knowledgeId, baseCommit: seed.base.commit, text: "Foreign session-only rule", category: "constraint", scope: "session",
      topics: [], supports: [fid], reason: "narrow scope", createdAt: "later" }] });
    expect(changed.ok).toBe(true);
    const receipt = call(task, "memory", { operations: [{ ...knowledge(), op: "update", id: seed.tag }], skipped: [] });
    expect(receipt).toContain("rejected: M1");
    expect(receipt).not.toMatch(/K\d+@\d+/);
    expect(receipt).not.toContain("Foreign session-only rule");
  });
  const seed = seedKnowledge(f, "global");
  expect((await f.run()).outcome).toBe("bounced");
  expect(f.memory.store.listSessionFacts(f.session.id)).toHaveLength(1);
});

for (const kind of ["path", "project", "off", "cancel"] as const)
  test(`04: terminal ${kind} invalidation prevents publication`, async () => {
    const f = fixture(task => {
      call(task, "note", { facts: [fact()] }); call(task, "memory", { operations: [knowledge()], skipped: [] });
      if (kind === "path") f.memory.store.selectSourcePath(f.session.id, "main", []);
      if (kind === "project") {
        const other = f.memory.store.createProject({ name: "other", declaredBy: "mark" });
        f.memory.store.db.prepare("UPDATE sessions SET project_id=? WHERE id=?").run(other.id, f.session.id);
      }
      if (kind === "off") f.memory.store.setEnrollment(f.session.id, false);
      if (kind === "cancel") f.memory.cancelTasks();
    });
    const result = await f.run();
    expect(result.outcome).not.toBe("success");
    expect(f.memory.store.listSessionFacts(f.session.id)).toEqual([]);
    expect(f.memory.store.db.prepare("SELECT count(*) n FROM knowledge_revisions").get()).toMatchObject({ n: 0 });
    expect(f.entries.some(entry => f.memory.store.entryNoted(entry.id))).toBe(false);
  });
