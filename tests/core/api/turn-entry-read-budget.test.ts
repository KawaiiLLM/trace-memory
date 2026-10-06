// 79 acceptance, item 2 (Pi review of 5ee34b5): "Exact entry reads hydrate the whole Turn" --
// Exact `T<n>#E1` rendering used to hydrate every occurrence of the Turn before picking the one requested
// ordinal. This pins the fix on a Turn with thousands of entries: an exact ordinal read hydrates
// only that one row.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { countHydratedRows } from "../../perf/fixture.ts";
import { Store } from "../../../src/core/store/index.ts";
import { TraceMemory, memoryFiles } from "../../../src/core/api/index.ts";

const branch = "main";
let dir: string, dbPath: string, sessionId: number, turnId: number;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "trace-memory-79-turn-budget-"));
  dbPath = join(dir, "turn.db");
  const store = new Store(dbPath);
  const project = store.createProject({ name: "turn-budget", declaredBy: "mark" });
  const session = store.createSession({ enrollmentChoice: true, host: "fixture", projectId: project.id, startedAt: "t", firstReplyAt: "t" });
  sessionId = session.id;
  const turn = store.appendTurn({ sessionId, kind: "turn", startedAt: "t", userPrompt: "one big turn" });
  turnId = turn.id;
  const ids: number[] = [];
  for (let i = 0; i < 2_000; i++) {
    const entry = store.appendSourceEntry({ sessionId, nativeLineage: "fx", nativeId: `m${i}`, turnId,
      role: "user", text: `entry ${i} ${"word ".repeat(20)}`, raw: `raw ${i}`, calls: [] });
    ids.push(entry.id);
  }
  store.selectSourcePath(sessionId, branch, ids);
  store.close();
}, 60_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("79/118: exact trace:// entry on a 2,000-entry Turn hydrates one row", () => {
  const memory = TraceMemory(dbPath, async () => { throw new Error("no model in this test"); });
  const counter = countHydratedRows();
  try {
    const files = memoryFiles(memory, { sessionId, branch, headTurnId: turnId });
    counter.reset();
    const result = files.read(`trace://raw/S${sessionId}/T${turnId}#E1`).content;
    expect(result).toContain("entry 0");
    expect(counter.reads()).toBe(1);
  } finally { memory.close(); counter.restore(); }
});

// Ticket 118 rulings 6/7 remove public event-range reads; the exact-entry locality bound stays above.
