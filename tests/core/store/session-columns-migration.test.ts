import { expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../../src/core/store/index.ts";

// Ticket 108 removed the cache-miss latch: a database that still has its two session columns loses them.
test("opening a database with the retired cache-miss latch columns drops them and keeps the sessions", () => {
  const directory = mkdtempSync(join(tmpdir(), "tm-latch-")), path = join(directory, "trace.db");
  try {
    const first = new Store(path);
    const project = first.createProject({ name: "p", declaredBy: "mark" });
    const session = first.createSession({ host: "test", startedAt: "2026-09-09T00:00:00Z", firstReplyAt: "2026-09-09T00:00:00Z", projectId: project.id });
    first.db.exec("ALTER TABLE sessions ADD COLUMN fork_suppressed_at TEXT; ALTER TABLE sessions ADD COLUMN fork_suppressed_run INTEGER");
    first.db.prepare("UPDATE sessions SET fork_suppressed_at = '2026-09-09T00:00:00Z', fork_suppressed_run = 1 WHERE id = ?").run(session.id);
    first.close();
    const reopened = new Store(path);
    try {
      const columns = (reopened.db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map(c => c.name);
      expect(columns).not.toContain("fork_suppressed_at");
      expect(columns).not.toContain("fork_suppressed_run");
      expect(reopened.getSession(session.id)?.host).toBe("test");
    } finally { reopened.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
