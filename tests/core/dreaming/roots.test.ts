// Ticket 144 stage 4 §5.4 (PENDING Q3): which directories verify may read and how Grep and Glob are confined to them.
import { afterEach, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowedRoots, confineSearch, SECRET_GLOB } from "../../../src/core/dreaming/roots.ts";
import { workspaceBatch, type WorkspaceBatch } from "../../support/workspace.ts";

const opened: WorkspaceBatch[] = [];
const dirs: string[] = [];
afterEach(() => { for (const b of opened.splice(0)) b.memory.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tmp = () => { const dir = realpathSync(mkdtempSync(join(tmpdir(), "tm-144-roots-"))); dirs.push(dir); return dir; };

test("the roots are the directories of the project's sessions; another project's directory and a session without one add nothing", () => {
  const b = workspaceBatch(); opened.push(b);
  const [one, two, other] = [tmp(), tmp(), tmp()];
  const sibling = b.store.createSession({ projectId: b.project.id, host: "pi:workspace", enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
  const stranger = b.store.createSession({ projectId: b.store.createProject({ name: "other", declaredBy: "mark" }).id, host: "pi:workspace", enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
  const set = b.store.db.prepare("UPDATE sessions SET directory = ? WHERE id = ?");
  set.run(one, b.session.id); set.run(two, sibling.id); set.run(other, stranger.id);
  expect(allowedRoots(b.store, b.session.id)).toEqual([one, two].sort());
  set.run(join(one, "gone"), b.session.id); // a directory that no longer exists cannot be read
  expect(allowedRoots(b.store, b.session.id)).toEqual([two]);
});

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
  expect(() => confineSearch({ path: root }, [], "grep")).toThrow("during verify only");
  expect(SECRET_GLOB).toContain(".env");
});
