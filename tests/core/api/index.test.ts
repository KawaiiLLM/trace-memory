import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, seedSourceEntry, sourceSeededMemory, type TraceMemory as TraceMemoryHandle } from "../../source-fixture.ts";
import { TraceMemory as coreTraceMemory, validateConfig, type ConfigOverride } from "../../../src/core/api/index.ts";

let dir: string;
let dbPath: string;
let memory: TraceMemoryHandle;

const neverCalledRunAgent = async () => {
  throw new Error("runAgent should not be called by this ticket's skeleton");
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "trace-memory-api-"));
  dbPath = join(dir, "test.sqlite");
  memory = sourceSeededMemory(dbPath, neverCalledRunAgent);
});

afterEach(() => {
  memory.close();
  rmSync(dir, { recursive: true, force: true });
});

test("opens a store at the given path and applies default config", () => {
  expect(memory.store).toBeDefined();
  expect(memory.config).toEqual(DEFAULT_CONFIG);
  expect(DEFAULT_CONFIG.noting.forkModeDefault).toBe(false);
  expect(DEFAULT_CONFIG.consolidation.forkModeDefault).toBe(false);
});

test.each([
  [{}, false, false],
  [{ noting: { forkModeDefault: true } }, true, false],
  [{ consolidation: { forkModeDefault: true } }, false, true],
  [{ noting: { branchModeDefault: true } }, true, false],
  [{ noting: { forkModeDefault: false }, consolidation: { forkModeDefault: true } }, false, true],
] satisfies [ConfigOverride, boolean, boolean][])("mode defaults apply only to omitted configuration (%j)", (override, noting, consolidation) => {
  const before = structuredClone(override);
  const config = validateConfig(override);
  expect(config.noting.forkModeDefault).toBe(noting);
  expect(config.consolidation.forkModeDefault).toBe(consolidation);
  expect(config.noting).not.toHaveProperty("branchModeDefault");
  expect(override).toEqual(before);
});

test("a partial config overrides only the sections given, keeping the rest default", () => {
  const dir2 = mkdtempSync(join(tmpdir(), "trace-memory-api-"));
  const other = sourceSeededMemory(join(dir2, "t.sqlite"), neverCalledRunAgent, { consolidation: { triggerTokens: 10 } });
  expect(other.config.consolidation).toEqual({ forkModeDefault: false, triggerTokens: 10, batchTokens: 10_000, maxToolRounds: 0 });
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

test("the source fixture seeds completed entries; the production facade appending a Turn does not", () => {
  const seed = (m: TraceMemoryHandle) => {
    const project = m.store.createProject({ name: "p", declaredBy: "mark" });
    const session = m.store.createSession({ enrollmentChoice: true, host: "fake", projectId: project.id, startedAt: "now", firstReplyAt: "now" });
    const turn = m.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "prompt", assistantText: "reply", startedAt: "now" });
    return { sessionId: session.id, turnId: turn.id };
  };
  const wrapped = seed(memory);
  // The fixture's wrapper writes the completed user and assistant messages a host would have imported.
  expect(memory.store.listSourceEntries(wrapped.sessionId).map(e => e.role)).toEqual(["user", "assistant"]);

  const plain = coreTraceMemory(":memory:", neverCalledRunAgent);
  try {
    const bare = seed(plain);
    // Production does not: appending a Turn is not enough to make pending-entry discovery see one.
    expect(plain.store.listSourceEntries(bare.sessionId)).toEqual([]);
    // The seeding is an operation with a name, callable on its own.
    seedSourceEntry(plain, bare.turnId, "user", "prompt");
    expect(plain.store.listSourceEntries(bare.sessionId).map(e => e.role)).toEqual(["user"]);
  } finally { plain.close(); }
});
