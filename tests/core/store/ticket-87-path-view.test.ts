import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../../src/core/store/index.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const time = "2026-09-25T00:00:00Z";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tm-87-path-")); dirs.push(dir);
  const file = join(dir, "trace.db"), writer = new Store(file), reader = new Store(file);
  const projectId = writer.createProject({ name: "path view", declaredBy: "mark" }).id;
  const sessionId = writer.createSession({ host: "test", projectId, enrollmentChoice: true,
    startedAt: time, firstReplyAt: time }).id;
  let parent: number | null = null, native = 0;
  const append = (branch: string, state?: ReturnType<Store["sourcePathState"]>) => {
    const turn = writer.appendTurn({ sessionId, parentTurnId: parent, kind: "turn", userPrompt: "next", startedAt: time });
    const entry = writer.appendSourceEntry({ sessionId, turnId: turn.id, nativeLineage: "test", nativeId: `e${++native}`,
      role: "user", text: "next", raw: "next", calls: [] });
    if (state) writer.appendSourcePath(sessionId, branch, state, [entry.id], turn.id, "L");
    else writer.publishSourcePath(sessionId, branch, [entry.id], turn.id, "L");
    parent = turn.id;
    return { turn, entry };
  };
  return { file, writer, reader, sessionId, append };
}

test("87: view snapshots freeze membership and pending while another connection extends and notes", () => {
  const { writer, reader, sessionId, append } = fixture();
  try {
    const first = append("main");
    const path = { sessionId, branch: "main", headTurnId: first.turn.id };
    const frozen = reader.pathSnapshot(path);
    const original = reader.selectedSourceEntrySnapshot(sessionId, "main")!;
    const pending = reader.pendingEntryState(sessionId, "main", first.turn.id);
    expect([...pending]).toEqual([first.entry.id]);
    for (let repeat = 0; repeat < 3; repeat++) {
      const hit = reader.pendingEntryState(sessionId, "main", first.turn.id);
      expect(hit).toBe(pending);
      expect(hit.key).toBe(pending.key);
    }
    const next = append("main", writer.sourcePathState(sessionId, "main")!);
    // A reader still on the old head must not accidentally consume the new suffix.
    expect(reader.pendingEntryIds(sessionId, "main", first.turn.id)).toEqual([first.entry.id]);
    expect(frozen.turns.has(next.turn.id)).toBe(false);
    expect(frozen.entries!.ids.has(next.entry.id)).toBe(false);
    expect(original.ids()).toEqual([first.entry.id]);
    const advanced = reader.pendingEntryState(sessionId, "main", next.turn.id);
    expect([...advanced]).toEqual([first.entry.id, next.entry.id]);
    expect(reader.pendingEntryState(sessionId, "main", next.turn.id)).toBe(advanced);
    expect(reader.pendingEntryIds(sessionId, "main", next.turn.id)).toEqual([first.entry.id, next.entry.id]);
    const marked = writer.commitNotingRun({ run: { kind: "noting", sessionId, createdAt: time },
      entryIds: [first.entry.id], facts: [] });
    expect(marked.ok).toBe(true);
    expect(reader.pendingEntryIds(sessionId, "main", next.turn.id)).toEqual([next.entry.id]);
    expect(reader.pendingEntryState(sessionId, "main", next.turn.id).offset).toBe(1);
    expect([...reader.pathSnapshot({ ...path, headTurnId: next.turn.id }).entries!.ids])
      .toEqual([first.entry.id, next.entry.id]);
    const own = reader.commitNotingRun({ run: { kind: "noting", sessionId, createdAt: time },
      entryIds: [next.entry.id], facts: [] });
    expect(own.ok).toBe(true);
    expect(reader.pendingEntryIds(sessionId, "main", next.turn.id)).toEqual([]);
  } finally { writer.close(); reader.close(); }
});

