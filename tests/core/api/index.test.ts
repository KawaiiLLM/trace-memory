import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, TraceMemory, type TraceMemory as TraceMemoryHandle } from "../../source-fixture.ts";

let dir: string;
let dbPath: string;
let memory: TraceMemoryHandle;

const neverCalledRunAgent = async () => {
  throw new Error("runAgent should not be called by this ticket's skeleton");
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "trace-memory-api-"));
  dbPath = join(dir, "test.sqlite");
  memory = TraceMemory(dbPath, neverCalledRunAgent);
});

afterEach(() => {
  memory.close();
  rmSync(dir, { recursive: true, force: true });
});

test("opens a store at the given path and applies default config", () => {
  expect(memory.store).toBeDefined();
  expect(memory.config).toEqual(DEFAULT_CONFIG);
});

test("a partial config overrides only the sections given, keeping the rest default", () => {
  const dir2 = mkdtempSync(join(tmpdir(), "trace-memory-api-"));
  const other = TraceMemory(join(dir2, "t.sqlite"), neverCalledRunAgent, { consolidation: { subagentModeDefault: false, triggerTokens: 10 } });
  expect(other.config.consolidation).toEqual({ subagentModeDefault: false, triggerTokens: 10, batchTokens: 10_000, nearThreshold: 0.28, maxToolRounds: 0 });
  expect(other.config.render).toEqual(DEFAULT_CONFIG.render);
  expect(other.config.noting).toEqual(DEFAULT_CONFIG.noting);
  other.close();
  rmSync(dir2, { recursive: true, force: true });
});

test("read methods reject missing sessions and search an empty store", () => {
  expect(() => memory.compact(1)).toThrow("session S1 does not exist");
  expect(() => memory.inject(1)).toThrow("session S1 does not exist");
  expect(() => memory.trace("K1")).toThrow("knowledge K1 does not exist");
  expect(() => memory.status(1)).toThrow("session S1 does not exist");
  expect(memory.search("pnpm")).toContain("No hit does not mean absent");
});
