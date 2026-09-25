import { expect, test, vi } from "vitest";
import { Store } from "../../../src/core/store/index.ts";

const time = "2026-09-24T00:00:00Z";
function fixture(published = true) {
  const store = new Store(":memory:");
  const project = store.createProject({ name: "pending", declaredBy: "mark" });
  const session = store.createSession({ host: "test", projectId: project.id, enrollmentChoice: true, startedAt: time, firstReplyAt: time });
  const turn = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "root", startedAt: time });
  const add = (id: string) => store.appendSourceEntry({ sessionId: session.id, turnId: turn.id,
    nativeLineage: "n", nativeId: id, role: "user", text: id, raw: id, calls: [] });
  const entries = [add("first"), add("second"), add("third")];
  if (published) store.publishSourcePath(session.id, "main", entries.map(e => e.id), turn.id, "n");
  const pending = () => store.pendingEntryState(session.id, "main", turn.id);
  const note = (ids: number[]) => store.commitNotingRun({
    run: { kind: "noting", sessionId: session.id, branch: "main", createdAt: time }, entryIds: ids, facts: [],
  });
  return { store, session, turn, entries, add, pending, note };
}

test("80: no published path never caches session-occurrence fallback across a Raw append", () => {
  const { store, add, pending, entries } = fixture(false);
  try {
    expect([...pending()]).toEqual(entries.map(e => e.id));
    const added = add("fourth");
    expect([...pending()]).toEqual([...entries.map(e => e.id), added.id]);
  } finally { store.close(); }
});

test("80: own successful Noting removes only the queue prefix after COMMIT", () => {
  const { store, pending, note, entries } = fixture();
  try {
    const before = pending();
    const cold = vi.spyOn(store as any, "pathSourceMeta");
    expect(note([entries[0]!.id]).ok).toBe(true);
    expect(pending()).toBe(before);
    expect(before.offset).toBe(1);
    expect([...before]).toEqual(entries.slice(1).map(e => e.id));
    expect(cold).not.toHaveBeenCalled();
    expect(note([entries[1]!.id, entries[2]!.id]).ok).toBe(true);
    expect(pending()).toBe(before);
    expect(before.offset).toBe(3);
    expect(before.length).toBe(0);
    expect(cold).not.toHaveBeenCalled();
  } finally { store.close(); }
});

test("80: failed local Noting never mutates the pending queue", () => {
  const { store, session, pending, entries } = fixture();
  try {
    const before = pending();
    const result = store.commitNotingRun({ run: { kind: "noting", sessionId: session.id, branch: "main", createdAt: time },
      facts: [], entryIds: [entries[0]!.id, 999999] });
    expect(result.ok).toBe(false);
    expect(pending()).toBe(before);
    expect(before.offset).toBe(0);
    expect([...before]).toEqual(entries.map(e => e.id));
  } finally { store.close(); }
});

test("80: a nested Noting write does not publish a pending prefix before outer commit", () => {
  const { store, pending, note, entries } = fixture();
  try {
    const before = pending();
    expect(() => store.transaction(() => {
      expect(note([entries[0]!.id]).ok).toBe(true);
      expect([...pending()]).toEqual(entries.slice(1).map(e => e.id));
      expect([...before]).toEqual(entries.map(e => e.id));
      throw new Error("rollback outer");
    })).toThrow("rollback outer");
    expect(pending()).toBe(before);
    expect(before.offset).toBe(0);
    store.transaction(() => { expect(note([entries[0]!.id]).ok).toBe(true); });
    expect([...pending()]).toEqual(entries.slice(1).map(e => e.id));
    expect(before.offset).toBe(1);
  } finally { store.close(); }
});

test("80: a non-prefix local batch is an uncovered invalidation, not a prefix trim", () => {
  const { store, pending, note, entries } = fixture();
  try {
    const before = pending();
    expect(note([entries[1]!.id]).ok).toBe(true);
    expect([...pending()]).toEqual([entries[0]!.id, entries[2]!.id]);
    expect(pending()).not.toBe(before);
  } finally { store.close(); }
});