test("87: membership-only reads defer noted hydration without losing later marks", () => {
  const { writer, reader, sessionId, append } = fixture();
  try {
    const first = append("main"), path = { sessionId, branch: "main", headTurnId: first.turn.id };
    const sql = vi.spyOn(reader.db, "prepare");
    reader.pathSnapshot(path);
    reader.selectedSourceEntryIds(sessionId, "main");
    expect(sql.mock.calls.filter(([query]) => /noted_entries/.test(query))).toHaveLength(0);
    const note = (entryIds: number[]) => writer.commitNotingRun({ run: { kind: "noting", sessionId, createdAt: time }, entryIds, facts: [] });
    expect(note([first.entry.id]).ok).toBe(true);
    expect(reader.pendingEntryIds(sessionId, "main", first.turn.id)).toEqual([]);
    const notedReads = sql.mock.calls.filter(([query]) => /noted_entries/.test(query) && !query.startsWith("EXPLAIN"));
    expect(notedReads).toHaveLength(2); // one watermark and one bounded rowid read
    const markedSql = notedReads.find(([query]) => query.includes("FROM noted_entries n NOT INDEXED"))![0];
    const plan = reader.db.prepare(`EXPLAIN QUERY PLAN ${markedSql}`).all(sessionId, 0, 1);
    expect(plan.some(row => /SEARCH n USING INTEGER PRIMARY KEY \(rowid>\? AND rowid<\?\)/.test(String(row.detail)))).toBe(true);
    const next = append("main", writer.sourcePathState(sessionId, "main")!);
    reader.pathSnapshot({ ...path, headTurnId: next.turn.id });
    reader.selectedSourceEntryIds(sessionId, "main");
    expect(sql.mock.calls.filter(([query]) => /noted_entries/.test(query) && !query.startsWith("EXPLAIN"))).toHaveLength(2);
    expect(note([next.entry.id]).ok).toBe(true);
    expect(reader.pendingEntryIds(sessionId, "main", next.turn.id)).toEqual([]);
    expect(sql.mock.calls.filter(([query]) => /noted_entries/.test(query) && !query.startsWith("EXPLAIN"))).toHaveLength(4);
    const pending = reader.pendingEntryState(sessionId, "main", next.turn.id);
    expect(note([]).ok).toBe(true);
    expect(reader.pendingEntryState(sessionId, "main", next.turn.id)).toBe(pending);
    sql.mockRestore();
  } finally { writer.close(); reader.close(); }
});

test("87: an origin records one exact trigger and a rewind selects the last on-ancestry entry", () => {
  const { writer, reader, sessionId, append } = fixture();
  try {
    const root = append("main");
    const sameTurn = writer.appendSourceEntry({ sessionId, turnId: root.turn.id, nativeLineage: "test", nativeId: "same-turn",
      role: "assistant", text: "same-turn", raw: "same-turn", calls: [] });
    writer.appendSourcePath(sessionId, "main", writer.sourcePathState(sessionId, "main")!, [sameTurn.id], root.turn.id, "L");
    const next = append("main", writer.sourcePathState(sessionId, "main")!);
    const historical = { sessionId, branch: "main", headTurnId: root.turn.id };
    expect(reader.triggerOrigin(historical)).toEqual({ sessionId, entryIds: [sameTurn.id] });
    const explicit = reader.triggerOrigin(historical, root.entry.id);
    expect(explicit).toEqual({ sessionId, entryIds: [root.entry.id] });
    const execution = reader.beginExecution({ sessionId, phase: "noting", head: root.entry.id, origin: explicit });
    expect(() => reader.triggerOrigin(historical, next.entry.id)).toThrow("exact triggering entry");
    expect(reader.triggerOrigin({ ...historical, headTurnId: next.turn.id })).toEqual({ sessionId, entryIds: [next.entry.id] });
    expect(reader.executionOrigin(execution)).toEqual(explicit); // retry keeps the admitted trigger
    writer.selectSourcePath(sessionId, "main", [root.entry.id]);
    expect(reader.triggerOrigin(historical)).toEqual({ sessionId, entryIds: [root.entry.id] });
  } finally { writer.close(); reader.close(); }
});

test("87: noted watermark reads only new rows, including other-session marks", () => {
  const { writer, reader, sessionId, append } = fixture();
  try {
    const first = append("main");
    const initial = reader.pendingEntryState(sessionId, "main", first.turn.id);
    expect(reader.pendingEntryState(sessionId, "main", first.turn.id)).toBe(initial);
    const other = writer.createSession({ host: "other", projectId: writer.getSession(sessionId)!.projectId,
      enrollmentChoice: true, startedAt: time, firstReplyAt: time });
    const turn = writer.appendTurn({ sessionId: other.id, kind: "turn", userPrompt: "other", startedAt: time });
    const entry = writer.appendSourceEntry({ sessionId: other.id, turnId: turn.id, nativeLineage: "other", nativeId: "other",
      role: "user", text: "other", raw: "other", calls: [] });
    expect(writer.commitNotingRun({ run: { kind: "noting", sessionId: other.id, createdAt: time },
      entryIds: [entry.id], facts: [] }).ok).toBe(true);
    expect(reader.pendingEntryState(sessionId, "main", first.turn.id)).toBe(initial);
    const next = append("main", writer.sourcePathState(sessionId, "main")!);
    expect(reader.pendingEntryIds(sessionId, "main", next.turn.id)).toEqual([first.entry.id, next.entry.id]);
    expect(writer.commitNotingRun({ run: { kind: "noting", sessionId, createdAt: time },
      entryIds: [first.entry.id], facts: [] }).ok).toBe(true);
    expect(reader.pendingEntryIds(sessionId, "main", next.turn.id)).toEqual([next.entry.id]);
    expect(reader.pendingEntryState(sessionId, "main", next.turn.id)).toBe(reader.pendingEntryState(sessionId, "main", next.turn.id));
  } finally { writer.close(); reader.close(); }
});

