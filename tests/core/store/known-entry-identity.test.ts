import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, sourceDigest, type SourceInput } from "../../../src/core/store/index.ts";
import { countSourceReads } from "../../perf/fixture.ts";

// Ticket 74: a known entry's identity (digest, Turn, call identities) is answered without loading its
// content/blocks (8.1 KB/4.2 KB on average) — the digest replaces a full Raw comparison, and the compact
// source_entry_calls table replaces listSourceEntries()'s Turn-wide load, while 22b's guarantee that a
// changed entry under a known identity is still caught keeps holding.

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tm-known-entry-")); dirs.push(dir);
  const path = join(dir, "test.sqlite"), store = new Store(path);
  const project = store.createProject({ name: "known-entry", declaredBy: "mark" });
  const session = store.createSession({ projectId: project.id, host: "test", startedAt: "time", firstReplyAt: "time", enrollmentChoice: true });
  const turn = store.appendTurn({ sessionId: session.id, kind: "turn", startedAt: "time" });
  return { path, store, session, turn };
}

test("74: a new entry's digest and call identities are written in the same transaction as the entry", () => {
  const f = fixture();
  try {
    const raw = JSON.stringify({ role: "assistant", content: "answer", calls: ["c1", "c2"] });
    const input: SourceInput = { sessionId: f.session.id, turnId: f.turn.id, nativeLineage: "native", nativeId: "a1",
      role: "assistant", text: "answer", raw, calls: [
        { callId: "call-1", ordinal: 1, name: "bash", input: "{}", result: "result bytes", status: "success" },
        { callId: "call-2", ordinal: 2, name: "grep", input: "{}", status: "attempted" }] };
    const entry = f.store.appendSourceEntry(input);
    const row = f.store.db.prepare("SELECT digest FROM source_entries WHERE id = ?").get(entry.id) as { digest: string };
    expect(row.digest).toBe(sourceDigest(raw));
    const calls = f.store.db.prepare("SELECT entry_id, turn_id, call_id, ordinal, name FROM source_entry_calls WHERE entry_id = ? ORDER BY id").all(entry.id);
    expect(calls).toEqual([
      { entry_id: entry.id, turn_id: f.turn.id, call_id: "call-1", ordinal: 1, name: "bash" },
      { entry_id: entry.id, turn_id: f.turn.id, call_id: "call-2", ordinal: 2, name: "grep" }]);
  } finally { f.store.close(); }
});

test("74: findKnownSourceEntry answers identity and call identities without input/result/status", () => {
  const f = fixture();
  try {
    const raw = JSON.stringify({ role: "assistant", content: "answer" });
    const entry = f.store.appendSourceEntry({ sessionId: f.session.id, turnId: f.turn.id, nativeLineage: "native", nativeId: "a1",
      role: "assistant", text: "answer", raw, calls: [{ callId: "call-1", ordinal: 1, name: "bash", input: "secret input", result: "secret result", status: "success" }] });
    const known = f.store.findKnownSourceEntry(f.session.id, "native", "a1");
    expect(known).toEqual({ id: entry.id, turnId: f.turn.id, digest: sourceDigest(raw), calls: [{ ordinal: 1, name: "bash", callId: "call-1" }] });
    expect(f.store.findKnownSourceEntry(f.session.id, "native", "missing")).toBeNull();
    expect(f.store.turnCallIdentities(f.turn.id)).toEqual([{ ordinal: 1, name: "bash", callId: "call-1" }]);
  } finally { f.store.close(); }
});

test("74: known-entry identity and Turn call-identity reads never load content or blocks (EXPLAIN QUERY PLAN)", () => {
  const f = fixture();
  try {
    f.store.appendSourceEntry({ sessionId: f.session.id, turnId: f.turn.id, nativeLineage: "native", nativeId: "a1",
      role: "assistant", text: "answer", raw: "{}", calls: [{ callId: "call-1", ordinal: 1, name: "bash", status: "attempted" }] });
    const prepare = vi.spyOn(f.store.db, "prepare");
    const counter = countSourceReads();
    expect(f.store.findKnownSourceEntry(f.session.id, "native", "a1")).not.toBeNull();
    expect(f.store.turnCallIdentities(f.turn.id)).toHaveLength(1);
    expect(counter.reads()).toBe(0); // neither read loaded/parsed a Raw row
    counter.restore();
    // 79: 74's covering idx_source_identity is retired (item 0) -- the row it dodged (content/blocks)
    // no longer lives on this table, so the implicit unique index over
    // (session_id, native_lineage, native_id) answers this lookup at no extra cost.
    const identityQuery = prepare.mock.calls.map(([sql]) => sql).find(sql => sql.includes("FROM source_entries") && sql.includes("native_lineage"))!;
    prepare.mockRestore();
    const identityPlan = f.store.db.prepare(`EXPLAIN QUERY PLAN ${identityQuery}`).all(f.session.id, "native", "a1");
    expect(identityPlan.map(row => String(row.detail)).join("\n")).toMatch(/SEARCH source_entries USING (COVERING )?INDEX sqlite_autoindex_source_entries_\d/);
    const entryCallsPlan = f.store.db.prepare("EXPLAIN QUERY PLAN SELECT call_id, ordinal, name FROM source_entry_calls WHERE entry_id = ? ORDER BY id").all(1);
    expect(entryCallsPlan.map(row => String(row.detail)).join("\n")).toContain("idx_source_entry_calls_entry");
    const turnCallsPlan = f.store.db.prepare("EXPLAIN QUERY PLAN SELECT call_id, ordinal, name FROM source_entry_calls WHERE turn_id = ? ORDER BY id").all(f.turn.id);
    expect(turnCallsPlan.map(row => String(row.detail)).join("\n")).toContain("idx_source_entry_calls_turn");
  } finally { f.store.close(); }
});

