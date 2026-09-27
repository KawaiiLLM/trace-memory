import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sourceSeededMemory } from "../../source-fixture.ts";
import { commitNoterKnowledge } from "../../noting-knowledge-fixture.ts";
import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import { tokens } from "../../../src/core/render/index.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("92/03: a tagged exact base works without trace, unknown tags fail, revisions retain ordinal across reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "tm-92-tags-")); dirs.push(dir);
  const file = join(dir, "memory.sqlite");
  const open = () => sourceSeededMemory(file, async () => ({ outcome: "failure" as const, output: "not invoked" }));
  const memory = open();
  const project = memory.store.createProject({ name: "tag-test", declaredBy: "mark" });
  const session = memory.store.createSession({ projectId: project.id, host: "pi:test", startedAt: "now", firstReplyAt: "now", enrollmentChoice: true });
  const turn = memory.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "remember", assistantText: "", startedAt: "now" });
  const context = { kind: "manual" as const, sessionId: session.id, currentTurnId: turn.id, branch: "main" };
  const note = memory.tools(context).find(tool => tool.name === "note")!;
  const fact = JSON.parse(note.execute({ facts: [{ title: "Preserve a rule", sources: [{ address: `T${turn.id}#E1`, text: "User wants to preserve a rule" }] }] })).factIds[0];
  const create = memory.tools(context).find(tool => tool.name === "memory")!;
  const createdReceipt = create.execute({ operations: [{ op: "create", text: "First rule", category: "constraint", scope: "session", topics: [], reason: "initial", supports: [`F${fact}`] }], skipped: [] });
  if (createdReceipt.startsWith("rejected:")) throw new Error(createdReceipt);
  const created = JSON.parse(createdReceipt);
  expect(created.committed).toHaveLength(1);
  const { knowledgeId, version } = created.committed[0];
  expect(created.committed[0]).not.toHaveProperty("commit");
  expect(version).toBe(`K${knowledgeId}@v1`);
  expect(createdReceipt).not.toMatch(/K\d+#[a-z]+/);
  const commit = memory.store.resolveVersionOrdinal(knowledgeId, 1);
  const tag = memory.store.versionTag(knowledgeId, commit);
  expect(tag).toMatch(/^[a-z]{4,}$/);
  expect(memory.store.versionOrdinal(knowledgeId, commit)).toBe(1);
  expect(memory.store.resolveVersionTag(knowledgeId, tag)).toBe(commit);
  const trace = memory.tools(context).find(tool => tool.name === "trace")!;
  const read = trace.execute({ address: `K${knowledgeId}@v1`, pageBudget: 2000 });
  expect(read).toContain(`[K${knowledgeId}#${tag}]`);
  expect(read).not.toContain(`K${knowledgeId}@${commit}`);
  const first = trace.execute({ address: `K${knowledgeId}@v1`, pageBudget: 65 });
  expect(first).toContain("cursor=");
  expect(first).not.toContain(`#${tag}`);
  const pages = [first];
  let cursor = /cursor=([0-9a-f-]+)/.exec(first)?.[1];
  while (cursor) {
    const next = trace.execute({ address: `cursor=${cursor}` });
    pages.push(next);
    cursor = /cursor=([0-9a-f-]+)/.exec(next)?.[1];
    if (pages.length > 20) throw new Error("nonterminating knowledge pagination");
  }
  expect(pages.at(-1)).toContain(`version K${knowledgeId}#${tag}`);
  expect(pages.slice(0, -1).join("\n")).not.toContain(`#${tag}`);
  expect(pages.join("\n").match(new RegExp(`K${knowledgeId}#${tag}`, "g"))).toHaveLength(1);
  const second = JSON.parse(memory.tools(context).find(tool => tool.name === "memory")!.execute({ operations: [
    { op: "create", text: "Second rule: " + "long body segment ".repeat(90), category: "reference", scope: "session", topics: [], reason: "second", supports: [`F${fact}`] }], skipped: [] }));
  const secondId = second.committed[0].knowledgeId;
  const secondVersion = `K${secondId}#${memory.store.versionTag(secondId, memory.store.resolveVersionOrdinal(secondId, 1))}`;
  const both = trace.execute({ address: `K${knowledgeId}@v1,K${second.committed[0].knowledgeId}@v1`, pageBudget: 125 });
  expect(both).toContain(`[K${knowledgeId}#${tag}]`);
  expect(both).not.toContain(secondVersion);
  let nextCursor = /cursor=([0-9a-f-]+)/.exec(both)?.[1];
  const allPages = [both];
  while (nextCursor) {
    const next = trace.execute({ address: `cursor=${nextCursor}` });
    allPages.push(next);
    nextCursor = /cursor=([0-9a-f-]+)/.exec(next)?.[1];
    if (allPages.length > 80) throw new Error("nonterminating multi-K pagination");
  }
  expect(allPages.join("\n").match(new RegExp(secondVersion, "g"))).toHaveLength(1);
  expect(allPages.at(-1)).toContain(secondVersion);
  expect(() => memory.store.resolveVersionTag(knowledgeId, tag.slice(0, 3))).toThrow();
  expect(memory.tools(context).find(tool => tool.name === "memory")!.execute({ operations: [
    { op: "archive", id: `K${knowledgeId}#xxxx`, reason: "bad", supports: [`F${fact}`] }], skipped: [] })).toContain("rejected:");
  const otherConnection = open();
  const archived = JSON.parse(otherConnection.tools(context).find(tool => tool.name === "memory")!.execute({ operations: [
    { op: "archive", id: `K${knowledgeId}#${tag}`, reason: "retired", supports: [`F${fact}`] }], skipped: [] }));
  expect(archived.committed).toHaveLength(1);
  expect(archived.committed[0]).not.toHaveProperty("commit");
  const next = memory.store.resolveVersionOrdinal(knowledgeId, Number(archived.committed[0].version.split("@v")[1]));
  expect(memory.store.versionOrdinal(knowledgeId, next)).toBe(2);
  expect(memory.store.versionTag(knowledgeId, next)).not.toBe(tag);
  otherConnection.close();
  memory.close();
  const reopened = open();
  try {
    expect(reopened.store.resolveVersionTag(knowledgeId, tag)).toBe(commit);
    expect(reopened.store.resolveVersionOrdinal(knowledgeId, 2)).toBe(next);
  } finally { reopened.close(); }
});

