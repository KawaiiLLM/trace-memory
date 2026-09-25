import { expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../../../src/core/store/index.ts";

test("80: a general published suffix still filters out intermediate sibling Turns", () => {
  const store = new Store(":memory:"), at = "2026-09-24T00:00:00Z";
  try {
    const project = store.createProject({ name: "branches", declaredBy: "mark" });
    const session = store.createSession({ host: "test", projectId: project.id, enrollmentChoice: true,
      startedAt: at, firstReplyAt: at });
    const add = (nativeId: string, parentTurnId?: number) => {
      const turn = store.appendTurn({ sessionId: session.id, parentTurnId, kind: "turn", userPrompt: nativeId, startedAt: at });
      const entry = store.appendSourceEntry({ sessionId: session.id, turnId: turn.id, nativeLineage: "native",
        nativeId, role: "user", text: nativeId, raw: nativeId, calls: [] });
      return { turn, entry };
    };
    const root = add("root");
    store.publishSourcePath(session.id, "main", [root.entry.id], root.turn.id, "native");
    expect(store.pendingEntryIds(session.id, "main", root.turn.id)).toEqual([root.entry.id]);
    const sibling = add("sibling", root.turn.id), child = add("child", root.turn.id);
    store.publishSourcePath(session.id, "main", [root.entry.id, sibling.entry.id, child.entry.id], child.turn.id, "native");
    expect(store.pendingEntryIds(session.id, "main", child.turn.id)).toEqual([root.entry.id, child.entry.id]);
  } finally { store.close(); }
});

test("80: a lazy footer snapshot shares pending membership without crossing an external commit", () => {
  const directory = mkdtempSync(join(tmpdir(), "tm-80-footer-snapshot-"));
  const file = join(directory, "trace.db"), writer = new Store(file), reader = new Store(file);
  const at = "2026-09-24T00:00:00Z";
  try {
    const project = writer.createProject({ name: "footer", declaredBy: "mark" });
    const session = writer.createSession({ host: "test", projectId: project.id, enrollmentChoice: true,
      startedAt: at, firstReplyAt: at });
    const turn = writer.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "root", startedAt: at });
    const append = (nativeId: string) => writer.appendSourceEntry({ sessionId: session.id, turnId: turn.id,
      nativeLineage: "native", nativeId, role: "user", text: nativeId, raw: nativeId, calls: [] });
    const first = append("first");
    const path = { sessionId: session.id, branch: "main", headTurnId: turn.id };
    writer.publishSourcePath(session.id, "main", [first.id], turn.id, "native");
    let secondId = 0;
    const pending = reader.pendingEntryState(session.id, "main", turn.id, () => {
      const snapshot = reader.pathSnapshot(path);
      expect(writer.commitNotingRun({ run: { kind: "noting", sessionId: session.id, branch: "main", createdAt: at },
        facts: [], entryIds: [first.id] }).ok).toBe(true);
      secondId = append("second").id;
      writer.appendSourcePath(session.id, "main", writer.sourcePathState(session.id, "main")!, [secondId], turn.id, "native");
      return snapshot;
    });
    expect([...pending]).toEqual([first.id]);
    const refreshed = reader.pendingEntryState(session.id, "main", turn.id, () => reader.pathSnapshot(path));
    expect([...refreshed]).toEqual([secondId]);
    expect(refreshed.key).toBe(pending.key);
    expect([...pending]).toEqual([secondId]);
    expect(reader.pendingEntryState(session.id, "main", turn.id, () => { throw new Error("cache hit must not prepare"); }))
      .toBe(refreshed);
  } finally { reader.close(); writer.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("80: pending refresh cannot combine pre-note membership with a post-note append", () => {
  const directory = mkdtempSync(join(tmpdir(), "tm-80-pending-snapshot-"));
  const file = join(directory, "trace.db"), writer = new Store(file), reader = new Store(file);
  const at = "2026-09-24T00:00:00Z";
  try {
    const project = writer.createProject({ name: "snapshot", declaredBy: "mark" });
    const session = writer.createSession({ host: "test", projectId: project.id, enrollmentChoice: true,
      startedAt: at, firstReplyAt: at });
    const turn = writer.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "root", startedAt: at });
    const append = (nativeId: string) => writer.appendSourceEntry({ sessionId: session.id, turnId: turn.id,
      nativeLineage: "native", nativeId, role: "user", text: nativeId, raw: nativeId, calls: [] });
    const first = append("first");
    writer.publishSourcePath(session.id, "main", [first.id], turn.id, "native");
    expect(reader.pendingEntryIds(session.id, "main", turn.id)).toEqual([first.id]);
    const original = reader.db.prepare.bind(reader.db);
    let raced = false, secondId = 0;
    reader.db.prepare = ((sql: string) => {
      // A deferred read transaction has not read yet: both commits precede the header SELECT.
      // The coherent view must therefore reflect the new path and noted watermark.
      if (!raced && sql.startsWith("SELECT length, tail_entry_id, version FROM source_paths")) {
        raced = true;
        const noted = writer.commitNotingRun({ run: { kind: "noting", sessionId: session.id, branch: "main", createdAt: at },
          facts: [], entryIds: [first.id] });
        if (!noted.ok) throw new Error(noted.problems.join("; "));
        const second = append("second"); secondId = second.id;
        writer.appendSourcePath(session.id, "main", writer.sourcePathState(session.id, "main")!, [second.id], turn.id, "native");
      }
      return original(sql);
    }) as typeof reader.db.prepare;
    expect(reader.pendingEntryIds(session.id, "main", turn.id)).toEqual([secondId]);
    expect(raced).toBe(true);
    reader.db.prepare = original;
    expect(reader.pendingEntryIds(session.id, "main", turn.id)).toEqual([secondId]);

    // The header read itself establishes a snapshot. A writer committing after .get()
    // but before suffix/noted reads must not leak its newer rows into that snapshot.
    let afterHeader = false, thirdId = 0;
    reader.db.prepare = ((sql: string) => {
      const statement = original(sql);
      if (afterHeader || !sql.startsWith("SELECT length, tail_entry_id, version FROM source_paths")) return statement;
      return { ...statement, get: (...args: unknown[]) => {
        const header = statement.get(...args as Parameters<typeof statement.get>);
        afterHeader = true;
        const noted = writer.commitNotingRun({ run: { kind: "noting", sessionId: session.id, branch: "main", createdAt: at },
          facts: [], entryIds: [secondId] });
        if (!noted.ok) throw new Error(noted.problems.join("; "));
        thirdId = append("third").id;
        writer.appendSourcePath(session.id, "main", writer.sourcePathState(session.id, "main")!, [thirdId], turn.id, "native");
        return header;
      } };
    }) as typeof reader.db.prepare;
    try {
      expect(reader.pendingEntryIds(session.id, "main", turn.id)).toEqual([secondId]);
      expect(afterHeader).toBe(true);
    } finally { reader.db.prepare = original; }
    expect(reader.pendingEntryIds(session.id, "main", turn.id)).toEqual([thirdId]);
  } finally { reader.close(); writer.close(); rmSync(directory, { recursive: true, force: true }); }
});
