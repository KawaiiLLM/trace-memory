import { expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TraceMemory } from "../../../src/core/api/index.ts";
import { Store } from "../../../src/core/store/index.ts";
import { renderEntry, tokens } from "../../../src/core/render/index.ts";

const at = "2026-09-23T00:00:00Z";
function fixture(file = ":memory:") {
  const memory = TraceMemory(file, vi.fn());
  const store = memory.store;
  const project = store.createProject({ name: "pending-prefix", declaredBy: "mark" });
  const session = store.createSession({ host: "test", projectId: project.id, enrollmentChoice: true,
    startedAt: at, firstReplyAt: at });
  const add = (parentTurnId: number | null, name: string, turnId?: number) => {
    const turn = turnId === undefined ? store.appendTurn({ sessionId: session.id, parentTurnId, kind: "turn",
      userPrompt: name, startedAt: at }) : store.getTurn(turnId)!;
    const entry = store.appendSourceEntry({ sessionId: session.id, turnId: turn.id, nativeLineage: "native",
      nativeId: name, role: "user", text: `message ${name} ` + "word ".repeat(12), raw: "{}", calls: [] });
    return { turn, entry };
  };
  return { memory, store, session, add };
}

test("80: cached pending membership and counted prefix extend across turns and within one Turn", () => {
  const { memory, store, session, add } = fixture();
  try {
    const first = add(null, "first");
    store.publishSourcePath(session.id, "main", [first.entry.id], first.turn.id, "native");
    const target = { sessionId: session.id, branch: "main", headTurnId: first.turn.id };
    memory.config.noting.triggerTokens = 1_000_000;
    expect(memory.taskEligibility("noting", target).due).toBe(false);
    const original = store.pendingEntryState(session.id, "main", target.headTurnId);
    const second = add(first.turn.id, "second");
    let state = store.sourcePathState(session.id, "main")!;
    store.appendSourcePath(session.id, "main", state, [second.entry.id], second.turn.id, "native");
    target.headTurnId = second.turn.id;
    expect(store.pendingEntryState(session.id, "main", target.headTurnId)).toBe(original);
    const sameTurn = add(second.turn.id, "same turn", second.turn.id);
    state = store.sourcePathState(session.id, "main")!;
    store.appendSourcePath(session.id, "main", state, [sameTurn.entry.id], second.turn.id, "native");
    expect(store.pendingEntryState(session.id, "main", target.headTurnId)).toBe(original);
    const ids = store.pendingEntryIds(session.id, "main", target.headTurnId);
    expect(ids).toEqual([first.entry.id, second.entry.id, sameTurn.entry.id]);
    const exact = tokens(ids.map(id => renderEntry(store.getSourceEntry(id)!, memory.config.render).content).join("\n\n"));
    expect(memory.pendingTokens("noting", target).tokens).toBe(exact);
    expect(memory.taskEligibility("noting", target).due).toBe(false);
  } finally { memory.close(); }
});

test("80: nested Pi-style append updates only after outer commit; rollback leaves cached answer intact", () => {
  const { memory, store, session, add } = fixture();
  try {
    const root = add(null, "root");
    store.publishSourcePath(session.id, "main", [root.entry.id], root.turn.id, "native");
    let head = root.turn.id;
    const original = store.pendingEntryState(session.id, "main", head);
    let added!: ReturnType<typeof add>;
    store.transaction(() => {
      added = add(head, "committed");
      store.appendSourcePath(session.id, "main", store.sourcePathState(session.id, "main")!,
        [added.entry.id], added.turn.id, "native");
    });
    head = added.turn.id;
    expect(store.pendingEntryState(session.id, "main", head)).toBe(original);
    expect(store.pendingEntryIds(session.id, "main", head)).toEqual([root.entry.id, added.entry.id]);
    const state = store.sourcePathState(session.id, "main")!;
    expect(() => store.transaction(() => {
      const rollback = add(head, "rolled back");
      store.appendSourcePath(session.id, "main", state, [rollback.entry.id], rollback.turn.id, "native");
      throw new Error("rollback");
    })).toThrow("rollback");
    expect(store.sourcePathState(session.id, "main")).toEqual(state);
    expect(store.pendingEntryState(session.id, "main", head)).toBe(original);
    expect(memory.pendingTokens("noting", { sessionId: session.id, branch: "main", headTurnId: head }).tokens)
      .toBe(tokens([root.entry.id, added.entry.id].map(id =>
        renderEntry(store.getSourceEntry(id)!, memory.config.render).content).join("\n\n")));
  } finally { memory.close(); }
});

test("80: a historical head never inherits a newly appended future Turn", () => {
  const { memory, store, session, add } = fixture();
  try {
    const t1 = add(null, "t1");
    store.publishSourcePath(session.id, "main", [t1.entry.id], t1.turn.id, "native");
    const historical = store.pendingEntryState(session.id, "main", t1.turn.id);
    const t2 = add(t1.turn.id, "t2");
    store.appendSourcePath(session.id, "main", store.sourcePathState(session.id, "main")!,
      [t2.entry.id], t2.turn.id, "native");
    expect(store.pendingEntryState(session.id, "main", t1.turn.id)).toEqual([t1.entry.id]);
    expect(store.pendingEntryState(session.id, "main", t1.turn.id)).not.toBe(historical);
    // Warm the historical head while the selected path already extends beyond it.
    const t3 = add(t2.turn.id, "t3");
    store.appendSourcePath(session.id, "main", store.sourcePathState(session.id, "main")!,
      [t3.entry.id], t3.turn.id, "native");
    expect(store.pendingEntryState(session.id, "main", t3.turn.id))
      .toEqual([t1.entry.id, t2.entry.id, t3.entry.id]);
  } finally { memory.close(); }
});