test("92/03: complete-body tags survive collection and history paging without leaking into partial bodies", () => {
  const memory = sourceSeededMemory(":memory:", async () => ({ outcome: "failure" as const, output: "unused" }));
  try {
    const project = memory.store.createProject({ name: "paged-project", declaredBy: "mark" });
    const session = memory.store.createSession({ projectId: project.id, host: "pi:paging", startedAt: "now", firstReplyAt: "now", enrollmentChoice: true });
    const turn = memory.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "evidence", assistantText: "", startedAt: "now" });
    const context = { kind: "manual" as const, sessionId: session.id, currentTurnId: turn.id, branch: "main" };
    const tools = memory.tools(context);
    const fact = JSON.parse(tools.find(t => t.name === "note")!.execute({ facts: [{ title: "A paging example", sources: [{ address: `T${turn.id}#E1`, text: "A paging example" }] }] })).factIds[0];
    const body = "长行😀 Mixed body. ".repeat(60);
    const receipt = JSON.parse(tools.find(t => t.name === "memory")!.execute({ operations: [{ op: "create", text: body,
      category: "reference", scope: "project", topics: [], reason: "created", supports: [`F${fact}`] }], skipped: [] }));
    const { knowledgeId } = receipt.committed[0];
    const version = `K${knowledgeId}#${memory.store.versionTag(knowledgeId, memory.store.resolveVersionOrdinal(knowledgeId, 1))}`;
    const trace = tools.find(t => t.name === "trace")!;
    const collect = (address: string, extra: object, tool = trace) => {
      const pages = [tool.execute({ address, itemBudget: null, ...extra })];
      let cursor: string | undefined;
      while ((cursor = /cursor=([0-9a-f-]+)/.exec(pages.at(-1)!)?.[1])) {
        pages.push(tool.execute({ address: `cursor=${cursor}` }));
        if (pages.length > 100) throw new Error("pagination did not terminate");
      }
      expect(pages.every(page => !page.startsWith("rejected:"))).toBe(true);
      return pages;
    };
    for (const address of [`K${knowledgeId}`, project.name]) {
      const pages = collect(address, { pageBudget: 130 });
      const taggedIndex = pages.findIndex(page => page.includes(version));
      expect(taggedIndex).toBeGreaterThan(0);
      expect(pages.slice(0, taggedIndex).join("\n")).not.toContain(version);
      expect(pages.join("\n").split(version)).toHaveLength(2);
      expect(pages.every(page => tokens(page) <= 130)).toBe(true);
      expect(pages.join("\n")).not.toMatch(/K\d+@\d+/);
    }
    const humanPage = memory.trace(`K${knowledgeId}@v1`, {
      sessionId: session.id, branch: "main", headTurnId: turn.id, itemBudget: null, pageBudget: 130 });
    const humanCursor = /cursor=([0-9a-f-]+)/.exec(humanPage)![1];
    expect(trace.execute({ address: `cursor=${humanCursor}` })).toContain("another presentation surface");
    expect(trace.execute({ address: `K${knowledgeId}`, modelFacing: false })).toContain("rejected:");
    const limitedTrace = memory.tools({ ...context, maxReadChars: 600 }).find(t => t.name === "trace")!;
    const charPages = collect(`K${knowledgeId}`, { pageBudget: 8000, versions: "all" }, limitedTrace);
    expect(charPages.every(page => page.length <= 600)).toBe(true);
    expect(charPages.slice(0, -1).join("\n")).not.toContain(version);
    expect(charPages.at(-1)).toContain(version);
    const capPages = collect(`K${knowledgeId}@v1`, { cap: 1, pageBudget: 8000 });
    expect(capPages.slice(0, -1).join("\n")).not.toContain(version);
    expect(capPages.at(-1)).toContain(version);
    const full = trace.execute({ address: `K${knowledgeId}@v1`, itemBudget: null, pageBudget: 8000 });
    for (let budget = tokens(full); budget < tokens(full) + 8; budget++) {
      const pages = collect(`K${knowledgeId}@v1`, { pageBudget: budget });
      expect(pages).toHaveLength(1);
      expect(pages[0]).toContain(`[${version}]`);
    }
    for (const extra of [{ fields: ["supports"] }, { itemBudget: 60 }]) {
      expect(trace.execute({ address: `K${knowledgeId}`, ...extra })).not.toContain(version);
      expect(trace.execute({ address: project.name, ...extra })).not.toContain(version);
    }
    expect(tools.find(t => t.name === "search")!.execute({ query: "Mixed body", layer: "knowledge", itemBudget: null })).not.toContain(version);
    // A queued collection body retains its original identity even if version metadata is
    // changed outside the supported writer while its cursor is live.
    const first = trace.execute({ address: project.name, itemBudget: null, pageBudget: 130 });
    memory.store.db.prepare("UPDATE knowledge_version_tags SET tag='zzzzzz' WHERE knowledge_id=?").run(knowledgeId);
    const rest: string[] = [];
    let cursor = /cursor=([0-9a-f-]+)/.exec(first)?.[1];
    while (cursor) {
      const page = trace.execute({ address: `cursor=${cursor}` }); rest.push(page);
      cursor = /cursor=([0-9a-f-]+)/.exec(page)?.[1];
    }
    expect(rest.join("\n")).toContain(version);
    expect(rest.join("\n")).not.toContain("#zzzzzz");
  } finally { memory.close(); }
});

