// 62: a new session records the repository root (or cwd) it started in and joins the one project that
// directory already has; home and temporary directories are excluded; existing sessions are untouched.
import { afterEach, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../src/core/store/index.ts";
import { directoryAllocation, sessionDirectory, type DirectoryOptions } from "../../src/core/project/directory.ts";
import { resolveCcHostConfig } from "../../src/hosts/cc/config.ts";
import { recordSessionStart } from "../../src/hosts/cc/binding.ts";
import { CcImporter } from "../../src/hosts/cc/importer.ts";
import { host as createHost } from "./pi/test-host.ts";

// The fixtures live under the temporary directory, which the rule excludes. The hosts call
// `directoryAllocation` without options; this wrapper hands them the exclusions a case sets, so a
// fixture repository counts as an ordinary directory while the resolver itself stays untouched.
const injected = vi.hoisted(() => ({ excluded: undefined as DirectoryOptions["excluded"] }));
vi.mock("../../src/core/project/directory.ts", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/core/project/directory.ts")>();
  return { ...actual, directoryAllocation: (...args: Parameters<typeof actual.directoryAllocation>) =>
    actual.directoryAllocation(args[0], args[1], args[2], args[3] ?? { excluded: injected.excluded }) };
});

const disposers: (() => Promise<void> | void)[] = [];
afterEach(async () => { injected.excluded = undefined; for (const dispose of disposers.splice(0)) await dispose(); });
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
/** A repository with a linked worktree, plus a directory standing in for home; nothing here is excluded. */
function repository() {
  const base = mkdtempSync(join(tmpdir(), "tm-62-")); disposers.push(() => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, "repo"), worktree = join(base, "wt"), home = join(base, "home");
  mkdirSync(join(repo, "sub"), { recursive: true }); mkdirSync(home);
  git(repo, "init", "-q"); git(repo, "commit", "-q", "--allow-empty", "-m", "init"); git(repo, "worktree", "add", "-q", worktree, "HEAD");
  injected.excluded = { home: realpathSync(home), temporary: [] };
  return { base, repo, worktree, home, root: realpathSync(repo), options: { excluded: injected.excluded } };
}
function store() { const s = new Store(":memory:"); disposers.push(() => s.close()); return s; }
const at = "2026-01-01T00:00:00.000Z";
const session = (s: Store, host: string, allocation: Partial<Parameters<Store["createSession"]>[0]>) =>
  s.createSession({ host, startedAt: at, firstReplyAt: at, projectId: s.createProject({ name: host, declaredBy: "marker" }).id, projectDeclaration: "undeclared", ...allocation });
function pi(...args: Parameters<typeof createHost>) { const h = createHost(...args); disposers.push(h.dispose); return h; }

test("the key is the repository root for every worktree and subdirectory, else the real path of cwd", () => {
  const f = repository();
  for (const cwd of [f.repo, join(f.repo, "sub"), f.worktree, join(f.worktree, "sub")]) {
    mkdirSync(cwd, { recursive: true });
    expect(sessionDirectory(cwd, f.options)).toEqual({ directory: f.root });
  }
  const plain = join(f.base, "plain"); mkdirSync(plain);
  expect(sessionDirectory(plain, f.options)).toEqual({ directory: realpathSync(plain) });
  // A missing git executable — or any other failure of the runner — falls back to realpath(cwd).
  let calls = 0;
  const missing = (cwd: string): string => { calls++; throw Object.assign(new Error(`spawn git ENOENT in ${cwd}`), { code: "ENOENT" }); };
  expect(sessionDirectory(f.worktree, { ...f.options, git: missing })).toEqual({ directory: realpathSync(f.worktree) });
  expect(calls).toBe(1);
  // Git runs exactly once per allocation.
  calls = 0;
  directoryAllocation(store(), f.repo, () => 1, { ...f.options, git: cwd => { calls++; return git(cwd, "rev-parse", "--git-common-dir"); } });
  expect(calls).toBe(1);
  // A cwd that no longer exists is excluded rather than failing the allocation.
  expect(sessionDirectory(join(f.base, "gone"), f.options)).toEqual({ excluded: true });
});