test("80: append, noting, branch/head navigation and rewrite agree with a fresh joined estimate", () => {
  const { memory, store, session, add } = fixture();
  try {
    const first = add(null, "root");
    const branches = new Map<string, { ids: number[]; head: number }>([
      ["main", { ids: [first.entry.id], head: first.turn.id }],
      ["side", { ids: [first.entry.id], head: first.turn.id }],
    ]);
    for (const [branch, path] of branches) store.publishSourcePath(session.id, branch, path.ids, path.head, branch);
    let seed = 71237;
    const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) % 100);
    for (let step = 0; step < 65; step++) {
      const branch = random() < 50 ? "main" : "side";
      const path = branches.get(branch)!;
      const operation = random() % 4;
      if (operation === 0 && path.ids.length > 1) {
        path.ids = path.ids.slice(0, Math.max(1, path.ids.length - 1));
        path.head = store.getSourceEntry(path.ids.at(-1)!)!.turnId;
        store.publishSourcePath(session.id, branch, path.ids, path.head, branch);
      } else if (operation === 1) {
        const candidate = store.pendingEntryIds(session.id, branch, path.head)[0];
        if (candidate !== undefined) {
          const result = store.commitNotingRun({ run: { kind: "noting", sessionId: session.id,
            branch, rangeFrom: `S${session.id}/T${first.turn.id}`, rangeTo: `S${session.id}/T${path.head}`,
            createdAt: at }, entryIds: [candidate], facts: [] });
          expect(result.ok).toBe(true);
        }
      } else {
        const next = add(path.head, `${branch}-${step}`);
        store.appendSourcePath(session.id, branch, store.sourcePathState(session.id, branch)!,
          [next.entry.id], next.turn.id, branch);
        path.ids.push(next.entry.id);
        path.head = next.turn.id;
      }
      const target = { sessionId: session.id, branch, headTurnId: path.head };
      const ids = store.sourcePath(session.id, branch, path.head).map(entry => entry.id)
        .filter(id => !store.entryNoted(id));
      expect(store.pendingEntryIds(session.id, branch, path.head)).toEqual(ids);
      const expected = tokens(ids.map(id => renderEntry(store.getSourceEntry(id)!, memory.config.render).content).join("\n\n"));
      expect(memory.pendingTokens("noting", target).tokens).toBe(expected);
      memory.config.noting.triggerTokens = 1 + random() * 3;
      expect(memory.taskEligibility("noting", target).due).toBe(expected >= memory.config.noting.triggerTokens);
    }
  } finally { memory.close(); }
});

test("80: committed append on a second connection refreshes only its indexed suffix", () => {
  const dir = mkdtempSync(join(tmpdir(), "tm-80-external-append-")), file = join(dir, "trace.db");
  try {
    const { memory, store, session, add } = fixture(file);
    try {
      const first = add(null, "first");
      store.publishSourcePath(session.id, "main", [first.entry.id], first.turn.id, "native");
      const pending = store.pendingEntryState(session.id, "main", first.turn.id);
      const other = new Store(file);
      let nextHead!: number, nextId!: number;
      try {
        const turn = other.appendTurn({ sessionId: session.id, parentTurnId: first.turn.id,
          kind: "turn", userPrompt: "second", startedAt: at });
        const entry = other.appendSourceEntry({ sessionId: session.id, turnId: turn.id,
          nativeLineage: "native", nativeId: "second", role: "user", text: "message second",
          raw: "{}", calls: [] });
        other.appendSourcePath(session.id, "main", other.sourcePathState(session.id, "main")!,
          [entry.id], turn.id, "native");
        nextHead = turn.id; nextId = entry.id;
      } finally { other.close(); }
      expect(store.pendingEntryState(session.id, "main", nextHead)).toBe(pending);
      expect(store.pendingEntryIds(session.id, "main", nextHead)).toEqual([first.entry.id, nextId]);
    } finally { memory.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("80: another connection's empty Noting commit invalidates pending membership and due prefix", () => {
  const dir = mkdtempSync(join(tmpdir(), "tm-80-pending-")), file = join(dir, "trace.db");
  try {
    const { memory, store, session, add } = fixture(file);
    try {
      const first = add(null, "first");
      store.publishSourcePath(session.id, "main", [first.entry.id], first.turn.id, "native");
      const target = { sessionId: session.id, branch: "main", headTurnId: first.turn.id };
      memory.config.noting.triggerTokens = 1;
      expect(memory.taskEligibility("noting", target).due).toBe(true);
      const original = store.pendingEntryState(session.id, "main", target.headTurnId);
      const other = new Store(file);
      try {
        const done = other.commitNotingRun({ run: { kind: "noting", sessionId: session.id,
          branch: "main", rangeFrom: `S${session.id}/T${first.turn.id}`,
          rangeTo: `S${session.id}/T${first.turn.id}`, createdAt: at },
          entryIds: [first.entry.id], facts: [] });
        expect(done.ok).toBe(true);
      } finally { other.close(); }
      expect(store.pendingEntryState(session.id, "main", target.headTurnId)).not.toBe(original);
      expect(store.pendingEntryIds(session.id, "main", target.headTurnId)).toEqual([]);
      expect(memory.taskEligibility("noting", target).due).toBe(false);
      expect(memory.pendingTokens("noting", target).tokens).toBe(0);
    } finally { memory.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
