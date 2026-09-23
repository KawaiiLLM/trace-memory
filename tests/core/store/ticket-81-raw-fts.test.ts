import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store, unicodeLength } from "../../../src/core/store/index.ts";

function recordSql() {
  const sql: string[] = [];
  const prepare = DatabaseSync.prototype.prepare;
  vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function(this: DatabaseSync, statement: string) {
    sql.push(statement); return prepare.call(this, statement);
  });
  return sql;
}

// Ticket 81: Raw search's candidate index -- raw_fts (FTS5, trigram tokenizer, contentless) plus
// raw_search_entries (the rowid -> session/turn/tool-call/field map a contentless table cannot store
// itself). These tests pin the semantics that make the two-step search safe: the candidate step may
// over-collect (superset), but the literal LIKE re-check trims back to exactly today's hits.

const dirs: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tm-81-raw-fts-")); dirs.push(dir);
  const path = join(dir, "test.sqlite"), store = new Store(path); stores.push(store);
  const project = store.createProject({ name: "ticket-81", declaredBy: "mark" });
  const session = store.createSession({ projectId: project.id, host: "test", startedAt: "time", firstReplyAt: "time", enrollmentChoice: true });
  return { path, store, session };
}

test("81: the candidate step is a superset of LIKE -- a Unicode case-fold pair candidates but the re-check still excludes it, as LIKE would today", () => {
  const f = fixture();
  const t = f.store.appendTurn({ sessionId: f.session.id, kind: "turn", startedAt: "time", assistantText: "École de Paris" });
  // The candidate step alone (raw_fts MATCH) finds it: the default trigram tokenizer case-folds
  // Unicode, so "éco" candidates against "École" even though the letters differ only by an accented
  // capital's case.
  const candidateRow = f.store.db.prepare(`SELECT e.turn_id AS turnId FROM raw_search_entries e
    JOIN raw_fts ON raw_fts.rowid = e.id WHERE raw_fts MATCH '"éco"'`).get() as { turnId: number } | undefined;
  expect(candidateRow?.turnId).toBe(t.id);
  // But today's search() -- LIKE only folds ASCII case -- does not find it, and the two-step pipeline
  // must reproduce that exactly, not the broader candidate set.
  expect(f.store.searchAddresses("éco", "raw")).toEqual([]);
  // A genuine ASCII case-insensitive hit still passes the re-check (the ordinary, unremarkable case).
  const u = f.store.appendTurn({ sessionId: f.session.id, kind: "turn", startedAt: "time", assistantText: "ABC upper case" });
  expect(f.store.searchAddresses("abc", "raw")).toEqual([`T${u.id}`]);
});

test("81: a query matching only across two fields (end of prompt, start of reply) is not a hit", () => {
  const f = fixture();
  f.store.appendTurn({ sessionId: f.session.id, kind: "turn", startedAt: "time", userPrompt: "please AB", assistantText: "CD now" });
  expect(f.store.searchAddresses("ABCD", "raw")).toEqual([]);
  // Sanity: each half alone is still findable on its own field.
  const t = f.store.getTurn(1)!;
  expect(f.store.searchAddresses("please AB", "raw")).toEqual([`T${t.id}`]);
  expect(f.store.searchAddresses("CD now", "raw")).toEqual([`T${t.id}`]);
});

test("81: several matching tool calls of one Turn collapse to that Turn once", () => {
  const f = fixture();
  const t = f.store.appendTurn({ sessionId: f.session.id, kind: "turn", startedAt: "time" });
  f.store.appendToolCall({ turnId: t.id, name: "Bash", input: "needle one", status: "success" });
  f.store.appendToolCall({ turnId: t.id, name: "Bash", input: "needle two", status: "success" });
  f.store.appendToolCall({ turnId: t.id, name: "Bash", result: "needle three", status: "success" });
  expect(f.store.searchAddresses("needle", "raw")).toEqual([`T${t.id}`]);
});

test("81: queries under three Unicode characters (ASCII and CJK) keep today's LIKE path and find exactly today's hits", () => {
  const f = fixture();
  expect(unicodeLength("a")).toBe(1); expect(unicodeLength("琴")).toBe(1); expect(unicodeLength("美琴")).toBe(2);
  const ascii = f.store.appendTurn({ sessionId: f.session.id, kind: "turn", startedAt: "time", assistantText: "x a y" });
  expect(f.store.searchAddresses("a", "raw")).toEqual([`T${ascii.id}`]); // 1 char: below the trigram floor
  const cjk = f.store.appendTurn({ sessionId: f.session.id, kind: "turn", startedAt: "time", assistantText: "御坂美琴的电击" });
  expect(f.store.searchAddresses("美琴", "raw")).toEqual([`T${cjk.id}`]); // 2-char CJK word: still below 3
  expect(f.store.searchAddresses("美琴的", "raw")).toEqual([`T${cjk.id}`]); // 3-char: now the trigram path
});