test("the home directory and temporary directories are never keys", () => {
  const f = repository();
  expect(sessionDirectory(f.home, f.options)).toEqual({ excluded: true });
  // Default exclusions: the real home, /tmp, /private/tmp and $TMPDIR (the fixture root itself).
  injected.excluded = undefined; // the hosts' wrapper above must not stand in for the defaults here
  expect(sessionDirectory(homedir())).toEqual({ excluded: true });
  expect(sessionDirectory(f.repo)).toEqual({ excluded: true });
  expect(sessionDirectory(tmpdir())).toEqual({ excluded: true });
  const slashTmp = mkdtempSync("/tmp/tm-62-"); disposers.push(() => rmSync(slashTmp, { recursive: true, force: true }));
  git(slashTmp, "init", "-q");
  expect(sessionDirectory(slashTmp)).toEqual({ excluded: true });
  expect(directoryAllocation(store(), slashTmp, () => 7)).toEqual({ projectId: 7, projectDeclaration: "undeclared", directory: null });
  // A home subdirectory outside any repository is an ordinary key: only home itself is excluded.
  const documents = join(f.home, "documents"); mkdirSync(documents);
  expect(sessionDirectory(documents, f.options)).toEqual({ directory: realpathSync(documents) });
});

test("store: one recorded project joins, none or several allocate the own project, merges are followed, NULL counts for nothing", () => {
  const s = store(), f = repository();
  const own = () => s.createProject({ name: `own:${Math.random()}`, declaredBy: "marker" }).id;
  // Sessions from before the column exist without a directory and never count.
  const legacy = session(s, "pi:legacy", { directory: null });
  expect(legacy.directory).toBeNull();
  expect(s.directoryProjects(f.root)).toEqual([]);
  const first = directoryAllocation(s, f.repo, own, f.options);
  expect(first).toMatchObject({ projectDeclaration: "undeclared", directory: f.root });
  const a = session(s, "pi:a", first);
  expect(s.getSession(a.id)!.directory).toBe(f.root);
  expect(directoryAllocation(s, f.worktree, own, f.options)).toEqual({ projectId: a.projectId, projectDeclaration: "marker", directory: f.root });
  // A second project in the same directory (a session marked elsewhere) makes it ambiguous.
  const b = session(s, "pi:b", { projectId: a.projectId, projectDeclaration: "marker", directory: f.root, enrollmentChoice: true });
  const turn = s.appendTurn({ sessionId: b.id, kind: "turn", userPrompt: "source", startedAt: at });
  const entry = s.appendSourceEntry({ sessionId: b.id, turnId: turn.id, nativeLineage: "b", nativeId: "user",
    role: "user", text: "source", raw: "{}", calls: [] });
  s.selectSourcePath(b.id, "main", [entry.id]);
  const noted = s.commitNotingRun({ run: { kind: "manual", sessionId: b.id, createdAt: at }, facts: [], entryIds: [entry.id] });
  expect(noted.ok).toBe(true);
  const path = { sessionId: b.id, branch: "main", headTurnId: turn.id };
  const other = s.declareProject(b.id, "other", "mark", { path, atTrigger: phase => phase === "noting"
    ? s.pendingEntryIds(b.id, path.branch, path.headTurnId).length > 0
    : phase === "consolidation" ? s.consolidationBatch(b.id, path.branch, path.headTurnId).length > 0
      : s.duePools(path, 1).length > 0 });
  expect(new Set(s.directoryProjects(f.root))).toEqual(new Set([a.projectId, other.id]));
  const third = directoryAllocation(s, f.repo, own, f.options);
  expect(third).toMatchObject({ projectDeclaration: "undeclared", directory: f.root });
  expect(third.projectId).not.toBe(a.projectId); expect(third.projectId).not.toBe(other.id);
  // Merging the two resolves it; the merged project is followed to the survivor.
  s.mergeProject(other.id, a.projectId);
  expect(s.directoryProjects(f.root)).toEqual([a.projectId]);
  expect(directoryAllocation(s, f.worktree, own, f.options)).toEqual({ projectId: a.projectId, projectDeclaration: "marker", directory: f.root });
  expect(s.getSession(legacy.id)).toEqual(legacy); // never re-attributed
});