test("92/03+04: concurrent N writers serialize version metadata and convert a stale update; failed manual batches roll back", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tm-92-tag-writers-")); dirs.push(dir);
  const file = join(dir, "memory.sqlite");
  const memory = sourceSeededMemory(file, async () => ({ outcome: "failure" as const, output: "unused" }));
  const workers: Worker[] = [];
  try {
    const project = memory.store.createProject({ name: "writers", declaredBy: "mark" });
    const session = memory.store.createSession({ projectId: project.id, host: "pi:writers", startedAt: "now", firstReplyAt: "now", enrollmentChoice: true });
    const turn = memory.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "rule", startedAt: "now" });
    const fact = JSON.parse(memory.tools({ kind: "manual", sessionId: session.id, currentTurnId: turn.id, branch: "main" }).find(t => t.name === "note")!
      .execute({ facts: [{ title: "Rule evidence", sources: [{ address: `T${turn.id}#E1`, text: "Rule evidence" }] }] })).factIds[0];
    const content = { text: "Unchanged body", category: "constraint" as const, scope: "session" as const, topics: [], supports: [fact], reason: "revision", createdAt: "now" };
    const run = { kind: "manual" as const, sessionId: session.id, branch: "main", createdAt: "now" };
    const created = memory.store.commitConsolidationRun({ run, operations: [{ op: "create", handle: "$1", author: "test", ...content }] });
    if (!created.ok) throw new Error(created.problems.join("; "));
    const initial = created.committed[0]!;
    const operation = { op: "update", knowledgeId: initial.knowledgeId, baseCommit: initial.commit, ...content };
    const starts = [1, 2].map(() => {
      const worker = new Worker(`const { parentPort, workerData } = require('node:worker_threads');
        Promise.all([import(workerData.module), import(workerData.fixture)]).then(([{ Store }, { commitNoterKnowledge }]) => {
          const store = new Store(workerData.file);
          parentPort.once('message', () => {
            try { parentPort.postMessage(commitNoterKnowledge(store, {run: workerData.run, operations:[workerData.operation]})); }
            finally { store.close(); parentPort.close(); }
          });
          parentPort.postMessage('ready');
        });`, { eval: true, workerData: { file, run, operation,
          module: new URL("../../../src/core/store/index.ts", import.meta.url).href,
          fixture: new URL("../../noting-knowledge-fixture.ts", import.meta.url).href } });
      workers.push(worker);
      let ready!: () => void;
      const opened = new Promise<void>(resolve => { ready = resolve; });
      const done = new Promise<{ ok: boolean }>((resolve, reject) => {
        worker.on("message", value => value === "ready" ? ready() : resolve(value));
        worker.on("error", reject);
      });
      return { opened, done, worker };
    });
    await Promise.all(starts.map(value => value.opened));
    starts.forEach(value => value.worker.postMessage("write"));
    const results = await Promise.all(starts.map(value => value.done));
    // N's second stale update is a new identity, never a second effective successor.
    expect(results.map(value => value.ok)).toEqual([true, true]);
    const history = memory.store.listKnowledgeRevisions(initial.knowledgeId);
    expect(history).toHaveLength(2);
    expect(history.map(value => value.text)).toEqual([content.text, content.text]);
    const converted = memory.store.listKnowledgeRevisions().filter(value => value.knowledgeId !== initial.knowledgeId);
    expect(converted).toHaveLength(1);
    expect(converted[0]!.op).toBe("create");
    expect(converted[0]!.text).toContain(`originally targeted K${initial.knowledgeId}#${memory.store.versionTag(initial.knowledgeId, initial.commit)}`);
    const metadata = () => memory.store.db.prepare("SELECT * FROM knowledge_version_tags ORDER BY commit_id").all();
    const before = metadata();
    expect(before.filter(row => row.knowledge_id === initial.knowledgeId).map(row => row.ordinal)).toEqual([1, 2]);
    expect(before.filter(row => row.knowledge_id !== initial.knowledgeId).map(row => row.ordinal)).toEqual([1]);
    expect(new Set(before.filter(row => row.knowledge_id === initial.knowledgeId).map(row => row.tag)).size).toBe(2);
    const failed = memory.store.commitConsolidationRun({ run, operations: [
      { op: "create", handle: "$rollback", author: "test", ...content },
      { op: "archive", knowledgeId: initial.knowledgeId, baseCommit: initial.commit, supports: [fact], reason: "stale after insert", createdAt: "now" },
    ] });
    expect(failed.ok).toBe(false);
    expect(metadata()).toEqual(before);
    expect(memory.store.listKnowledgeRevisions()).toHaveLength(3);
    const metadataOnly = commitNoterKnowledge(memory.store, { run, operations: [{ ...operation, op: "update", baseCommit: history[1]!.id, topics: ["new-topic"] }] });
    expect(metadataOnly.ok).toBe(true);
    const originalMetadata = metadata().filter(row => row.knowledge_id === initial.knowledgeId);
    expect(originalMetadata.map(row => row.ordinal)).toEqual([1, 2, 3]);
    expect(new Set(originalMetadata.map(row => row.tag)).size).toBe(3);
  } finally {
    await Promise.all(workers.map(worker => worker.terminate()));
    memory.close();
  }
});

