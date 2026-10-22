// Ticket 144 stage 4 §5.4: how Grep and Glob are confined to the directories verify may read (which directories: rulings.test.ts).
import { afterEach, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowedRoots, confineSearch, deniedPath, resolveRepositoryPath, SECRET_GLOB } from "../../../src/core/dreaming/roots.ts";
import { Store } from "../../../src/core/store/index.ts";
import { session } from "../../support/seed.ts";

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
});

test("a home directory root reads the home tree except the memory database, the Pi agent directory and secret files, in any letter case", () => {
  const home = tmp(); vi.stubEnv("HOME", home);
  try {
    for (const dir of [".trace-memory", ".pi/agent", ".ssh", "work"]) mkdirSync(join(home, dir), { recursive: true });
    for (const file of [".trace-memory/trace.db", ".pi/agent/auth.json", ".ssh/config", "work/.env", "work/.ENV.local", "work/server.key", "work/x.KEY", "work/notes.md"]) writeFileSync(join(home, file), "x");
    const store = new Store(":memory:");
    try {
      const roots = allowedRoots(store, session(store, store.createProject({ name: "p", declaredBy: "mark" }).id, "pi:x", { startDirectory: home }).id);
      expect(roots).toEqual([home]);
      expect(resolveRepositoryPath("work/notes.md", roots)).toEqual({ path: join(home, "work/notes.md") });
      for (const denied of [".trace-memory/trace.db", ".pi/agent/auth.json", ".ssh/config", ".SSH/config", ".Trace-Memory/trace.db", "work/.env", "work/.ENV.local", "work/server.key", "work/x.KEY"])
        expect(resolveRepositoryPath(denied, roots), denied).toHaveProperty("reason", expect.stringContaining("never read"));
    } finally { store.close(); }
  } finally { vi.unstubAllEnvs(); }
});

test("a protected directory that is a symbolic link into a root is still denied", () => {
  const home = tmp(), root = tmp(); vi.stubEnv("HOME", home);
  try {
    mkdirSync(join(root, "memory")); mkdirSync(join(root, "agent")); writeFileSync(join(root, "memory", "trace.db"), "x"); writeFileSync(join(root, "agent", "auth.json"), "x"); writeFileSync(join(root, "notes.md"), "x");
    mkdirSync(join(home, ".pi")); symlinkSync(join(root, "memory"), join(home, ".trace-memory")); symlinkSync(join(root, "agent"), join(home, ".pi", "agent"));
    for (const denied of ["memory/trace.db", "agent/auth.json"]) {
      expect(deniedPath(join(root, denied)), denied).toContain("never read");
      expect(resolveRepositoryPath(denied, [root]), denied).toHaveProperty("reason", expect.stringContaining("never read"));
    }
    expect(resolveRepositoryPath("notes.md", [root])).toEqual({ path: join(root, "notes.md") });
  } finally { vi.unstubAllEnvs(); }
});

// The effect of the Grep exclusion, not its text: real ripgrep over a fixture holding each kind of file.
const rg = ["/opt/homebrew/bin/rg", "rg"].find(candidate => { try { execFileSync(candidate, ["--version"], { stdio: "ignore" }); return true; } catch { return false; } });
test.skipIf(!rg)("the Grep exclusion hides secret files, secret directories and the protected trees from ripgrep, whatever their letter case", () => {
  const root = tmp();
  // Each name appears in one case only: macOS folds case, and a second spelling would only reopen the first file.
  const files = ["a/.ssh/config", "b/.SSH/config", "a/.trace-memory/trace.db", "b/.Trace-Memory/trace.db", "a/.pi/agent/auth.json", "b/.Pi/Agent/auth.json",
    "a/.env", "b/.ENV", "a/.env.local", "b/.Env.Prod", "a/x.key", "b/x.KEY", "a/credentials.json", "b/ID_RSA", "a/normal.md", "b/Normal.md"];
  for (const file of files) { mkdirSync(join(root, file, ".."), { recursive: true }); writeFileSync(join(root, file), "NEEDLE"); }
  const found = execFileSync(rg!, ["--hidden", "--glob", SECRET_GLOB, "--files-with-matches", "NEEDLE", root], { encoding: "utf8" }).split("\n").filter(Boolean).map(line => line.slice(root.length + 1));
  expect(found.sort()).toEqual(["a/normal.md", "b/Normal.md"]);
});