test("store: opening an existing database adds sessions.directory without touching other rows", () => {
  const dir = mkdtempSync(join(tmpdir(), "tm-62-db-")); disposers.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "trace.db");
  const before = new Store(path);
  const legacy = session(before, "pi:legacy", {});
  before.db.exec("ALTER TABLE sessions DROP COLUMN directory"); // the pre-62 shape
  expect(before.db.prepare("PRAGMA table_info(sessions)").all().some(row => row.name === "directory")).toBe(false);
  before.close();
  const after = new Store(path); disposers.push(() => after.close());
  expect(after.db.prepare("PRAGMA table_info(sessions)").all().some(row => row.name === "directory")).toBe(true);
  expect(after.getSession(legacy.id)).toEqual({ ...legacy, directory: null });
  expect(after.db.prepare("SELECT count(*) AS n FROM sessions").get()).toEqual({ n: 1 });
});

test("Pi: the first session in a repository owns its project and records the directory; a worktree session joins it; home records nothing", async () => {
  const f = repository(), h = pi();
  h.ctx.cwd = f.repo;
  await h.turn();
  const first = h.memory.store.getSession(1)!;
  expect(first.directory).toBe(f.root);
  expect(h.memory.store.projectDeclaration(1)).toBe("undeclared");
  h.entries.length = 0; h.ctx.sessionManager.getSessionId = () => "worktree-session"; h.ctx.cwd = f.worktree;
  await h.emit("session_start"); await h.turn();
  const second = h.memory.store.getSession(2)!;
  const worktreeEntries = [...h.entries];
  expect(second).toMatchObject({ projectId: first.projectId, directory: f.root });
  expect(h.memory.store.projectDeclaration(2)).toBe("marker");
  expect(h.entries.at(-1).data.projectId).toBe(first.projectId);
  h.entries.length = 0; h.ctx.sessionManager.getSessionId = () => "home-session"; h.ctx.cwd = f.home;
  await h.emit("session_start"); await h.turn();
  const third = h.memory.store.getSession(3)!;
  expect(third.directory).toBeNull();
  expect(third.projectId).not.toBe(first.projectId);
  expect(h.memory.store.projectDeclaration(3)).toBe("undeclared");
  expect(h.memory.store.getProject(third.projectId)!.name).toBe("pi:home-session");
  // `project <name>` still wins, and a resume never re-applies the directory to the moved session.
  h.entries.splice(0, h.entries.length, ...worktreeEntries);
  h.ctx.sessionManager.getSessionId = () => "worktree-session"; h.ctx.cwd = f.worktree;
  await h.emit("session_start");
  await h.commands.get("trace").handler("project elsewhere", h.ctx);
  const moved = h.memory.store.getSession(2)!;
  expect(h.memory.store.getProject(moved.projectId)!.name).toBe("elsewhere");
  expect(h.memory.store.projectDeclaration(2)).toBe("mark");
  expect(moved.directory).toBe(f.root);
  const beforeCursor = h.memory.store.db.prepare("SELECT lineage, branch, head_turn_id FROM session_lineage_cursors WHERE session_id = 2").all();
  await h.emit("session_start"); await h.turn();
  const resumed = h.memory.store.getSession(2)!;
  expect(resumed).toEqual(moved);
  expect(h.memory.store.db.prepare("SELECT lineage, branch, head_turn_id FROM session_lineage_cursors WHERE session_id = 2").all())
    .not.toEqual(beforeCursor);
  expect(h.memory.store.getSession(1)).toEqual(first); // the peer did not move
  // The directory now has two projects: the next session is its own project and still records the directory.
  h.entries.length = 0; h.ctx.sessionManager.getSessionId = () => "ambiguous-session"; h.ctx.cwd = join(f.repo, "sub");
  await h.emit("session_start"); await h.turn();
  const fourth = h.memory.store.getSession(4)!;
  expect(fourth.directory).toBe(f.root);
  expect([first.projectId, moved.projectId]).not.toContain(fourth.projectId);
  expect(h.memory.store.projectDeclaration(4)).toBe("undeclared");
  expect(h.requests).toEqual([]);
});