test("87: rewound borrowed cursors reuse both head and tail ancestry across lineages", () => {
  const { writer, reader, sessionId, append } = fixture();
  try {
    const root = append("main");
    const next = append("main", writer.sourcePathState(sessionId, "main")!);
    writer.selectSourcePath(sessionId, "other", [root.entry.id, next.entry.id]);
    writer.setCurrentPath(sessionId, "main", root.turn.id, "L");
    writer.setCurrentPath(sessionId, "other", root.turn.id, "other-lineage");
    const load = vi.spyOn(reader as unknown as { loadPathTurns(path: { sessionId: number; headTurnId: number }): Set<number> }, "loadPathTurns");
    const targets = () => (reader as unknown as { borrowedCursorTargets(id: number): { branch: string; headTurnId: number }[] })
      .borrowedCursorTargets(sessionId);
    const expected = [{ branch: "main", headTurnId: root.turn.id }, { branch: "other", headTurnId: root.turn.id }];
    expect(targets()).toEqual(expected);
    const warmed = load.mock.calls.length;
    for (let i = 0; i < 8; i++) {
      expect(targets()).toEqual(expected);
      for (const target of expected) expect(reader.borrowedTargetActive({ sessionId, ...target })).toBe(true);
    }
    expect(load.mock.calls).toHaveLength(warmed);
    const sibling = writer.appendTurn({ sessionId, parentTurnId: root.turn.id, kind: "turn", userPrompt: "sibling", startedAt: time });
    expect(() => writer.setCurrentPath(sessionId, "main", sibling.id, "L")).toThrow("not coherent");
    const more = append("main", writer.sourcePathState(sessionId, "main")!);
    writer.setCurrentPath(sessionId, "main", root.turn.id, "L");
    expect(targets()).toEqual(expected);
    writer.selectSourcePath(sessionId, "other", [root.entry.id]);
    expect(targets()).toEqual(expected);
    expect(reader.pathSnapshot({ sessionId, branch: "main", headTurnId: more.turn.id }).entries!.ids.has(more.entry.id)).toBe(true);
  } finally { writer.close(); reader.close(); vi.restoreAllMocks(); }
});

test("87: a rollback and a non-append rewrite cannot leak into a frozen view", () => {
  const { writer, reader, sessionId, append } = fixture();
  try {
    const first = append("main"), state = writer.sourcePathState(sessionId, "main")!;
    const second = append("main", state);
    const path = { sessionId, branch: "main", headTurnId: second.turn.id };
    const frozen = reader.pathSnapshot(path);
    const before = reader.selectedSourceEntrySnapshot(sessionId, "main")!;
    expect(() => writer.transaction(() => {
      writer.selectSourcePath(sessionId, "main", [first.entry.id]);
      throw new Error("roll back");
    })).toThrow("roll back");
    expect(reader.selectedSourceEntryIds(sessionId, "main")).toEqual(before.ids());
    writer.selectSourcePath(sessionId, "main", [first.entry.id]);
    const now = reader.pathSnapshot(path);
    expect([...now.entries!.ids]).toEqual([first.entry.id]);
    expect([...frozen.entries!.ids]).toEqual([first.entry.id, second.entry.id]);
    expect(before.ids()).toEqual([first.entry.id, second.entry.id]);
  } finally { writer.close(); reader.close(); }
});

