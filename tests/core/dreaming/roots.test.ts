// Ticket 144 stage 4 §5.4: how Grep and Glob are confined to the directories verify may read (which directories: rulings.test.ts).
import { afterEach, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confineSearch, SECRET_GLOB } from "../../../src/core/dreaming/roots.ts";

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
  expect(() => confineSearch({ path: root }, [], "grep")).toThrow("during verify only");
  expect(SECRET_GLOB).toContain(".env");
});