test("Pi: a cwd under the temporary directory allocates the own project and records no directory", async () => {
  const h = pi(); // h.ctx.cwd is the fixture directory under $TMPDIR; default exclusions apply
  git(h.dir, "init", "-q");
  await h.turn();
  expect(h.memory.store.getSession(1)!.directory).toBeNull();
  expect(h.memory.store.projectDeclaration(1)).toBe("undeclared");
  expect(h.memory.store.getProject(h.memory.store.getSession(1)!.projectId)!.name).toBe("pi:pi-test");
});

async function ccImporter(dbPath: string, nativeSessionId: string, cwd?: string) {
  const dir = mkdtempSync(join(tmpdir(), "tm-62-cc-")); disposers.push(() => rmSync(dir, { recursive: true, force: true }));
  const transcriptPath = join(dir, "native.jsonl");
  const records = [
    { uuid: "u1", parentUuid: null, type: "user", timestamp: at, promptId: "p1", promptSource: "sdk", userType: "external", message: { role: "user", content: "first" } },
    { uuid: "a1", parentUuid: "u1", type: "assistant", timestamp: "2026-01-01T00:00:01.000Z", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "answer" }] } },
  ];
  writeFileSync(transcriptPath, records.map(record => `${JSON.stringify(record)}\n`).join(""));
  const config = resolveCcHostConfig({ dbPath, stateDir: join(dir, "state"), baseline: "2025-01-01T00:00:00.000Z" });
  const binding = await recordSessionStart(config, { hook_event_name: "SessionStart", session_id: nativeSessionId, transcript_path: transcriptPath,
    ...(cwd === undefined ? {} : { cwd }) }, at);
  const importer = new CcImporter(config, binding); disposers.push(() => importer.close());
  return { binding, importer };
}

test("CC: a SessionStart hook with cwd in a repository that has one Pi session joins it; a hook without cwd owns its project", async () => {
  const f = repository();
  const dir = mkdtempSync(join(tmpdir(), "tm-62-shared-")); disposers.push(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "trace.db"), shared = new Store(dbPath);
  const piSession = session(shared, "pi:existing", directoryAllocation(shared, f.repo, () => shared.createProject({ name: "pi:existing", declaredBy: "marker" }).id, f.options));
  shared.close();
  const joined = await ccImporter(dbPath, "cc-in-worktree", f.worktree);
  expect(joined.binding.cwd).toBe(f.worktree);
  const result = await joined.importer.reconcile();
  expect(result.state).toBe("ready");
  const ccSession = joined.importer.memory.store.getSession(result.coreSessionId!)!;
  expect(ccSession).toMatchObject({ host: "cc:cc-in-worktree", projectId: piSession.projectId, directory: f.root });
  expect(joined.importer.memory.store.projectDeclaration(ccSession.id)).toBe("marker");
  expect(joined.importer.currentBinding().projectId).toBe(piSession.projectId);
  const bare = await ccImporter(dbPath, "cc-no-cwd");
  expect(bare.binding.cwd).toBeUndefined();
  const bareResult = await bare.importer.reconcile();
  const bareSession = bare.importer.memory.store.getSession(bareResult.coreSessionId!)!;
  expect(bareSession.directory).toBeNull();
  expect(bareSession.projectId).not.toBe(piSession.projectId);
  expect(bare.importer.memory.store.getProject(bareSession.projectId)!.name).toBe("cc:cc-no-cwd");
  expect(bare.importer.memory.store.projectDeclaration(bareSession.id)).toBe("undeclared");
});
