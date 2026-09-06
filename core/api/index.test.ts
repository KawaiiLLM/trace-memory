import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, NotImplementedError, TraceMemory, type TraceMemory as TraceMemoryHandle } from "./index";

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
  const other = TraceMemory(join(dir2, "t.sqlite"), neverCalledRunAgent, { settle: { subagentModeDefault: false, triggerUnsettledFacts: 10 } });
  expect(other.config.settle).toEqual({ subagentModeDefault: false, triggerUnsettledFacts: 10, nearThreshold: 0.28 });
  expect(other.config.render).toEqual(DEFAULT_CONFIG.render);
  expect(other.config.note).toEqual(DEFAULT_CONFIG.note);
  other.close();
  rmSync(dir2, { recursive: true, force: true });
});

describe("methods not yet implemented in this ticket", () => {
  test("settle rejects a missing session", async () => {
    await expect(memory.settle({ sessionId: 1, branch: "main" })).rejects.toThrow("session S1 does not exist");
  });
  test("compact throws NotImplementedError", () => {
    expect(() => memory.compact({})).toThrow(NotImplementedError);
  });
  test("inject throws NotImplementedError", () => {
    expect(() => memory.inject({})).toThrow(NotImplementedError);
  });
  test("trace reports a missing entry", () => {
    expect(() => memory.trace("E1")).toThrow("entry E1 does not exist");
  });
  test("search throws NotImplementedError", () => {
    expect(() => memory.search("pnpm")).toThrow(NotImplementedError);
  });
  test("mark throws NotImplementedError", () => {
    expect(() => memory.mark({})).toThrow(NotImplementedError);
  });
  test("status throws NotImplementedError", () => {
    expect(() => memory.status(1)).toThrow(NotImplementedError);
  });
});