test("92/03: an existing collision stays stable; only the later version extends, and no reopen repairs missing metadata", () => {
  const dir = mkdtempSync(join(tmpdir(), "tm-92-tags-collision-")); dirs.push(dir);
  const file = join(dir, "memory.sqlite");
  const open = () => sourceSeededMemory(file, async () => ({ outcome: "failure" as const, output: "not invoked" }));
  const memory = open();
  const project = memory.store.createProject({ name: "collision", declaredBy: "mark" });
  const session = memory.store.createSession({ projectId: project.id, host: "pi:test", startedAt: "now", firstReplyAt: "now", enrollmentChoice: true });
  const turn = memory.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "remember", assistantText: "", startedAt: "now" });
  const context = { kind: "manual" as const, sessionId: session.id, currentTurnId: turn.id, branch: "main" };
  const note = memory.tools(context).find(tool => tool.name === "note")!;
  const fact = JSON.parse(note.execute({ facts: [{ title: "Archive a rule", sources: [{ address: `T${turn.id}#E1`, text: "Keep an archived rule" }] }] })).factIds[0];
  const created = JSON.parse(memory.tools(context).find(tool => tool.name === "memory")!.execute({ operations: [
    { op: "create", text: "An initial body", category: "constraint", scope: "session", topics: [], reason: "initial", supports: [`F${fact}`] }], skipped: [] }));
  const { knowledgeId, version } = created.committed[0];
  const commit = memory.store.resolveVersionOrdinal(knowledgeId, Number(version.split("@v")[1]));
  const expectedNext = commit + 1;
  let value = BigInt(`0x${createHash("sha256").update(`trace-knowledge-version:${knowledgeId}:${expectedNext}`).digest("hex")}`);
  let sequence = "";
  while (value > 0n) { sequence = String.fromCharCode(97 + Number(value % 26n)) + sequence; value /= 26n; }
  const occupiedTag = sequence.padStart(55, "a").slice(0, 4);
  // Force a real unique-index collision; don't monkeypatch the production tag generator.
  memory.store.db.prepare("UPDATE knowledge_version_tags SET tag = ? WHERE knowledge_id = ? AND commit_id = ?")
    .run(occupiedTag, knowledgeId, commit);
  const result = JSON.parse(memory.tools(context).find(tool => tool.name === "memory")!.execute({ operations: [
    { op: "archive", id: `K${knowledgeId}#${occupiedTag}`, reason: "archive", supports: [`F${fact}`] }], skipped: [] }));
  const later = memory.store.resolveVersionOrdinal(knowledgeId, Number(result.committed[0].version.split("@v")[1]));
  expect(memory.store.versionTag(knowledgeId, commit)).toBe(occupiedTag);
  expect(memory.store.versionTag(knowledgeId, later)).toBe(sequence.padStart(55, "a").slice(0, 5));
  expect(() => memory.store.resolveVersionTag(knowledgeId, occupiedTag.slice(0, 3))).toThrow();
  memory.store.db.prepare("DELETE FROM knowledge_version_tags WHERE commit_id = ?").run(later);
  memory.close();
  const reopened = open();
  try {
    expect(() => reopened.store.versionTag(knowledgeId, later)).toThrow("unknown knowledge version");
    expect(reopened.store.versionTag(knowledgeId, commit)).toBe(occupiedTag);
  } finally { reopened.close(); }
});