test("87: randomized invalidations compare a cached reader with a cold reader after every event", () => {
  const { file, writer, reader, sessionId, append } = fixture();
  let cached = reader;
  try {
    const first = append("main");
    writer.selectSourcePath(sessionId, "side", [first.entry.id]);
    let branch = "main", head = first.turn.id, seed = 8731;
    const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0);
    const events = ["append", "own-note", "other-note", "empty-note", "other-append",
      "rewrite", "switch", "back", "rollback", "restart"] as const;
    for (let cycle = 0; cycle < 5; cycle++) {
      const shuffled = [...events];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = random() % (i + 1);
        [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
      }
      for (const event of shuffled) {
        if (event === "switch") branch = branch === "main" ? "side" : "main";
        else if (event === "restart") { cached.close(); cached = new Store(file); }
        else if (event === "rollback") {
          expect(() => writer.transaction(() => {
            writer.selectSourcePath(sessionId, branch, [first.entry.id]);
            throw new Error("rollback");
          })).toThrow("rollback");
        } else if (event === "rewrite") writer.selectSourcePath(sessionId, branch, [first.entry.id]);
        else if (event === "append" || event === "other-append") {
          const next = append(branch, writer.sourcePathState(sessionId, branch)!);
          head = next.turn.id;
        } else if (event !== "empty-note") {
          const pending = cached.pendingEntryIds(sessionId, branch, head);
          if (pending.length) {
            const owner = event === "own-note" ? cached : writer;
            expect(owner.commitNotingRun({ run: { kind: "noting", sessionId, createdAt: time },
              entryIds: [pending[0]!], facts: [] }).ok).toBe(true);
          }
        } else {
          expect(writer.commitNotingRun({ run: { kind: "noting", sessionId, createdAt: time },
            entryIds: [], facts: [] }).ok).toBe(true);
        }
        if (event === "back") head = first.turn.id;
        else if (event !== "restart" && event !== "rollback" && event !== "empty-note" && event !== "own-note" && event !== "other-note")
          head = writer.getSourceEntry(writer.sourcePathState(sessionId, branch)!.tailId!)!.turnId;
        writer.setCurrentPath(sessionId, branch, head, "L");
        const cold = new Store(file);
        try {
          const path = { sessionId, branch, headTurnId: head };
          const actual = cached.pathSnapshot(path), expected = cold.pathSnapshot(path);
          expect([...actual.turns]).toEqual([...expected.turns]);
          expect([...actual.entries!.ids]).toEqual([...expected.entries!.ids]);
          expect(cached.pendingEntryIds(sessionId, branch, head)).toEqual(cold.pendingEntryIds(sessionId, branch, head));
          expect(cached.selectedSourceEntryIds(sessionId, branch)).toEqual(cold.selectedSourceEntryIds(sessionId, branch));
        } finally { cold.close(); }
      }
    }
  } finally { cached.close(); writer.close(); }
});

test("87: a sequence of rewrites, appends, empty notes, head moves and restarts agrees with a cold Store", () => {
  const { file, writer, reader, sessionId, append } = fixture();
  try {
    const first = append("main");
    let head = first.turn.id;
    for (let step = 0; step < 24; step++) {
      const branch = step % 8 < 4 ? "main" : "sibling";
      if (!writer.sourcePathState(sessionId, branch)) writer.selectSourcePath(sessionId, branch, [first.entry.id]);
      if (step % 4 === 0) {
        const added = append(branch, writer.sourcePathState(sessionId, branch)!);
        head = added.turn.id;
      } else if (step % 4 === 1) {
        const pending = reader.pendingEntryIds(sessionId, branch, head);
        if (pending.length) {
          const result = writer.commitNotingRun({ run: { kind: "noting", sessionId, createdAt: time },
            entryIds: [pending[0]!], facts: [] });
          expect(result.ok).toBe(true);
        }
      } else if (step % 4 === 2) {
        const selected = writer.selectedSourceEntryIds(sessionId, branch)!;
        if (selected.length > 1) writer.selectSourcePath(sessionId, branch, selected.slice(0, -1));
        head = first.turn.id;
      } else head = writer.getSourceEntry(writer.sourcePathState(sessionId, branch)!.tailId!)!.turnId;
      writer.setCurrentPath(sessionId, branch, head, "L");
      const fresh = new Store(file);
      try {
        const path = { sessionId, branch, headTurnId: head };
        const actual = reader.pathSnapshot(path), expected = fresh.pathSnapshot(path);
        expect([...actual.turns]).toEqual([...expected.turns]);
        expect([...actual.entries!.ids]).toEqual([...expected.entries!.ids]);
        expect(reader.pendingEntryIds(sessionId, branch, head)).toEqual(fresh.pendingEntryIds(sessionId, branch, head));
        expect(reader.selectedSourceEntryIds(sessionId, branch)).toEqual(fresh.selectedSourceEntryIds(sessionId, branch));
      } finally { fresh.close(); }
    }
  } finally { reader.close(); writer.close(); }
});
