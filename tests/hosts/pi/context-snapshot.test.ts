import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventBus, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect, test, vi } from "vitest";
import { requestCurrentContextSnapshot, CURRENT_CONTEXT_SNAPSHOT_EVENT,
  type CurrentContextSnapshotResult } from "../../../src/hosts/pi/context-snapshot.ts";
import { call, fixture, piSession, say, toolResults } from "./native-fixture.ts";
import extension from "../../../src/hosts/pi/index.ts";
import { host } from "./test-host.ts";
import { tokens } from "../../../src/core/api/index.ts";

const quiet = { "noting.triggerTokens": 1_000_000_000, "consolidation.triggerTokens": 1_000_000_000 };

function request(h: ReturnType<typeof host>) {
  return requestCurrentContextSnapshot(h.eventBus);
}

// Real extension hooks and tool execution: do not replay ingestion after session.prompt() returns.
test("a real Pi tool can request its current-node snapshot before its first result", async () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-memory-tool-snapshot-"));
  let events: ExtensionAPI["events"];
  const captured: { snapshot: CurrentContextSnapshotResult; leaf: string | null; unchanged: boolean }[] = [];
  const f = await piSession({ extensions: [extension, pi => { events = pi.events; }],
    env: { TRACE_MEMORY_CONFIG: JSON.stringify({ ...quiet, dbPath: join(dir, "trace.db") }) },
    prepare: ({ agentDir }) => writeFileSync(join(agentDir, "trace-memory-baseline.json"), JSON.stringify("2000-01-01T00:00:00.000Z")),
    tools: [{ name: "snapshot_probe", description: "Read current memory", parameters: { type: "object", properties: {} },
      execute: async () => {
        const before = JSON.stringify(f.manager.getEntries());
        const leaf = f.manager.getLeafId();
        const snapshot = requestCurrentContextSnapshot(events);
        captured.push({ snapshot, leaf, unchanged: before === JSON.stringify(f.manager.getEntries()) });
        return { content: [{ type: "text", text: "PROBE_RESULT" }], details: {} };
      } }] });
  try {
    f.script(body => toolResults(body) < 2
      ? call(`probe_${toolResults(body)}`, "snapshot_probe", {}) : say("finished"));
    await f.session.prompt("CURRENT_NODE_PROBE");
    expect(captured).toHaveLength(2);
    for (const [index, { snapshot, leaf, unchanged }] of captured.entries()) {
      expect(snapshot.available, JSON.stringify(snapshot)).toBe(true);
      if (!snapshot.available) throw new Error(snapshot.message);
      expect(snapshot.node).toEqual({ nativeSessionId: f.manager.getSessionId(), nativeLeafId: leaf });
      expect(snapshot.text).toContain("CURRENT_NODE_PROBE");
      expect(snapshot.text).toContain(`probe_${index}`);
      expect(unchanged).toBe(true);
    }
    // The second call also sees the preceding tool result in the same Turn.
    expect(captured[1]!.snapshot.available && captured[1]!.snapshot.text).toContain("PROBE_RESULT");
    expect(f.sent).toHaveLength(3); // only the scripted parent requests; no memory worker/model call
  } finally { f.dispose(); rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

function databaseSnapshot(h: ReturnType<typeof host>) {
  const tables = h.memory.store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(row => String(row.name));
  // Ticket 81: raw_fts's WITHOUT ROWID shadow tables (raw_fts_config, raw_fts_idx) have no rowid to
  // order by; ordering by the first selected column works for every table, rowid or not.
  return Object.fromEntries(tables.map(table => [table, h.memory.store.db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()]));
}

function seedMaterial(h: ReturnType<typeof host>) {
  const store = h.memory.store;
  const noted = store.commitNotingRun({
    run: { kind: "noting", sessionId: 1, branch: "main", createdAt: "seed" },
    entryIds: [],
    facts: [
      { turnId: 1, category: "decision", actor: "user", text: "SNAPSHOT_KNOWLEDGE_EVIDENCE", source: ["T1#user"], createdAt: "seed" },
      { turnId: 1, category: "observation", actor: "agent", text: "SNAPSHOT_PENDING_FACT", source: ["T1#assistant"], createdAt: "seed" },
    ],
  });
  if (!noted.ok) throw new Error(noted.problems.join("; "));
  const knowledge = store.commitConsolidationRun({
    path: { sessionId: 1, branch: "main", headTurnId: 1 },
    run: { kind: "consolidation", sessionId: 1, branch: "main", createdAt: "seed" },
    consolidated: [noted.facts[0]!.id],
    operations: [{ op: "create", handle: "$k", topics: [], reason: "Initial admission.", author: "fixture",
      text: "SNAPSHOT_KNOWLEDGE", category: "constraint", scope: "session", supports: [noted.facts[0]!.id], createdAt: "seed" }],
  });
  if (!knowledge.ok) throw new Error(knowledge.problems.join("; "));
  return { pendingFactId: noted.facts[1]!.id, knowledgeCommitId: knowledge.committed[0]!.commit };
}

test("current snapshot is the existing empty-coverage compact at the exact persisted node and is read-only", async () => {
  const f = await fixture(quiet);
  try {
    f.script(() => say("SNAPSHOT_RAW_REPLY"));
    await f.turn("SNAPSHOT_RAW_PROMPT");
    const ids = seedMaterial(f.h);
    const store = f.h.memory.store;
    const stateBefore = {
      nativeEntries: structuredClone(f.manager().getEntries()),
      sources: store.listSourceEntries(1),
      pending: store.pendingEntries(1, "main", 1).map(entry => entry.id),
      runs: store.listRuns(1),
      claims: store.db.prepare("SELECT * FROM task_claims ORDER BY session_id, phase").all(),
      carriers: f.manager().getEntries().filter(entry => entry.type === "custom_message" || entry.type === "compaction"),
      requests: f.sent.length,
      database: databaseSnapshot(f.h),
    };
    const expected = f.h.memory.compact(1, "main", 1, []);
    if ("native" in expected) throw new Error(expected.reason);

    const first = request(f.h);
    expect(first.available).toBe(true);
    if (!first.available) throw new Error(first.message);
    expect(first.text).toBe(expected.text);
    expect(first.estimatedTokens).toBe(tokens(first.text));
    expect(first.composition).toEqual(expected.composition);
    expect(first.composition.knowledge).toBeGreaterThan(0);
    expect(first.composition.facts).toBeGreaterThan(0);
    expect(first.composition.raw).toBeGreaterThan(0);
    expect(first.supplied).toEqual(expected.supplied);
    expect(first.text).toContain("SNAPSHOT_KNOWLEDGE");
    expect(first.text).toContain("SNAPSHOT_PENDING_FACT");
    expect(first.text).toContain("SNAPSHOT_RAW_PROMPT");
    expect(first.text).toContain("SNAPSHOT_RAW_REPLY");
    expect(first.supplied.factIds).toContain(ids.pendingFactId);
    expect(first.supplied.knowledgeCommitIds).toContain(ids.knowledgeCommitId);
    expect(first.node).toEqual({ nativeSessionId: f.manager().getSessionId(), nativeLeafId: f.manager().getLeafId() });

    expect(request(f.h)).toEqual(first);
    expect(f.manager().getEntries()).toEqual(stateBefore.nativeEntries);
    expect(store.listSourceEntries(1)).toEqual(stateBefore.sources);
    expect(store.pendingEntries(1, "main", 1).map(entry => entry.id)).toEqual(stateBefore.pending);
    expect(store.listRuns(1)).toEqual(stateBefore.runs);
    expect(store.db.prepare("SELECT * FROM task_claims ORDER BY session_id, phase").all()).toEqual(stateBefore.claims);
    expect(f.manager().getEntries().filter(entry => entry.type === "custom_message" || entry.type === "compaction")).toEqual(stateBefore.carriers);
    expect(f.sent).toHaveLength(stateBefore.requests);
    expect(databaseSnapshot(f.h)).toEqual(stateBefore.database);
  } finally { await f.dispose(); }
}, 30_000);

test("missing, uninitialized, disabled and shutdown lifecycle are explicit without waiting", async () => {
  const empty = createEventBus();
  expect(requestCurrentContextSnapshot(empty)).toMatchObject({ available: false, reason: "missing-provider" });

  const h = host(quiet);
  try {
    expect(request(h)).toMatchObject({ available: false, reason: "not-initialized" });
    h.ctx.sessionManager.getSessionFile = () => `${h.dir}/persisted.jsonl`;
    await h.turn();
    await h.commands.get("trace").handler("off", h.ctx);
    expect(request(h)).toMatchObject({ available: false, reason: "disabled" });
    await h.commands.get("trace").handler("on", h.ctx);
    const shutdown = h.emit("session_shutdown", { reason: "quit" });
    expect(request(h)).toMatchObject({ available: false, reason: "closed" });
    await shutdown;
    expect(request(h)).toMatchObject({ available: false, reason: "missing-provider" });
  } finally { await h.dispose(); }
});

test("persisted source not yet ingested is refused, while non-source metadata after the boundary is ignored", async () => {
  const f = await fixture(quiet);
  try {
    f.script(() => say("answer"));
    await f.turn("first");
    expect(request(f.h).available).toBe(true);
    f.manager().appendCustomEntry("another-extension", { display: "metadata" });
    expect(request(f.h).available).toBe(true);

    f.manager().appendMessage({ role: "assistant", content: [{ type: "text", text: "SAME_TURN_LATEST" }], timestamp: 2 } as never);
    expect(request(f.h)).toMatchObject({ available: false, reason: "node-not-ready" });
    await f.h.emit("agent_end");
    const ready = request(f.h);
    expect(ready.available).toBe(true);
    if (ready.available) {
      expect(ready.text).toContain("SAME_TURN_LATEST");
      expect(ready.node.nativeLeafId).toBe(f.manager().getLeafId());
    }
  } finally { await f.dispose(); }
}, 30_000);

test("branch switches select exact source membership and returned snapshots do not move with later writes", async () => {
  const f = await fixture(quiet);
  try {
    f.script(() => say("answer"));
    await f.turn("BRANCH_FIRST");
    const forkPoint = f.manager().getLeafId()!;
    await f.turn("MAIN_ONLY");
    const mainTip = f.manager().getLeafId()!;
    const main = request(f.h);
    expect(main.available && main.text).toContain("MAIN_ONLY");

    f.manager().branch(forkPoint);
    await f.h.emit("session_tree");
    const sibling = request(f.h);
    expect(sibling.available).toBe(true);
    if (!sibling.available) throw new Error(sibling.message);
    expect(sibling.text).toContain("BRANCH_FIRST");
    expect(sibling.text).not.toContain("MAIN_ONLY");
    expect(sibling.node.nativeLeafId).not.toBe(mainTip);
    const frozen = structuredClone(sibling);

    f.manager().appendMessage({ role: "user", content: "SIBLING_ONLY", timestamp: 3 } as never);
    await f.h.emit("agent_end");
    const advancedSibling = request(f.h);
    expect(advancedSibling.available).toBe(true);
    if (advancedSibling.available) expect(advancedSibling.text).toContain("SIBLING_ONLY");
    expect(sibling).toEqual(frozen);

    f.manager().branch(mainTip);
    await f.h.emit("session_tree");
    const restored = request(f.h);
    expect(restored.available && restored.text).toContain("MAIN_ONLY");
    expect(restored.available && restored.text).not.toContain("SIBLING_ONLY");
  } finally { await f.dispose(); }
}, 30_000);

test("73: an over-budget allocator truncates rather than refusing, and starts no worker or native fallback", async () => {
  const f = await fixture({ "noting.triggerTokens": 20, "consolidation.triggerTokens": 20, "dreaming.triggerTokens": 1,
    "compaction.factsTokens": 1, "compaction.rawTokens": 1, "compaction.sharedAllowanceTokens": 1 });
  try {
    // The scripted worker makes no note commit, so pending Raw remains after ordinary admission.
    f.script(() => say("answer"));
    await f.turn("required raw material ".repeat(200));
    for (const scope of ["global", "project", "session"] as const) f.h.memory.setKnowledgeBudget(scope, 0);
    const sent = f.sent.length;
    const runs = f.h.memory.store.listRuns(1).length;
    const result = request(f.h);
    // 73: no fallback. Compact truncates instead of refusing, so the snapshot is available and reads
    // as any other compaction would — still no worker admitted and no compaction entry persisted (a
    // context snapshot is a read, never an extraction trigger or a publication).
    expect(result.available).toBe(true);
    expect(f.sent).toHaveLength(sent);
    expect(f.h.memory.store.listRuns(1)).toHaveLength(runs);
    expect(f.manager().getEntries().some(entry => entry.type === "compaction")).toBe(false);
  } finally { await f.dispose(); }
}, 30_000);

test("data errors remain explicit and duplicate providers are rejected", async () => {
  const bus = createEventBus();
  const result: CurrentContextSnapshotResult = { available: false, reason: "not-initialized", message: "fake" };
  const respond = (reply: unknown) => (reply as (value: CurrentContextSnapshotResult) => void)(result);
  bus.on(CURRENT_CONTEXT_SNAPSHOT_EVENT, respond);
  bus.on(CURRENT_CONTEXT_SNAPSHOT_EVENT, respond);
  expect(requestCurrentContextSnapshot(bus)).toMatchObject({ available: false, reason: "provider-conflict" });

  const f = await fixture(quiet);
  try {
    f.script(() => say("answer"));
    await f.turn("source");
    // Corrupt the normalized path header rather than the removed JSON representation.
    f.h.memory.store.db.prepare("UPDATE source_paths SET length = length + 1 WHERE session_id = 1").run();
    expect(request(f.h)).toMatchObject({ available: false, reason: "data-error" });
  } finally { await f.dispose(); }
});

// 79 item 3, ruled (a) (Pi review of 3ed5952; "79按你推荐"): the snapshot keeps its integrity
// contract by comparing 74's stored digest against `sourceDigest` of the live native message --
// metadata alone, no Raw -- which still catches a persisted message whose content changed under the
// same id after the reconciliation walk completed (the case the old per-entry `raw !== JSON.stringify`
// comparison caught, and the walk's own skip-reconciled-prefix shortcut does not).
test("79 item 3 (ruled a): a persisted native message changed under the same id after the walk still reports node-not-ready", async () => {
  const h = host(quiet);
  try {
    h.ctx.sessionManager.getSessionFile = () => `${h.dir}/persisted.jsonl`;
    await h.prompt("Question"); await h.answer("Answer"); await h.emit("agent_settled");
    const ready = request(h);
    expect(ready.available).toBe(true);
    // The walk has completed and reconciled; now mutate the persisted native message's content
    // under the same id, without any further ingestion event -- the exact case the per-entry
    // comparison caught and a completed walk's own skip-reconciled-prefix shortcut does not.
    const native = h.entries.find(e => e.type === "message" && e.message.role === "assistant") as { message: { content: unknown } };
    native.message.content = [{ type: "text", text: "silently changed after the walk" }];
    expect(request(h)).toMatchObject({ available: false, reason: "node-not-ready" });
  } finally { await h.dispose(); }
});

// 79 item 3: the integrity check itself reads no Raw (metadata and digests only); with nothing that
// fits `compact`'s tiny budget, every capture below belongs to the integrity comparison alone.
test("79 item 3: the snapshot's integrity check reads no Raw, asserted with statement capture", async () => {
  const h = host({ ...quiet, "compaction.rawTokens": 1, "compaction.factsTokens": 1, "compaction.sharedAllowanceTokens": 1 });
  try {
    h.ctx.sessionManager.getSessionFile = () => `${h.dir}/persisted.jsonl`;
    await h.prompt("Question"); await h.answer("Answer"); await h.emit("agent_settled");
    const original = h.memory.store.db.prepare.bind(h.memory.store.db);
    const statements: string[] = [];
    (h.memory.store.db as unknown as { prepare: typeof h.memory.store.db.prepare }).prepare =
      ((sql: string) => { statements.push(sql); return original(sql); }) as typeof h.memory.store.db.prepare;
    let result: ReturnType<typeof request>;
    try { result = request(h); }
    finally { (h.memory.store.db as unknown as { prepare: typeof h.memory.store.db.prepare }).prepare = original; }
    expect(result.available).toBe(true);
    expect(statements.some(sql => sql.includes("source_entry_raw"))).toBe(false);
  } finally { await h.dispose(); }
});
