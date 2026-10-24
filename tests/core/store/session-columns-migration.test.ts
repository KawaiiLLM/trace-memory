import { expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../../src/core/store/index.ts";
import { entry, session } from "../../support/seed.ts";

test("opening backfills only missing session roots from the earliest stored host cwd and preserves Raw", () => {
  const directory = mkdtempSync(join(tmpdir(), "tm-start-directory-")), path = join(directory, "trace.db");
  let store = new Store(path);
  try {
    const project = store.createProject({ name: "p", declaredBy: "mark" });
    const seed = (host: string, raws: string[], where = {}) => {
      const s = session(store, project.id, host, where);
      const turn = store.appendTurn({ sessionId: s.id, kind: "turn", userPrompt: "hello", startedAt: "2026-10-24T00:00:00Z" });
      raws.forEach((raw, index) => entry(store, s.id, turn.id, String(index), "user", "hello", raw));
      return s.id;
    };
    const cc = seed("cc:old", ["not JSON", '{"cwd":""}', '{"cwd":"relative"}', '{"cwd":"/gone/first"}', '{"cwd":"/gone/later"}']);
    const pi = seed("pi:recorded", ['{"type":"session","cwd":"/pi/start"}']);
    const missing = seed("pi:message-only", ['{"role":"user","content":"no cwd"}']);
    const rooted = seed("cc:rooted", ['{"cwd":"/other"}'], { directory: "/repository" });
    const started = seed("cc:started", ['{"cwd":"/other"}'], { startDirectory: "/recorded" });
    const raw = store.db.prepare("SELECT * FROM source_entry_raw ORDER BY entry_id").all();
    store.db.exec("PRAGMA user_version = 2");
    store.close(); store = new Store(path);
    expect(store.getSession(cc)?.startDirectory).toBe("/gone/first");
    expect(store.getSession(pi)?.startDirectory).toBe("/pi/start");
    expect(store.getSession(missing)?.startDirectory).toBeNull();
    expect(store.getSession(rooted)).toMatchObject({ directory: "/repository", startDirectory: null });
    expect(store.getSession(started)?.startDirectory).toBe("/recorded");
    expect(store.db.prepare("SELECT * FROM source_entry_raw ORDER BY entry_id").all()).toEqual(raw);
    store.db.prepare("UPDATE sessions SET start_directory = NULL WHERE id = ?").run(cc);
    store.close(); store = new Store(path);
    expect(store.getSession(cc)?.startDirectory).toBeNull();
    expect(store.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

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