test("74: a persisted entry changed under a known identity is still reported by digest comparison", () => {
  const f = fixture();
  try {
    const raw = JSON.stringify({ role: "user", content: "original" });
    f.store.appendSourceEntry({ sessionId: f.session.id, turnId: f.turn.id, nativeLineage: "native", nativeId: "u1",
      role: "user", text: "original", raw, calls: [] });
    const known = f.store.findKnownSourceEntry(f.session.id, "native", "u1")!;
    expect(known.digest).toBe(sourceDigest(raw));
    expect(known.digest).not.toBe(sourceDigest(JSON.stringify({ role: "user", content: "tampered" })));
    // A checkpoint from another lineage is a different identity entirely: it simply is not found.
    expect(f.store.findKnownSourceEntry(f.session.id, "another-lineage", "u1")).toBeNull();
  } finally { f.store.close(); }
});

test("74: the digest and call-identity backfill covers every pre-existing entry, and its digest equals sourceDigest of the stored Raw", () => {
  const f = fixture();
  let store = f.store;
  try {
    const raws: Record<string, string> = {
      a1: JSON.stringify({ role: "assistant", content: "first answer" }),
      a2: JSON.stringify({ role: "assistant", content: "second answer" }),
      u1: JSON.stringify({ role: "user", content: "a question" }),
    };
    const a1 = store.appendSourceEntry({ sessionId: f.session.id, turnId: f.turn.id, nativeLineage: "native", nativeId: "a1",
      role: "assistant", text: "first answer", raw: raws.a1!, calls: [{ callId: "call-1", ordinal: 1, name: "bash", status: "success" }] });
    const a2 = store.appendSourceEntry({ sessionId: f.session.id, turnId: f.turn.id, nativeLineage: "native", nativeId: "a2",
      role: "assistant", text: "second answer", raw: raws.a2!, calls: [{ callId: "call-2", ordinal: 2, name: "grep", status: "attempted" }] });
    const u1 = store.appendSourceEntry({ sessionId: f.session.id, turnId: f.turn.id, nativeLineage: "native", nativeId: "u1",
      role: "user", text: "a question", raw: raws.u1!, calls: [] });
    // Simulate a database that predates both the digest column and the source_entry_calls table.
    // 79: idx_source_identity no longer exists to drop (item 0: retired by the hot/cold split).
    store.db.exec("ALTER TABLE source_entries DROP COLUMN digest;");
    store.db.exec("DROP TABLE source_entry_calls;");
    store.close();
    store = new Store(f.path);
    for (const [id, entry] of [["a1", a1], ["a2", a2], ["u1", u1]] as const) {
      const row = store.db.prepare("SELECT digest FROM source_entries WHERE id = ?").get(entry.id) as { digest: string };
      expect(row.digest).toBe(sourceDigest(raws[id]!)); // computed from the stored Raw equals the one stored
    }
    expect(store.findKnownSourceEntry(f.session.id, "native", "a1")).toEqual(
      { id: a1.id, turnId: f.turn.id, digest: sourceDigest(raws.a1!), calls: [{ ordinal: 1, name: "bash", callId: "call-1" }] });
    expect(store.turnCallIdentities(f.turn.id)).toEqual([
      { ordinal: 1, name: "bash", callId: "call-1" }, { ordinal: 2, name: "grep", callId: "call-2" }]);
    // The write path still works after migration: a new entry gets its digest and calls in one write.
    const raw = JSON.stringify({ role: "assistant", content: "third answer" });
    const a3 = store.appendSourceEntry({ sessionId: f.session.id, turnId: f.turn.id, nativeLineage: "native", nativeId: "a3",
      role: "assistant", text: "third answer", raw, calls: [{ callId: "call-3", ordinal: 3, name: "read", status: "success" }] });
    expect((store.db.prepare("SELECT digest FROM source_entries WHERE id = ?").get(a3.id) as { digest: string }).digest).toBe(sourceDigest(raw));
    expect(store.findKnownSourceEntry(f.session.id, "native", "a3")!.calls).toEqual([{ ordinal: 3, name: "read", callId: "call-3" }]);
  } finally { store.close(); }
});