test("81: a rolled-back write leaves raw_fts and raw_search_entries unchanged", () => {
  const f = fixture();
  const t = f.store.appendTurn({ sessionId: f.session.id, kind: "turn", startedAt: "time" });
  const before = f.store.db.prepare("SELECT COUNT(*) AS n FROM raw_search_entries").get() as { n: number };
  expect(() => f.store.transaction(() => {
    f.store.appendToolCall({ turnId: t.id, name: "Bash", input: "unfindable needle", status: "success" });
    throw new Error("forced rollback");
  })).toThrow("forced rollback");
  expect(f.store.searchAddresses("unfindable needle", "raw")).toEqual([]);
  const after = f.store.db.prepare("SELECT COUNT(*) AS n FROM raw_search_entries").get() as { n: number };
  expect(after.n).toBe(before.n);
  expect(f.store.db.prepare("SELECT COUNT(*) AS n FROM raw_fts").get()).toEqual({ n: before.n });
});

test("81: a Turn whose reply grows and a tool call whose result arrives later are each findable immediately after their own commit", () => {
  const f = fixture();
  const t = f.store.appendTurn({ sessionId: f.session.id, kind: "turn", startedAt: "time" });
  expect(f.store.searchAddresses("growing reply", "raw")).toEqual([]);
  f.store.updateTurn(t.id, { assistantText: "first part" });
  expect(f.store.searchAddresses("growing reply", "raw")).toEqual([]);
  f.store.updateTurn(t.id, { assistantText: "first part, then growing reply text" });
  expect(f.store.searchAddresses("growing reply", "raw")).toEqual([`T${t.id}`]);
  const call = f.store.appendToolCall({ turnId: t.id, name: "Bash", status: "attempted" });
  expect(f.store.searchAddresses("late result text", "raw")).toEqual([]);
  f.store.completeToolCall(t.id, call.ordinal, "late result text arrives", "success");
  expect(f.store.searchAddresses("late result text", "raw")).toEqual([`T${t.id}`]);
});

test("81: a second connection's committed write is findable immediately, without reopening this connection", () => {
  const f = fixture();
  const t = f.store.appendTurn({ sessionId: f.session.id, kind: "turn", startedAt: "time" });
  const other = new Store(f.path); stores.push(other);
  other.appendToolCall({ turnId: t.id, name: "Bash", input: "cross connection needle", status: "success" });
  expect(f.store.searchAddresses("cross connection needle", "raw")).toEqual([`T${t.id}`]);
});

test("81: a pre-81 database builds the index once on upgrade; a second open does no indexing work", () => {
  const f = fixture();
  let store = f.store;
  const t = store.appendTurn({ sessionId: f.session.id, kind: "turn", startedAt: "time", userPrompt: "pre-migration prompt", assistantText: "pre-migration reply" });
  store.appendToolCall({ turnId: t.id, name: "Bash", input: "pre-migration input", result: "pre-migration result", status: "success" });
  // Simulate a database that predates ticket 81 entirely: the index writers above already ran (they
  // are unconditional), so dropping the tables afterward reproduces "never had this index" cleanly.
  store.db.exec("DROP TABLE raw_fts; DROP TABLE raw_search_entries;");
  store.close();

  store = new Store(f.path); stores.push(store);
  expect(store.searchAddresses("pre-migration prompt", "raw")).toEqual([`T${t.id}`]);
  expect(store.searchAddresses("pre-migration reply", "raw")).toEqual([`T${t.id}`]);
  expect(store.searchAddresses("pre-migration input", "raw")).toEqual([`T${t.id}`]);
  expect(store.searchAddresses("pre-migration result", "raw")).toEqual([`T${t.id}`]);
  store.close(); stores.pop();

  const sql = recordSql();
  const reopened = new Store(f.path); stores.push(reopened);
  expect(sql.some(statement => statement.includes("INSERT INTO raw_search_entries") || statement.includes("INSERT INTO raw_fts"))).toBe(false);
  expect(reopened.searchAddresses("pre-migration prompt", "raw")).toEqual([`T${t.id}`]); // still intact, not rebuilt
});
