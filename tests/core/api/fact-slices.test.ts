import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceSeededMemory } from "../../source-fixture.ts";
import { Store } from "../../../src/core/store/index.ts";
import { DatabaseSync } from "node:sqlite";
import { renderFact, tokens } from "../../../src/core/render/index.ts";

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).reverse().forEach(fn => fn()));
function setup(worker?: (task: any) => void) {
  const dir = mkdtempSync(join(tmpdir(), "tm93-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, "db.sqlite");
  const memory = sourceSeededMemory(db, async raw => {
    const task = raw as any;
    task.reportRequest({ messages: [{ role: "user", content: "test" }] });
    worker?.(task);
    return { outcome: "success", output: "done", request: { messages: [{ role: "user", content: "test" }] } };
  });
  cleanup.push(() => memory.close());
  const project = memory.store.createProject({ name: "93", declaredBy: "mark" });
  const session = memory.store.createSession({ projectId: project.id, host: "pi:test", enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
  const turn = memory.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "opening", assistantText: "response", startedAt: "now" });
  const path = { sessionId: session.id, branch: "main", headTurnId: turn.id };
  const note = memory.tools({ kind: "manual", sessionId: session.id, branch: "main", currentTurnId: turn.id }).find(t => t.name === "note")!;
  return { db, memory, session, turn, path, note };
}
const f = (sources: { address: string; text: string }[], title = "A discussion") => ({ title, sources });

test("manual core sorts segments by native path, derives owner, cites roles and searches title/body", () => {
  const x = setup();
  const result = x.note.execute({ facts: [f([{ address: `T${x.turn.id}#E2@assistant`, text: "Pi agent responds" }, { address: `T${x.turn.id}#E1@user`, text: "User opens" }])] });
  expect(result).toContain("ok: F1");
  const fact = x.memory.store.getFact(1)!;
  expect(fact).toMatchObject({ title: "A discussion", source: [`T${x.turn.id}#E1@user`, `T${x.turn.id}#E2@assistant`], segments: ["User opens", "Pi agent responds"], text: "User opens\nPi agent responds", turnId: x.turn.id,
    roles: [{ role: "user" }, { role: "assistant", harness: "Pi agent" }] });
  const complete = renderFact(fact, []);
  expect(complete).toContain(`[T${x.turn.id}#E2@assistant] Pi agent responds`);
  expect(tokens(complete)).toBeGreaterThan(tokens(fact.text));
  expect(renderFact(fact, [], tokens(complete))).toBe(complete);
  expect(x.memory.store.searchAddresses("discussion", "facts")).toEqual(["F1"]);
  expect(x.memory.store.searchAddresses("responds", "facts")).toEqual(["F1"]);
  expect(x.memory.store.searchAddresses("@assistant", "facts")).toEqual([]);
});

test("branch reads retain every fact's ordered source segments", () => {
  const x = setup();
  const source = `T${x.turn.id}#E1`;
  expect(x.note.execute({ facts: Array.from({ length: 12 }, (_, i) => f([{ address: source, text: `episode ${i}` }])) })).toContain("ok: F12");
  const facts = x.memory.store.listBranchFacts(x.session.id, "main", x.turn.id);
  expect(facts.map(fact => ({ id: fact.id, source: fact.source, segments: fact.segments, text: fact.text })))
    .toEqual(Array.from({ length: 12 }, (_, i) => ({ id: i + 1, source: [source],
      segments: [`episode ${i}`], text: `episode ${i}` })));
});

test("public shape, duplicate entry, mismatched role and thinking are rejected", () => {
  const x = setup(), address = `T${x.turn.id}#E1`;
  for (const fact of [{ text: "old", source: [address] }, f([{ address, text: "x" }], "bad\nline"),
    f([{ address, text: "x" }, { address: `${address}@user`, text: "again" }]),
    f([{ address: `${address}@assistant`, text: "wrong role" }]),
    f([{ address: `${address}@thinking`, text: "wrong block" }]),
    { ...f([{ address, text: "x" }]), actor: "agent" }])
    expect(x.note.execute({ facts: [fact] })).toContain("rejected:");
  expect(x.memory.store.listSessionFacts(x.session.id)).toEqual([]);
});

test("N rejects assembled body above 1000 tokens while manual keeps exemption; held invalid replacement cannot publish", async () => {
  let first = "";
  const x = setup(task => {
    const note = task.tools.find((t: any) => t.name === "note")!;
    const address = `T${x.turn.id}#E1`;
    expect(note.execute({ facts: [f([{ address, text: "word ".repeat(1200) }])] })).toContain("exceeds 1000-token limit");
    first = note.execute({ facts: [f([{ address, text: "valid" }])] });
    expect(first).toContain("held: $1");
    expect(note.execute({ facts: [{ slot: "$1", ...f([{ address, text: "changed" }, { address: `${address}@user`, text: "duplicate" }]) }] })).toContain("rejected:");
    task.tools.find((t: any) => t.name === "memory")!.execute({ operations: [], skipped: [] });
  });
  expect((await x.memory.noting(x.path)).outcome).not.toBe("success");
  expect(x.memory.store.listSessionFacts(x.session.id)).toEqual([]);
  const big = "word ".repeat(1200);
  expect(tokens(big)).toBeGreaterThan(1000);
  expect(x.note.execute({ facts: [f([{ address: `T${x.turn.id}#E1`, text: big }])] })).toContain("ok: F1");
});

test("93 columns rollback with schema transaction after an actual later budget failure", () => {
  const x = setup();
  x.memory.store.close();
  const db = new DatabaseSync(x.db);
  db.exec("ALTER TABLE facts DROP COLUMN title; ALTER TABLE fact_sources DROP COLUMN segment_text");
  db.exec("UPDATE knowledge_budget_policy SET global_tokens=9007199254740991, project_tokens=1 WHERE id=1");
  db.close();
  expect(() => new Store(x.db)).toThrow(/stored Knowledge budget policy: derived applicable Knowledge capacity/);
  const after = new DatabaseSync(x.db);
  try {
    expect(after.prepare("PRAGMA table_info(facts)").all().some(row => row.name === "title")).toBe(false);
    expect(after.prepare("PRAGMA table_info(fact_sources)").all().some(row => row.name === "segment_text")).toBe(false);
  } finally { after.close(); }
});

test("normal N terminal publishes titled segments and marked Raw together", async () => {
  const x = setup(task => {
    const address = `T${x.turn.id}#E1`;
    expect(task.tools.find((t: any) => t.name === "note")!.execute({ facts: [f([{ address, text: "User opens" }])] })).toContain("held: $1");
    task.tools.find((t: any) => t.name === "memory")!.execute({ operations: [], skipped: [] });
  });
  expect((await x.memory.noting(x.path)).outcome).toBe("success");
  expect(x.memory.store.getFact(1)).toMatchObject({ title: "A discussion", segments: ["User opens"] });
  expect(x.memory.store.sourcePath(x.session.id, "main", x.turn.id).every(e => x.memory.store.entryNoted(e.id))).toBe(true);
});

test("post-fact noted-entry INSERT fault rolls back titled body and Raw progress", () => {
  const x = setup(), entry = x.memory.store.sourcePath(x.session.id, "main", x.turn.id)[0]!;
  const original = x.memory.store.db.prepare.bind(x.memory.store.db);
  x.memory.store.db.prepare = ((sql: string) => {
    if (sql.includes("INSERT INTO noted_entries")) throw new Error("injected noted-entry INSERT failure");
    return original(sql);
  }) as typeof x.memory.store.db.prepare;
  const result = x.memory.store.commitNotingRun({ run: { kind: "manual", sessionId: x.session.id, branch: "main", createdAt: "now" },
    entryIds: [entry.id], facts: [{ turnId: x.turn.id, createdAt: "now", title: "A discussion", segments: ["User opens"],
      text: "User opens", source: [`T${x.turn.id}#E1`], entryIds: [entry.id] }] });
  expect(result.ok).toBe(false);
  expect(x.memory.store.listSessionFacts(x.session.id)).toEqual([]);
  expect(x.memory.store.entryNoted(entry.id)).toBe(false);
});

test("nullable migration keeps historical rows unchanged and is idempotent", () => {
  const x = setup();
  const source = `T${x.turn.id}#E1`, id = x.memory.store.sourcePath(x.session.id, "main", x.turn.id)[0]!.id;
  expect(x.memory.store.commitNotingRun({ run: { kind: "manual", sessionId: x.session.id, branch: "main", createdAt: "now" }, facts: [
    { turnId: x.turn.id, text: "historical", source: [source], entryIds: [id], createdAt: "now" }] }).ok).toBe(true);
  x.memory.store.close();
  const legacy = new DatabaseSync(x.db);
  legacy.exec("ALTER TABLE facts DROP COLUMN title; ALTER TABLE fact_sources DROP COLUMN segment_text");
  legacy.close();
  const one = new Store(x.db); one.close();
  const two = new Store(x.db);
  try { expect(two.getFact(1)).toMatchObject({ text: "historical", source: [source] }); expect(two.getFact(1)!.title).toBeUndefined(); }
  finally { two.close(); }
});
