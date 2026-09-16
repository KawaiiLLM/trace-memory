import { afterEach, expect, test } from "vitest";
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../../src/core/store/index.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function seed(path: string) {
  const store = new Store(path);
  const project = store.createProject({ name: "audit", declaredBy: "mark" });
  const session = store.createSession({ host: "test", projectId: project.id, enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
  const turn = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "audit", startedAt: "now" });
  const entry = store.appendSourceEntry({ sessionId: session.id, turnId: turn.id, nativeLineage: "test", nativeId: "root",
    role: "user", text: "audit", raw: "{}", calls: [] });
  store.selectSourcePath(session.id, "main", [entry.id]);
  store.db.exec("CREATE TABLE audit_sentinel(value TEXT NOT NULL); INSERT INTO audit_sentinel VALUES ('source-intact')");
  store.close();
}

function run(source: string, auditDir: string, sessionId = 1) {
  return spawnSync(process.execPath, [resolve("tests/scripts/ticket-47-owner-pools.ts"), `--db=${source}`, `--session=${sessionId}`, `--audit-dir=${auditDir}`], {
    cwd: resolve("."), encoding: "utf8",
  });
}

function sentinel(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return String(db.prepare("SELECT value FROM audit_sentinel").get()!.value); }
  finally { db.close(); }
}

test("47 audit owns a unique temporary copy and preserves caller files", () => {
  const dir = mkdtempSync(join(tmpdir(), "tm-47-audit-")); dirs.push(dir);
  const source = join(dir, "source.sqlite");
  const auditDir = join(dir, "audit");
  seed(source);
  mkdirSync(auditDir);
  const preexisting = join(auditDir, "working-copy.sqlite");
  writeFileSync(preexisting, "caller-owned");

  const result = run(source, auditDir);
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).source).toBe(source);
  expect(sentinel(source)).toBe("source-intact");
  expect(readFileSync(preexisting, "utf8")).toBe("caller-owned");
  expect(readdirSync(auditDir)).toEqual(["working-copy.sqlite"]);
});

test("47 audit does not delete a source named like the former working copy", () => {
  const dir = mkdtempSync(join(tmpdir(), "tm-47-audit-collision-")); dirs.push(dir);
  const source = join(dir, "working-copy.sqlite");
  seed(source);

  const result = run(source, dir);
  expect(result.status, result.stderr).toBe(0);
  expect(sentinel(source)).toBe("source-intact");
});

test("47 audit preserves a caller-owned working-copy symlink that aliases its source", () => {
  const dir = mkdtempSync(join(tmpdir(), "tm-47-audit-alias-")); dirs.push(dir);
  const source = join(dir, "source.sqlite"), auditDir = join(dir, "audit");
  seed(source);
  mkdirSync(auditDir);
  const alias = join(auditDir, "working-copy.sqlite");
  symlinkSync(source, alias);

  const result = run(alias, auditDir);
  expect(result.status, result.stderr).toBe(0);
  expect(lstatSync(alias).isSymbolicLink()).toBe(true);
  expect(readlinkSync(alias)).toBe(source);
  expect(sentinel(source)).toBe("source-intact");
  expect(readdirSync(auditDir)).toEqual(["working-copy.sqlite"]);
});

test("47 audit removes its unique copy after an audit failure without touching caller files", () => {
  const dir = mkdtempSync(join(tmpdir(), "tm-47-audit-failure-")); dirs.push(dir);
  const source = join(dir, "source.sqlite"), auditDir = join(dir, "audit");
  seed(source);
  mkdirSync(auditDir);
  const preexisting = join(auditDir, "working-copy.sqlite");
  writeFileSync(preexisting, "caller-owned");

  const result = run(source, auditDir, 99);
  expect(result.status).not.toBe(0);
  expect(sentinel(source)).toBe("source-intact");
  expect(readFileSync(preexisting, "utf8")).toBe("caller-owned");
  expect(readdirSync(auditDir)).toEqual(["working-copy.sqlite"]);
});
