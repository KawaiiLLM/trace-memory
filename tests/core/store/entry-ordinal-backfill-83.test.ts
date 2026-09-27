// Ticket 83: backfill every source entry whose `entry_ordinal` is NULL (a stale writer's raw INSERT
// that omitted the column -- this codebase's own write path always assigns one), then make the
// column NOT NULL in every database state (Pi review of 2964522), decided by the column's declared
// `notnull` flag, never by "no NULL rows right now".
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store, type SourceInput } from "../../../src/core/store/index.ts";
import { sourceAddresses } from "../../../src/core/model/source.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tm-83-backfill-")); dirs.push(dir);
  const path = join(dir, "test.sqlite"), store = new Store(path);
  const project = store.createProject({ name: "backfill-83", declaredBy: "mark" });
  const session = store.createSession({ projectId: project.id, host: "test", startedAt: "time", firstReplyAt: "time", enrollmentChoice: true });
  return { dir, path, store, session };
}

/** Rewrite `source_entries` back to a nullable `entry_ordinal`, its declaration before 83, on an
 * otherwise fully-migrated (79-split) database -- reproduces item 3's states b/c ("already split,
 * column still nullable"). `restoreContent` additionally re-merges `content`/`blocks` back from
 * `source_entry_raw` and drops that table, reproducing state a ("not yet split"). */
function downgradeOrdinalConstraint(store: Store, restoreContent: boolean): void {
  if (restoreContent) store.db.exec(`ALTER TABLE source_entries ADD COLUMN content TEXT;
    ALTER TABLE source_entries ADD COLUMN blocks TEXT;
    UPDATE source_entries SET content = (SELECT content FROM source_entry_raw WHERE entry_id = source_entries.id),
      blocks = (SELECT blocks FROM source_entry_raw WHERE entry_id = source_entries.id);
    DROP TABLE source_entry_raw;`);
  const columns = restoreContent
    ? "id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL REFERENCES sessions(id), native_lineage TEXT NOT NULL, native_id TEXT NOT NULL, turn_id INTEGER NOT NULL REFERENCES turns(id), content TEXT NOT NULL, entry_ordinal INTEGER CHECK(entry_ordinal > 0), addresses TEXT NOT NULL DEFAULT '[]', digest TEXT, blocks TEXT, UNIQUE (session_id, native_lineage, native_id)"
    : "id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL REFERENCES sessions(id), native_lineage TEXT NOT NULL, native_id TEXT NOT NULL, turn_id INTEGER NOT NULL REFERENCES turns(id), entry_ordinal INTEGER CHECK(entry_ordinal > 0), addresses TEXT NOT NULL DEFAULT '[]', digest TEXT, UNIQUE (session_id, native_lineage, native_id)";
  const names = restoreContent ? "id,session_id,native_lineage,native_id,turn_id,content,entry_ordinal,addresses,digest,blocks"
    : "id,session_id,native_lineage,native_id,turn_id,entry_ordinal,addresses,digest";
  // `source_entry_calls`/`noted_entries` reference `source_entries(id)`: the rebuild's DROP TABLE
  // needs foreign keys off, same as Store's own migration transaction (index 822).
  store.db.exec(`PRAGMA foreign_keys = OFF;
    DROP INDEX IF EXISTS idx_source_turn_ordinal;
    CREATE TABLE source_entries_downgrade (${columns});
    INSERT INTO source_entries_downgrade (${names}) SELECT ${names} FROM source_entries;
    DROP TABLE source_entries; ALTER TABLE source_entries_downgrade RENAME TO source_entries;
    CREATE UNIQUE INDEX idx_source_turn_ordinal ON source_entries(turn_id, entry_ordinal);`);
  if (restoreContent) store.db.exec("CREATE INDEX idx_source_unnormalized ON source_entries(id) WHERE blocks IS NULL");
  store.db.exec("PRAGMA foreign_keys = ON");
}

/** Mirror the historical defect precisely (83's evidence): only the ordinal-based address changed
 * (`toSourceEntry` once turned a NULL ordinal into 0, so a precise `T<turn>#E<ordinal>...` address
 * was stored as `T<turn>#E0...`); legacy `#tN`/`#user`/`#assistant` addresses never depended on
 * `entry_ordinal` and were always stored correctly. */
