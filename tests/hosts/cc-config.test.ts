import { afterEach, expect, test, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Store } from "../../src/core/store/index.ts";
import { resolveCcHostConfig, type CcHostConfig } from "../../src/hosts/cc/config.ts";
import { handleCcHook } from "../../src/hosts/cc/index.ts";

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "tm-cc-home-")); directories.push(home);
  vi.stubEnv("HOME", home);
  const input = { stateDir: join(home, "separate-cc-state") };
  const dbPath = join(home, ".trace-memory", "trace.db");
  const config = resolveCcHostConfig(input);
  // Assert isolation before any database open; never let a default-path test reach the real home.
  expect(config.dbPath).toBe(dbPath);
  const hook = { hook_event_name: "SessionStart" as const, source: "startup" as const,
    session_id: "shared-default", transcript_path: join(home, "not-created-yet.jsonl") };
  return { home, input, config, dbPath, hook };
}

test("CC omits dbPath to use Pi's default without eagerly opening a database", () => {
  const f = fixture();
  expect(existsSync(dirname(f.dbPath))).toBe(false);
  const explicit = join(f.home, "another.sqlite");
  expect(resolveCcHostConfig({ ...f.input, dbPath: explicit }).dbPath).toBe(explicit);
  expect(existsSync(explicit)).toBe(false);
});

test("first CC startup creates an absent shared default database and its parent", async () => {
  const f = fixture();
  expect(existsSync(f.dbPath)).toBe(false);
  await expect(handleCcHook(f.input, f.hook)).resolves.toBeNull();
  expect(existsSync(f.dbPath)).toBe(true);
  const store = new Store(f.dbPath);
  try { expect(store.db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" }); }
  finally { store.close(); }
});

test("CC reuses the existing Pi-default database in place without resetting its records", async () => {
  const f = fixture(); mkdirSync(dirname(f.dbPath), { recursive: true });
  const original = new Store(f.dbPath);
  let projectId: number;
  try {
    projectId = original.createProject({ name: "existing-pi-project", declaredBy: "mark" }).id;
    original.db.exec("CREATE TABLE installation_sentinel (value TEXT); INSERT INTO installation_sentinel VALUES ('retain-existing-data')");
  } finally { original.close(); }
  const inode = statSync(f.dbPath).ino;
  await expect(handleCcHook(f.input, f.hook)).resolves.toBeNull();
  expect(statSync(f.dbPath).ino).toBe(inode);
  const reopened = new Store(f.dbPath);
  try {
    expect(reopened.getProject(projectId!)?.name).toBe("existing-pi-project");
    expect(reopened.db.prepare("SELECT value FROM installation_sentinel").get()).toEqual({ value: "retain-existing-data" });
  } finally { reopened.close(); }
});

test("an invalid existing database fails instead of being replaced with an empty one", async () => {
  const f = fixture(); mkdirSync(dirname(f.dbPath), { recursive: true });
  const contents = "not a database; must not replace";
  writeFileSync(f.dbPath, contents);
  await expect(handleCcHook(f.input, f.hook)).rejects.toThrow();
  expect(readFileSync(f.dbPath, "utf8")).toBe(contents);
});

test.each([null, "", "relative.sqlite"])("an explicit invalid database path %j does not fall back to the shared default", dbPath => {
  const f = fixture();
  expect(() => resolveCcHostConfig({ ...f.input, dbPath } as CcHostConfig)).toThrow(/dbPath|absolute/);
  expect(existsSync(f.dbPath)).toBe(false);
});
