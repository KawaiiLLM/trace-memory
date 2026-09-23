// 77: usage columns land after `request` and `response` on `runs` (ALTER TABLE always appends), so an
// ordinary row read would still walk both overflow chains -- the exact cost this ticket removes.
// These tests pin that every read of the columns is answered by a covering index alone, using a
// direct range/equality condition rather than the `(? IS NULL OR …)` form, and that reading them
// scales with the runs the query actually matches, not with all of history.
import { expect, test, vi } from "vitest";
import { Store } from "../../../src/core/store/index.ts";

function seeded() {
  const store = new Store(":memory:");
  const project = store.createProject({ name: "usage", declaredBy: "mark" });
  const session = store.createSession({ host: "usage", projectId: project.id, enrollmentChoice: true, startedAt: "2026-09-09T00:00:00Z", firstReplyAt: "2026-09-09T00:00:00Z" });
  return { store, session };
}

test("77: listRunUsage is a direct session_id search on its covering index, never response/request", () => {
  const { store, session } = seeded();
  try {
    store.recordRun({ kind: "noting", sessionId: session.id, branch: "main", outcome: "success", createdAt: "2026-09-09T00:00:00Z",
      response: JSON.stringify({ usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: { total: 0.5 } } }) });
    const prepare = vi.spyOn(store.db, "prepare");
    const usage = store.listRunUsage(session.id);
    const queries = prepare.mock.calls.map(([sql]) => sql);
    prepare.mockRestore();
    expect(usage).toEqual([{ kind: "noting", usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5 } }]);
    expect(queries).toHaveLength(1);
    const [query] = queries;
    expect(query).not.toContain("IS NULL OR"); // a direct condition, not the optional-parameter form
    expect(query).not.toMatch(/\bresponse\b|\brequest\b/); // the audit bodies are never named
    expect(query).toContain("INDEXED BY idx_runs_session"); // 79: the covering idx_runs_session_usage is retired (item 0); the plain idx_runs_session (SCHEMA_SQL) answers this on a now-tiny row
    const plan = store.db.prepare(`EXPLAIN QUERY PLAN ${query}`).all(session.id) as { detail: string }[];
    expect(plan.map(row => row.detail).join("\n")).toMatch(/SEARCH runs USING INDEX idx_runs_session \(session_id=\?\)/);
  } finally { store.close(); }
});

test("77: spendSince is a direct created_at range search on its covering index, never response/request", () => {
  const { store, session } = seeded();
  try {
    store.recordRun({ kind: "noting", sessionId: session.id, branch: "main", outcome: "success", createdAt: "2026-09-09T00:00:00Z",
      response: JSON.stringify({ usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 1.25 } } }) });
    const prepare = vi.spyOn(store.db, "prepare");
    const cost = store.spendSince("2026-09-09T00:00:00Z");
    const queries = prepare.mock.calls.map(([sql]) => sql);
    prepare.mockRestore();
    expect(cost).toBe(1.25);
    expect(queries).toHaveLength(1);
    const [query] = queries;
    expect(query).not.toContain("IS NULL OR");
    expect(query).not.toMatch(/\bresponse\b|\brequest\b/);
    expect(query).toContain("INDEXED BY idx_runs_created_at"); // 79: the covering idx_runs_daily_usage is retired (item 0); a plain (created_at, id) index keeps the range search and id order without dodging any wide column
    const plan = store.db.prepare(`EXPLAIN QUERY PLAN ${query}`).all("2026-09-09T00:00:00Z") as { detail: string }[];
    const detail = plan.map(row => row.detail).join("\n");
    expect(detail).toMatch(/SEARCH runs USING INDEX idx_runs_created_at \(created_at>\?\)/);
    expect(detail).not.toMatch(/SCAN runs/); // never the whole table
  } finally { store.close(); }
});

test("77: spendSince's rows read grow with the day's runs, not with history", () => {
  const { store, session } = seeded();
  try {
    store.transaction(() => {
      for (let i = 0; i < 500; i++)
        store.recordRun({ kind: "noting", sessionId: session.id, branch: "main", outcome: "success", createdAt: "2020-01-01T00:00:00Z",
          response: JSON.stringify({ usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 1 } } }) });
      for (let i = 0; i < 3; i++)
        store.recordRun({ kind: "noting", sessionId: session.id, branch: "main", outcome: "success", createdAt: "2026-09-09T00:00:00Z",
          response: JSON.stringify({ usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 2 } } }) });
    });
    const all = vi.spyOn(store.db.prepare(`SELECT id, usage_cost FROM runs INDEXED BY idx_runs_created_at
      WHERE created_at >= ? ORDER BY id`).constructor.prototype, "all");
    const cost = store.spendSince("2026-09-09T00:00:00Z");
    const rowsRead = all.mock.results.flatMap(r => (Array.isArray(r.value) ? r.value.length : 0));
    all.mockRestore();
    expect(cost).toBe(6); // 3 recent runs at 2 each; the 500 old runs are outside the range
    expect(rowsRead.reduce((a, b) => a + b, 0)).toBe(3); // never touches the 500 old rows
  } finally { store.close(); }
});

test("77: derivation pinned — one usage_* column set per response shape", () => {
  const { store, session } = seeded();
  const run = (response: string | null) => store.recordRun({ kind: "noting", sessionId: session.id, branch: "main", outcome: "success", createdAt: "2026-09-09T00:00:00Z", response }).id;
  try {
    const cases: { name: string; response: string | null; usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number } | null }[] = [
      { name: "invalid JSON", response: "not json at all", usage: null },
      { name: "no usage key", response: JSON.stringify({ output: "x" }), usage: null },
      { name: "explicit null usage", response: JSON.stringify({ usage: null }), usage: null },
      { name: "non-object usage (boolean)", response: JSON.stringify({ usage: true }), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } },
      { name: "non-object usage (string that looks like JSON)", response: JSON.stringify({ usage: '{"input":999}' }), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } },
      { name: "booleans as 1/0", response: JSON.stringify({ usage: { input: true, output: false, cacheRead: 0, cacheWrite: 0, cost: { total: true } } }), usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: 1 } },
      { name: "missing fields default to 0", response: JSON.stringify({ usage: { input: 5 } }), usage: { input: 5, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } },
      { name: "cost.total absent", response: JSON.stringify({ usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } }), usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0 } },
      { name: "no response at all", response: null, usage: null },
    ];
    for (const { response } of cases) run(response);
    const results = store.listRunUsage(session.id);
    expect(results.map(r => r.usage)).toEqual(cases.map(c => c.usage));
  } finally { store.close(); }
});
