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
      // The signal has already been read. A second connection commits both operations before
      // the reader queries the path header: there was never a state with both entries pending.
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
    expect(reader.pendingEntryIds(session.id, "main", turn.id)).toEqual([first.id]);
    expect(raced).toBe(true);
    reader.db.prepare = original;
    expect(reader.pendingEntryIds(session.id, "main", turn.id)).toEqual([secondId]);
  } finally { reader.close(); writer.close(); rmSync(directory, { recursive: true, force: true }); }
});
