// Ticket 144 stage 4 §5.4: how Grep and Glob are confined to the directories verify may read (which directories: rulings.test.ts).
import { afterEach, expect, test, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowedRoots, confineSearch, resolveRepositoryPath, SECRET_GLOB } from "../../../src/core/dreaming/roots.ts";
import { Store } from "../../../src/core/store/index.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tmp = () => { const dir = realpathSync(mkdtempSync(join(tmpdir(), "tm-144-roots-"))); dirs.push(dir); return dir; };

test("a Grep or Glob call must name a directory inside a root; a Grep never searches the secret files and takes no glob of its own", () => {
  const root = tmp(), outside = tmp();
  mkdirSync(join(root, "src")); writeFileSync(join(root, "src", "a.ts"), "x");
  expect(confineSearch({ path: root }, [root], "grep")).toEqual({ path: root, glob: SECRET_GLOB });
  expect(confineSearch({ path: join(root, "src"), pattern: "**/*.ts" }, [root], "glob")).toEqual({ path: join(root, "src") });
  expect(() => confineSearch({ path: root, glob: "*.ts" }, [root], "grep")).toThrow("narrow the search with path");
  expect(() => confineSearch({ path: outside }, [root], "grep")).toThrow("outside the repositories you may read");
  expect(() => confineSearch({}, [root], "grep")).toThrow("name an absolute directory");
  expect(() => confineSearch({ path: "src" }, [root], "grep")).toThrow("name an absolute directory");
  expect(() => confineSearch({ path: root, pattern: "../*" }, [root], "glob")).toThrow("stay inside path");
  expect(() => confineSearch({ path: root, pattern: "/etc/*" }, [root], "glob")).toThrow("stay inside path");
  expect(() => confineSearch({ path: root }, [], "grep")).toThrow("during curate and verify only");
  expect(SECRET_GLOB).toContain(".env");
});

const at = "2026-10-23T00:00:00Z";

// 148: a session's root is its repository directory, else the directory it started in; the home directory may be a root.
test("allowedRoots: directory first, the start directory as fallback, nothing for another project or a vanished directory", () => {
  const base = tmp(), [repo, started, shadowed, stranger] = ["repo", "started", "shadowed", "stranger"].map(name => { mkdirSync(join(base, name)); return join(base, name); }) as [string, string, string, string];
  const store = new Store(":memory:");
  try {
    const project = store.createProject({ name: "p", declaredBy: "mark" }).id, otherProject = store.createProject({ name: "q", declaredBy: "mark" }).id;
    const open = (projectId: number, directory: string | null, startDirectory: string | null) =>
      store.createSession({ host: "pi:x", startedAt: at, firstReplyAt: at, projectId, directory, startDirectory });
    const first = open(project, repo, join(repo, "sub-not-used")); // directory wins over the start directory
    open(project, null, started); open(project, shadowed, null); open(project, null, join(base, "gone")); open(project, null, null);
    open(otherProject, null, stranger);
    expect(allowedRoots(store, first.id)).toEqual([repo, started, shadowed].sort());
  } finally { store.close(); }
});

test("a home directory root reads the home tree except the memory database, the Pi agent directory and secret files", () => {
  const home = tmp(); vi.stubEnv("HOME", home);
  try {
    for (const dir of [".trace-memory", ".pi/agent", ".ssh", "work"]) mkdirSync(join(home, dir), { recursive: true });
    for (const file of [".trace-memory/trace.db", ".pi/agent/auth.json", ".ssh/config", "work/.env", "work/server.key", "work/notes.md"]) writeFileSync(join(home, file), "x");
    const store = new Store(":memory:");
    try {
      const session = store.createSession({ host: "pi:x", startedAt: at, firstReplyAt: at, projectId: store.createProject({ name: "p", declaredBy: "mark" }).id, startDirectory: home });
      const roots = allowedRoots(store, session.id);
      expect(roots).toEqual([home]);
      expect(resolveRepositoryPath("work/notes.md", roots)).toEqual({ path: join(home, "work/notes.md") });
      for (const denied of [".trace-memory/trace.db", ".pi/agent/auth.json", ".ssh/config", "work/.env", "work/server.key"])
        expect(resolveRepositoryPath(denied, roots), denied).toHaveProperty("reason", expect.stringContaining("never read"));
    } finally { store.close(); }
    // A Grep rooted at home skips the same trees: the exclusion names them.
    expect(confineSearch({ path: home }, [home], "grep").glob).toMatch(/\.trace-memory\/\*\*.*\.pi\/agent\/\*\*/);
  } finally { vi.unstubAllEnvs(); }
});