const staleAddresses = (real: string[]): string[] => real.map(address => address.replace(/#E\d+/, "#E0"));

function ordinalColumn(store: Store): { notnull: number } {
  return (store.db.prepare("PRAGMA table_info(source_entries)").all() as { name: string; notnull: number }[])
    .find(c => c.name === "entry_ordinal")!;
}
function constraintInPlace(store: Store): void {
  expect(ordinalColumn(store).notnull).toBe(1);
  expect(store.db.prepare("SELECT sql FROM sqlite_master WHERE name='source_entries'").get()).toMatchObject({ sql: expect.stringMatching(/entry_ordinal INTEGER NOT NULL CHECK\(entry_ordinal > 0\)/) });
  expect(store.db.prepare("SELECT sql FROM sqlite_master WHERE name='idx_source_turn_ordinal'").get()).toMatchObject({ sql: expect.stringMatching(/UNIQUE INDEX idx_source_turn_ordinal ON source_entries\(turn_id, entry_ordinal\)/) });
}

for (const [label, restoreContent] of [["not yet split", true], ["already split", false]] as const) {
  test(`83: ${label}, with NULL ordinals -> backfilled, NOT NULL, addresses recomputed, #tN preserved`, () => {
    const f = fixture(); let store = f.store;
    const turn = store.appendTurn({ sessionId: f.session.id, kind: "turn", startedAt: "time" });
    const input = (nativeId: string, extra: Partial<SourceInput> = {}): SourceInput => ({ sessionId: f.session.id, turnId: turn.id,
      nativeId, nativeLineage: "original", role: "user", text: nativeId, raw: nativeId, calls: [], ...extra });
    const kept = store.appendSourceEntry(input("kept")); // stays numbered; the Turn's ordinal floor for the backfill
    const withCall = store.appendSourceEntry(input("call", { role: "assistant", text: "checking",
      calls: [{ ordinal: 1, name: "tool", callId: "c1", status: "ok", input: "{}", result: "done" }] }));
    const plain = store.appendSourceEntry(input("plain"));
    const realWithCallAddresses = JSON.parse(store.db.prepare("SELECT addresses FROM source_entries WHERE id = ?").get(withCall.id)!.addresses as string) as string[];
    const realPlainAddresses = JSON.parse(store.db.prepare("SELECT addresses FROM source_entries WHERE id = ?").get(plain.id)!.addresses as string) as string[];
    const digestBefore = new Map(store.db.prepare("SELECT id, digest FROM source_entries").all().map((r: any) => [Number(r.id), r.digest]));
    const nativeIdBefore = new Map(store.db.prepare("SELECT id, native_id FROM source_entries").all().map((r: any) => [Number(r.id), r.native_id]));
    // Bind a fact to `withCall` so its binding can be checked unchanged after the backfill.
    const bound = store.commitNotingRun({ run: { kind: "manual", sessionId: f.session.id, createdAt: "time" }, facts: [{ turnId: turn.id,
      category: "observation", actor: "user", text: "bound to the entry that will be renumbered", source: [`T${turn.id}#t1`], entryIds: [withCall.id], createdAt: "time" }] });
    if (!bound.ok) throw new Error(bound.problems.join());
    const factEntriesBefore = store.factEntries(bound.facts[0]!.id);

    downgradeOrdinalConstraint(store, restoreContent);
    expect(ordinalColumn(store).notnull).toBe(0); // downgrade landed: nullable again
    // Simulate the stale writer: null the ordinal of the two later entries in this Turn, and store
    // their addresses the way the historical defect actually produced them.
    store.db.prepare("UPDATE source_entries SET entry_ordinal = NULL, addresses = ? WHERE id = ?").run(JSON.stringify(staleAddresses(realWithCallAddresses)), withCall.id);
    store.db.prepare("UPDATE source_entries SET entry_ordinal = NULL, addresses = ? WHERE id = ?").run(JSON.stringify(staleAddresses(realPlainAddresses)), plain.id);
    store.close();

    store = new Store(f.path);
    try {
      constraintInPlace(store);
      // Backfilled in id order, continuing after the Turn's highest existing ordinal (`kept` = 1).
      expect(store.getSourceEntry(withCall.id)!.entryOrdinal).toBe(2);
      expect(store.getSourceEntry(plain.id)!.entryOrdinal).toBe(3);
      const ordinals = store.listSourceEntries(f.session.id, turn.id).map(e => e.entryOrdinal);
      expect(new Set(ordinals).size).toBe(ordinals.length); // unique within the Turn
      expect(ordinals.every(o => o > 0)).toBe(true);
      // Addresses recomputed with the writer's own function, from the row's own input and blocks.
      const rebuiltWithCall = store.getSourceEntry(withCall.id)!;
      expect(store.listSourceEntries(f.session.id, turn.id).find(e => e.id === withCall.id)!.addresses)
        .toEqual(sourceAddresses(rebuiltWithCall));
      expect(store.getSourceEntry(withCall.id)!.entryOrdinal === 2 && store.listSourceEntries(f.session.id, turn.id)
        .find(e => e.id === withCall.id)!.addresses.some(a => a === `T${turn.id}#E2`)).toBe(true);
      // #tN addresses (never dependent on entry_ordinal) are byte-identical to before the backfill.
      const afterWithCall = store.listSourceEntries(f.session.id, turn.id).find(e => e.id === withCall.id)!.addresses;
      expect(afterWithCall.filter(a => /#t\d+$/.test(a))).toEqual(realWithCallAddresses.filter(a => /#t\d+$/.test(a)));
      // digest, native_id, Turn, session, and the fact binding stay unchanged.
      expect(store.db.prepare("SELECT digest FROM source_entries WHERE id = ?").get(withCall.id)!.digest).toBe(digestBefore.get(withCall.id));
      expect(store.db.prepare("SELECT native_id FROM source_entries WHERE id = ?").get(withCall.id)!.native_id).toBe(nativeIdBefore.get(withCall.id));
      expect(store.getSourceEntry(withCall.id)!.turnId).toBe(turn.id);
      expect(store.getSourceEntry(withCall.id)!.sessionId).toBe(f.session.id);
      expect(store.factEntries(bound.facts[0]!.id)).toEqual(factEntriesBefore);
      // source_entry_calls stores the tool call's own ordinal (part of `#tN`), not entry_ordinal or
      // any address -- unaffected by the backfill, still resolvable to the same call.
      expect(store.turnCallIdentities(turn.id)).toEqual([{ ordinal: 1, name: "tool", callId: "c1" }]);
    } finally { store.close(); }
  });
}

test("83: already split, no NULL rows, but the column still nullable -> the constraint is added anyway", () => {
  const f = fixture(); let store = f.store;
  const turn = store.appendTurn({ sessionId: f.session.id, kind: "turn", startedAt: "time" });
  store.appendSourceEntry({ sessionId: f.session.id, turnId: turn.id, nativeId: "a", nativeLineage: "o", role: "user", text: "a", raw: "a", calls: [] });
  downgradeOrdinalConstraint(store, false); // already split, nullable, but every row still numbered
  expect(ordinalColumn(store).notnull).toBe(0);
  store.close();
  store = new Store(f.path);
  try { constraintInPlace(store); } finally { store.close(); }
});

test("83: idempotent -- a second open finds no NULL ordinal and does nothing", () => {
  const f = fixture(); let store = f.store;
  const turn = store.appendTurn({ sessionId: f.session.id, kind: "turn", startedAt: "time" });
  const kept = store.appendSourceEntry({ sessionId: f.session.id, turnId: turn.id, nativeId: "kept", nativeLineage: "o", role: "user", text: "kept", raw: "kept", calls: [] });
  const stray = store.appendSourceEntry({ sessionId: f.session.id, turnId: turn.id, nativeId: "stray", nativeLineage: "o", role: "user", text: "stray", raw: "stray", calls: [] });
  const realAddresses = JSON.parse(store.db.prepare("SELECT addresses FROM source_entries WHERE id = ?").get(stray.id)!.addresses as string) as string[];
  downgradeOrdinalConstraint(store, false);
  store.db.prepare("UPDATE source_entries SET entry_ordinal = NULL, addresses = ? WHERE id = ?").run(JSON.stringify(staleAddresses(realAddresses)), stray.id);
  store.close();
  store = new Store(f.path);
  const firstOpen = store.db.prepare("SELECT id, entry_ordinal, addresses, digest FROM source_entries ORDER BY id").all();
  store.close();
  store = new Store(f.path); // second open
  try {
    constraintInPlace(store);
    expect(store.db.prepare("SELECT id, entry_ordinal, addresses, digest FROM source_entries ORDER BY id").all()).toEqual(firstOpen);
    expect(store.getSourceEntry(kept.id)!.entryOrdinal).toBe(1);
    expect(store.getSourceEntry(stray.id)!.entryOrdinal).toBe(2);
  } finally { store.close(); }
});

test("83: a failure mid-backfill rolls back the whole batch (Raw bodies, existing ordinals, fact bindings unchanged)", () => {
  const f = fixture(); let store = f.store;
  const turnA = store.appendTurn({ sessionId: f.session.id, kind: "turn", startedAt: "time" });
  const turnB = store.appendTurn({ sessionId: f.session.id, kind: "turn", startedAt: "time" });
  // Turn A also holds an entry that keeps its ordinal (E1): a rollback must leave it exactly as it was.
  const numbered = store.appendSourceEntry({ sessionId: f.session.id, turnId: turnA.id, nativeId: "numbered", nativeLineage: "o", role: "assistant", text: "numbered", raw: "numbered", calls: [] });
  // Turn A (lower id, processed first): a clean stray row -- would backfill successfully in isolation.
  const cleanStray = store.appendSourceEntry({ sessionId: f.session.id, turnId: turnA.id, nativeId: "clean", nativeLineage: "o", role: "user", text: "clean", raw: "clean", calls: [] });
  // Turn B (higher id, processed after A): a stray row whose stored address corrupts a #tN entry too,
  // so its recompute fails the safety assertion and the whole open throws.
  const brokenStray = store.appendSourceEntry({ sessionId: f.session.id, turnId: turnB.id, nativeId: "broken", nativeLineage: "o", role: "assistant", text: "checking",
    raw: "broken", calls: [{ ordinal: 1, name: "tool", callId: "c1", status: "ok", input: "{}", result: "done" }] });
  // Facts bound to the numbered entry and to both stray rows (Pi review of 77af628): bindings are by
  // entry id, and a rolled-back backfill must leave every one of them in place.
  const noted = store.commitNotingRun({ run: { kind: "manual", sessionId: f.session.id, createdAt: "time" }, facts: [
    { turnId: turnA.id, text: "numbered fact", category: "observation", actor: "agent", source: [`T${turnA.id}#assistant`], entryIds: [numbered.id], createdAt: "time" },
    { turnId: turnA.id, text: "clean fact", category: "observation", actor: "user", source: [`T${turnA.id}#user`], entryIds: [cleanStray.id], createdAt: "time" },
    { turnId: turnB.id, text: "broken fact", category: "observation", actor: "agent", source: [`T${turnB.id}#assistant`], entryIds: [brokenStray.id], createdAt: "time" },
  ] });
  if (!noted.ok) throw new Error(JSON.stringify(noted));
  const bindingsBefore = store.db.prepare("SELECT fact_id, entry_id FROM fact_sources ORDER BY fact_id, entry_id").all();
  expect(new Set(bindingsBefore.map(row => Number(row.entry_id)))).toEqual(new Set([numbered.id, cleanStray.id, brokenStray.id]));
  const numberedBefore = store.db.prepare("SELECT id, entry_ordinal, addresses, digest FROM source_entries WHERE id = ?").get(numbered.id);
  expect(numberedBefore!.entry_ordinal).toBe(1);
  const rawBefore = store.db.prepare("SELECT content, blocks FROM source_entry_raw WHERE entry_id = ?").get(brokenStray.id);
  downgradeOrdinalConstraint(store, false);
  store.db.prepare("UPDATE source_entries SET entry_ordinal = NULL WHERE id = ?").run(cleanStray.id);
  // Corrupt the #tN portion itself: after recompute, the real address is "T<turnB>#t1"; store a
  // different tool-call address so the backfill's own before/after #tN assertion must fail.
  store.db.prepare("UPDATE source_entries SET entry_ordinal = NULL, addresses = ? WHERE id = ?")
    .run(JSON.stringify([`T${turnB.id}#t99`]), brokenStray.id);
  // Snapshot the exact pre-migration-attempt state (both rows already NULL'd), what a rolled-back
  // transaction must restore.
  const cleanBefore = store.db.prepare("SELECT id, entry_ordinal, addresses, digest FROM source_entries WHERE id = ?").get(cleanStray.id);
  store.close();

  expect(() => new Store(f.path)).toThrow(/#tN addresses changed/);
  // Verify against a plain, un-migrated connection: nothing committed, not even Turn A's row, which
  // was processed (and would have succeeded) before Turn B's row threw in the same transaction.
  const raw = new DatabaseSync(f.path);
  try {
    expect(raw.prepare("SELECT id, entry_ordinal, addresses, digest FROM source_entries WHERE id = ?").get(cleanStray.id)).toEqual(cleanBefore);
    expect(raw.prepare("SELECT entry_ordinal FROM source_entries WHERE id = ?").get(brokenStray.id)!.entry_ordinal).toBeNull();
    expect(raw.prepare("SELECT content, blocks FROM source_entry_raw WHERE entry_id = ?").get(brokenStray.id)).toEqual(rawBefore);
    expect(raw.prepare("SELECT id, entry_ordinal, addresses, digest FROM source_entries WHERE id = ?").get(numbered.id)).toEqual(numberedBefore);
    expect(raw.prepare("SELECT fact_id, entry_id FROM fact_sources ORDER BY fact_id, entry_id").all()).toEqual(bindingsBefore);
    expect((raw.prepare("PRAGMA table_info(source_entries)").all() as { name: string; notnull: number }[])
      .find(c => c.name === "entry_ordinal")!.notnull).toBe(0); // constraint never landed either
  } finally { raw.close(); }
});
