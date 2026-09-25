import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../../src/core/store/index.ts";

const dirs: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) if (!store.closed) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});
const time = "2026-09-24T00:00:00Z";
function pair() {
  const dir = mkdtempSync(join(tmpdir(), "tm-80-signal-"));
  dirs.push(dir);
  const file = join(dir, "trace.db");
  const writer = new Store(file), reader = new Store(file);
  stores.push(writer, reader);
  const project = writer.createProject({ name: "shared", declaredBy: "mark" });
  const sessionId = writer.createSession({ host: "test", enrollmentChoice: true, projectId: project.id,
    startedAt: time, firstReplyAt: time }).id;
  const turnId = writer.appendTurn({ sessionId, kind: "turn", userPrompt: "hi", startedAt: time }).id;
  const entry = writer.appendSourceEntry({ sessionId, turnId, nativeLineage: "native", nativeId: "u1",
    role: "user", text: "hello", raw: "hello", calls: [] });
  writer.selectSourcePath(sessionId, "main", [entry.id]);
  return { writer, reader, sessionId, turnId, entry };
}

test("first cursor publication invalidates a previously built graph and footer signal", () => {
  const { writer, reader, sessionId, turnId } = pair();
  const other = writer.appendTurn({ sessionId, kind: "turn", userPrompt: "sibling", startedAt: time });
  const otherEntry = writer.appendSourceEntry({ sessionId, turnId: other.id, nativeLineage: "native", nativeId: "u2",
    role: "user", text: "sibling", raw: "sibling", calls: [] });
  writer.selectSourcePath(sessionId, "sibling", [otherEntry.id]);
  const noted = writer.commitNotingRun({ run: { kind: "noting", sessionId, createdAt: time }, entryIds: [otherEntry.id],
    facts: [{ turnId: other.id, entryIds: [otherEntry.id], category: "observation", actor: "user", text: "sibling evidence",
      source: [`T${other.id}#E1`], createdAt: time }] });
  if (!noted.ok) throw new Error(noted.problems.join("; "));
  const created = writer.commitConsolidationRun({ path: { sessionId, branch: "sibling", headTurnId: other.id },
    run: { kind: "manual", sessionId, branch: "sibling", createdAt: time }, operations: [{ op: "create", handle: "$k",
      author: "test", text: "knowledge supported only on sibling", category: "constraint", scope: "global",
      supports: [noted.facts[0]!.id], topics: [], reason: "direct evidence", createdAt: time }] });
  if (!created.ok) throw new Error(created.problems.join("; "));
  const path = { sessionId, branch: "main", headTurnId: turnId };
  const before = reader.progressSignal(sessionId);
  expect(reader.currentKnowledge(path).map(value => value.revision.id)).toEqual([created.committed[0]!.commit]);
  writer.setCurrentPath(sessionId, "main", turnId, "native");
  expect(reader.progressSignal(sessionId)).not.toBe(before);
  expect(reader.currentKnowledge(path)).toEqual([]);
  const after = reader.progressSignal(sessionId);
  writer.setCurrentPath(sessionId, "main", turnId, "other-lineage");
  expect(reader.progressSignal(sessionId)).not.toBe(after);
  const republished = reader.progressSignal(sessionId);
  writer.setCurrentPath(sessionId, "main", turnId, "other-lineage");
  expect(reader.progressSignal(sessionId)).toBe(republished);
});

test("a second connection's empty Noting commit changes the signal and pending membership", () => {
  const { writer, reader, sessionId, turnId, entry } = pair();
  writer.setCurrentPath(sessionId, "main", turnId, "native");
  const before = reader.progressSignal(sessionId);
  expect(reader.pendingEntryIds(sessionId, "main", turnId)).toEqual([entry.id]);
  const result = writer.commitNotingRun({ run: { kind: "noting", sessionId, createdAt: time },
    entryIds: [entry.id], facts: [] });
  expect(result.ok).toBe(true);
  expect(reader.progressSignal(sessionId)).not.toBe(before);
  expect(reader.pendingEntryIds(sessionId, "main", turnId)).toEqual([]);
});

test("a prepared snapshot supplied by one reader never replaces the memo's foreground membership", () => {
  const { writer, sessionId, turnId, entry } = pair();
  writer.setCurrentPath(sessionId, "main", turnId, "native");
  const noted = writer.commitNotingRun({ run: { kind: "noting", sessionId, createdAt: time }, entryIds: [entry.id],
    facts: [{ turnId, entryIds: [entry.id], category: "observation", actor: "user", text: "evidence",
      source: [`T${turnId}#E1`], createdAt: time }] });
  if (!noted.ok) throw new Error(noted.problems.join("; "));
  const path = { sessionId, branch: "main", headTurnId: turnId };
  const created = writer.commitConsolidationRun({ path, run: { kind: "manual", sessionId, branch: "main", createdAt: time },
    operations: [{ op: "create", handle: "$k", author: "test", text: "stable global knowledge",
      category: "constraint", scope: "global", supports: [noted.facts[0]!.id], topics: [],
      reason: "direct evidence", createdAt: time }] });
  if (!created.ok) throw new Error(created.problems.join("; "));
  const first = writer.currentKnowledge(path).map(value => value.revision.id);
  expect(first).toEqual([created.committed[0]!.commit]);
  const supplied = writer.pathSnapshot(path);
  supplied.turns = new Set();
  writer.commitGraph(path, undefined, supplied, writer.commitGraphInput(undefined, sessionId));
  expect(writer.currentKnowledge(path).map(value => value.revision.id)).toEqual(first);
});

test("a graph read inside a transaction cannot install an uncommitted result in the memo", () => {
  const { writer, sessionId, turnId } = pair();
  writer.setCurrentPath(sessionId, "main", turnId, "native");
  const path = { sessionId, branch: "main", headTurnId: turnId };
  writer.currentKnowledge(path);
  const original = writer.db.prepare.bind(writer.db);
  let builds = 0;
  writer.db.prepare = ((sql: string) => {
    if (/SELECT \* FROM knowledge_revisions ORDER BY id/.test(sql)) builds++;
    return original(sql);
  }) as typeof writer.db.prepare;
  const before = writer.currentKnowledge(path);
  expect(() => writer.transaction(() => {
    const other = writer.appendTurn({ sessionId, kind: "turn", userPrompt: "temporary", startedAt: time });
    const entry = writer.appendSourceEntry({ sessionId, turnId: other.id, nativeLineage: "native", nativeId: "rolled-back",
      role: "user", text: "temporary", raw: "temporary", calls: [] });
    writer.commitNotingRun({ run: { kind: "noting", sessionId, createdAt: time }, entryIds: [entry.id], facts: [] });
    writer.currentKnowledge(path);
    throw new Error("rollback");
  })).toThrow("rollback");
  expect(builds).toBeGreaterThanOrEqual(1);
  const after = builds;
  expect(writer.currentKnowledge(path)).toEqual(before);
  expect(builds).toBe(after);
});
