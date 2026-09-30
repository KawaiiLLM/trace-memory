import { afterEach, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { TraceMemory, type DreamingAgentInput, type RunAgentResult } from "../../../src/core/api/index.ts";
import { tokens } from "../../../src/core/render/index.ts";
import { AdmittedDreamerScenarios, createDreamerTrigger } from "../../admitted-dreamer-scenario.ts";
import { skipRest, suppliedHandles } from "../../dreaming-skips.ts";
import { commitNoterKnowledge } from "../../noting-knowledge-fixture.ts";
import { canonicalToolNames } from "../../../src/core/prompts/tool-names.ts";
import { loadPrompt } from "../../../src/core/prompts/load.ts";

const memories: ReturnType<typeof TraceMemory>[] = [];
afterEach(() => { for (const memory of memories.splice(0)) memory.close(); });
const success = { outcome: "success", output: "done", request: { exact: "request" } } as const;

function fixture() {
  const scenarios = new AdmittedDreamerScenarios(async () => { throw new Error("unexpected phase"); });
  const memory = TraceMemory(":memory:", scenarios.agent); memories.push(memory);
  const store = memory.store, project = store.createProject({ name: "P", declaredBy: "mark" });
  const session = store.createSession({ host: "test", enrollmentChoice: true, projectId: project.id, startedAt: "now", firstReplyAt: "now" });
  const turn = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "rule", startedAt: "now" });
  const entry = memory.appendEntry({ sessionId: session.id, turnId: turn.id, nativeLineage: "fixture", nativeId: "root", role: "user", text: "rule", raw: "{}", calls: [] });
  memory.selectEntries(session.id, "main", [entry.id]);
  const noted = store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, createdAt: "now" }, facts: [{
    turnId: turn.id, entryIds: [entry.id], category: "decision", actor: "user", text: "rule", source: [`T${turn.id}#E1`], createdAt: "now",
  }] });
  if (!noted.ok) throw new Error(noted.problems.join("; "));
  const fact = noted.facts[0]!.id, target = { sessionId: session.id, branch: "main", headTurnId: turn.id, triggerEntryId: entry.id };
  const create = (text: string, scope: "global" | "project" | "session" = "project", supports = [fact]) => {
    const result = store.commitConsolidationRun({ run: { kind: "manual", sessionId: session.id, createdAt: "now" }, operations: [{
      op: "create", handle: `$${store.listKnowledgeRevisions().length + 1}`, author: "test", text, category: "constraint", scope,
      supports, topics: [], reason: "fixture", createdAt: "now",
    }] });
    if (!result.ok) throw new Error(result.problems.join("; "));
    return result.committed[0]!;
  };
  return { memory, store, scenarios, project, session, turn, entry, fact, target, create };
}
const address = (f: ReturnType<typeof fixture>, item: { knowledgeId: number; commit: number }) => `K${item.knowledgeId}#${f.store.versionTag(item.knowledgeId, item.commit)}`;
const history = (f: ReturnType<typeof fixture>, item: { knowledgeId: number; commit: number }) => `K${item.knowledgeId}@v${f.store.versionOrdinal(item.knowledgeId, item.commit)}`;
const commit = (f: ReturnType<typeof fixture>, item: { knowledgeId: number; version: string }) => {
  expect(item.version).toMatch(new RegExp(`^K${item.knowledgeId}@v\\d+$`));
  return f.store.resolveVersionOrdinal(item.knowledgeId, Number(item.version.split("@v")[1]));
};
const processed = (f: ReturnType<typeof fixture>) => f.store.db.prepare("SELECT pool, revision_id, run_id FROM knowledge_processed ORDER BY pool, revision_id").all();

async function admitted(f: ReturnType<typeof fixture>, scenario: (input: DreamingAgentInput, trigger: { knowledgeId: number; commit: number }) => Promise<RunAgentResult> | RunAgentResult,
  scope: "global" | "project" | "session" = "project") {
  const trigger = createDreamerTrigger(f.memory, f.target, f.fact, f.store.listKnowledgeRevisions().length + 1, scope);
  return { trigger, result: await f.scenarios.run(f.memory, f.target, input => scenario(input, trigger)) };
}

test("Dreamer instructions use its fresh host's exposed check, memory and read tools in the audited prompt", async () => {
  const f = fixture();
  createDreamerTrigger(f.memory, f.target, f.fact, 1);
  const names = Object.fromEntries(Object.keys(canonicalToolNames).map(role => [role, `mcp__trace_memory__${role}`])) as unknown as typeof canonicalToolNames;
  const rendered = loadPrompt("dreaming.md", names);
  const result = await f.scenarios.run(f.memory, { ...f.target, toolNames: names } as typeof f.target, task => {
    expect(task.prompt).toBe(rendered);
    expect(task.prompt).toContain("call `mcp__trace_memory__check`");
    expect(task.prompt).toContain("`mcp__trace_memory__memory({operations, skipped})`");
    expect(task.prompt).not.toContain("{{tool.");
    expect(task.promptHash).toBe(createHash("sha256").update(rendered).digest("hex"));
    expect(task.tools.map(tool => tool.name)).toEqual(["trace", "search", "check", "memory"]);
    task.acknowledgeRequest();
    return { outcome: "failure", output: "fixture stopped", request: { exact: "dream names" } };
  });
  expect(result.outcome).toBe("failure");
  if (!("runId" in result)) throw new Error("missing audited run");
  expect(f.store.getRun(result.runId)!.promptHash).toBe(createHash("sha256").update(rendered).digest("hex"));
});

test("64c exact provider request and terminal audit are preserved while success processes the frozen pool revisions", async () => {
  const f = fixture(), base = f.create("durable base");
  const exact = { provider: "exact body" };
  const { trigger, result } = await admitted(f, (task, trigger) => {
    task.reportRequest(exact); task.acknowledgeRequest();
    expect(task.material.changed).toContain(history(f, base));
    expect(task.material.changed).toContain(history(f, trigger));
    expect(task.tools.map(tool => tool.name)).toEqual(["trace", "search", "check", "memory"]);
    task.tools.find(tool => tool.name === "memory")!.execute({ operations: [], skipped: [base, trigger]
      .map(item => ({ knowledge: history(f, item), because: "fixture reviewed unchanged" })) });
    return { outcome: "success", output: "audited", request: exact, nativeLog: "/tmp/dream.jsonl",
      usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, cost: { total: 0.1 } } };
  });
  expect(result.outcome, JSON.stringify(result)).toBe("success");
  if (!("runId" in result)) throw new Error("missing run id");
  const run = f.store.getRun(result.runId)!;
  expect(run.request).toBe(JSON.stringify(exact));
  expect(JSON.parse(run.response!)).toMatchObject({ output: "audited", nativeLog: "/tmp/dream.jsonl",
    usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, cost: { total: 0.1 } }, check: { pool: `project:${f.project.id}` } });
  expect(f.memory.spend(f.session.id)).toMatchObject({ input: 7, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0.1 });
  expect(processed(f).map(row => Number(row.revision_id))).toEqual([base.commit, trigger.commit]);
});

test("64c payload-free acknowledgement preserves unavailable audit without fabricating a request", async () => {
  const f = fixture();
  const { result } = await admitted(f, task => {
    task.acknowledgeRequest();
    return { outcome: "failure", output: "provider body unavailable", audit: { available: false, reason: "no provider body" } };
  });
  expect(result.outcome).toBe("failure");
  if (!("runId" in result)) throw new Error("missing run id");
  const run = f.store.getRun(result.runId)!;
  expect(run.request).toBeNull();
  expect(JSON.parse(run.response!)).toMatchObject({ output: "provider body unavailable", audit: { available: false, reason: "no provider body" } });
  expect(result.problems).not.toContain("runAgent must return the exact provider request");
});

test("64c missing request without an unavailable-audit acknowledgement is an explicit failure", async () => {
  const f = fixture();
  const { result } = await admitted(f, () => ({ outcome: "success", output: "request omitted" }));
  expect(result.outcome).toBe("failure");
  if (!("runId" in result)) throw new Error("missing run id");
  expect(result.problems).toContain("runAgent must return the exact provider request");
  expect(f.store.getRun(result.runId)!.request).toBeNull();
});

test("68 provider failure leaves untouched frozen versions pending", async () => {
  const f = fixture(), base = f.create("failed base");
  const { trigger, result } = await admitted(f, task => {
    task.acknowledgeRequest();
    return { outcome: "failure", output: "provider failed", request: { exact: "failure" } };
  });
  expect(result.outcome).toBe("failure");
  expect(processed(f)).toEqual([]);
  expect(f.store.openDreamingRange(f.session.id, "main")).toBeNull();
  expect(f.store.pendingVersions(`project:${f.project.id}`, f.target).map(item => item.revisionId)).toEqual([base.commit, trigger.commit]);
  expect(f.memory.taskEligibility("dreaming", f.target).due).toBe(true);
});

test("64c pre-first-commit cancellation consumes nothing and leaves the pool due", async () => {
  const f = fixture(), controller = new AbortController();
  createDreamerTrigger(f.memory, f.target, f.fact, 1, "project");
  const cancelledTarget = { ...f.target, signal: controller.signal };
  const pending = f.scenarios.run(f.memory, cancelledTarget, task => new Promise<RunAgentResult>(resolve => {
    task.acknowledgeRequest();
    task.signal!.addEventListener("abort", () => resolve({ outcome: "cancelled", output: "cancelled", request: { exact: "cancel" } }), { once: true });
  }));
  await new Promise(resolve => setTimeout(resolve, 0)); controller.abort();
  expect((await pending).outcome).toBe("cancelled");
  expect(processed(f)).toEqual([]);
  expect(f.store.openDreamingRange(f.session.id, "main")).toBeNull();
  expect(f.store.duePools(f.target).map(value => value.pool)).toContain(`project:${f.project.id}`);
});

test("64c cancellation after a commit consumes the frozen revisions and the own revision in its resulting pool", async () => {
  const f = fixture(), base = f.create("project source");
  let own = 0;
  const { trigger, result } = await admitted(f, (task, trigger) => {
    const committed = JSON.parse(task.tools.find(tool => tool.name === "memory")!.execute({ operations: [{
      op: "update", id: address(f, base), text: "moved global result", category: "constraint", scope: "global", supports: [], topics: [], reason: "scope correction",
    }], skipped: [{ knowledge: history(f, trigger), because: "fixture trigger needs no maintenance" }] })).committed;
    own = commit(f, committed[0]);
    return { outcome: "cancelled", output: "cancelled after commit", request: { exact: "cancel-after-write" } };
  });
  expect(result.outcome, JSON.stringify(result)).toBe("cancelled");
  expect(processed(f).map(row => ({ pool: String(row.pool), revision: Number(row.revision_id) }))).toEqual([
    { pool: "global", revision: own },
    { pool: `project:${f.project.id}`, revision: trigger.commit },
  ]);
});

test("64c two schema-valid updates roll back atomically when the second hits a Store write failure", async () => {
  const f = fixture(), first = f.create("first atomic base"), second = f.create("second atomic base");
  const before = f.store.listKnowledgeRevisions().length;
  const { trigger, result } = await admitted(f, (task, trigger) => {
    f.store.db.exec(`CREATE TRIGGER reject_second_legal_update BEFORE INSERT ON knowledge_revisions
      WHEN NEW.knowledge_id = ${second.knowledgeId} BEGIN SELECT RAISE(ABORT, 'injected second legal update failure'); END`);
    const update = (base: typeof first, text: string) => ({ op: "update", id: address(f, base), text, category: "constraint", scope: "project", supports: [], topics: [], reason: text });
    const receipt = task.tools.find(tool => tool.name === "memory")!.execute({
      operations: [update(first, "first legal update executes before the fault"), update(second, "second legal update reaches Store insertion")],
      skipped: [{ knowledge: history(f, trigger), because: "fixture trigger" }],
    });
    expect(receipt).toContain("rejected:");
    expect(receipt).toContain("injected second legal update failure");
    expect(f.store.listKnowledgeRevisions()).toHaveLength(before + 1); // both batch inserts rolled back; only the trigger remains
    return success;
  });
  expect(result.outcome).toBe("failure");
  expect(f.store.currentCommit(first.knowledgeId, f.target)[0]!.id).toBe(first.commit);
  expect(f.store.currentCommit(second.knowledgeId, f.target)[0]!.id).toBe(second.commit);
  expect(f.store.listKnowledgeRevisions()).toHaveLength(before + 1);
  expect(processed(f)).toEqual([]);
});

test("64c an exact version tag permits same-pool maintenance without a read grant or enlarged frozen range", async () => {
  const f = fixture(), base = f.create("frozen base");
  let late!: { knowledgeId: number; commit: number }, own = 0;
  const { trigger, result } = await admitted(f, (task, trigger) => {
    late = f.create("arrived after freeze");
    // A tag identifies the revision; no per-run read registration grants authority.
    expect(f.memory.trace(address(f, late), { itemBudget: null })).toContain("arrived after freeze");
    const receipt = JSON.parse(task.tools.find(tool => tool.name === "memory")!.execute({ operations: [{
      op: "update", id: address(f, late), text: "maintained exact late item", category: "constraint", scope: "project", supports: [], topics: [], reason: "complete exact read",
    }], skipped: [{ knowledge: history(f, base), because: "unchanged" }, { knowledge: history(f, trigger), because: "fixture trigger" }] }));
    own = commit(f, receipt.committed[0]);
    return success;
  });
  expect(result.outcome, JSON.stringify(result)).toBe("success");
  const ids = processed(f).map(row => Number(row.revision_id));
  expect(ids).toEqual(expect.arrayContaining([base.commit, trigger.commit, own]));
  expect(ids).not.toContain(late.commit);
  expect(f.store.currentCommit(late.knowledgeId, f.target)[0]!.id).toBe(own);
});

test.each([
  { name: "second knowledge_processed insert", failure: "injected second processing insert failure", install: (f: ReturnType<typeof fixture>, trigger: { commit: number }) =>
    f.store.db.exec(`CREATE TRIGGER reject_second_processing BEFORE INSERT ON knowledge_processed WHEN NEW.revision_id = ${trigger.commit}
      BEGIN SELECT RAISE(ABORT, 'injected second processing insert failure'); END`) },
  { name: "range close", failure: "injected range close failure", install: (f: ReturnType<typeof fixture>) => {
    const range = f.store.openDreamingRange(f.session.id, f.target.branch)!;
    f.store.db.exec(`CREATE TRIGGER reject_range_close BEFORE UPDATE OF completed_run, closed_at ON dreaming_ranges WHEN NEW.id = ${range.id}
      BEGIN SELECT RAISE(ABORT, 'injected range close failure'); END`);
  } },
])("64c terminal $name failure rolls back pair processing, range close and baseline while preserving the committed batch and exact audit", async ({ failure, install }) => {
  const f = fixture(), base = f.create("terminal rollback base");
  let own = 0, rangeId = 0;
  const exact = { provider: `fault-${failure}` };
  const { trigger, result } = await admitted(f, (task, trigger) => {
    const committed = JSON.parse(task.tools.find(tool => tool.name === "memory")!.execute({ operations: [{
      op: "update", id: address(f, base), text: "committed before terminal fault", category: "constraint", scope: "project", supports: [], topics: [], reason: "real committed batch",
    }], skipped: [{ knowledge: history(f, trigger), because: "fixture trigger" }] })).committed;
    own = commit(f, committed[0]);
    rangeId = f.store.openDreamingRange(f.session.id, f.target.branch)!.id;
    install(f, trigger);
    return { outcome: "success", output: "provider completed before terminal fault", request: exact };
  });
  expect(result.outcome).toBe("failure");
  if (!("runId" in result)) throw new Error("missing run id");
  expect(result.problems.join(" ")).toContain(failure);
  expect(f.store.currentCommit(base.knowledgeId, f.target)[0]!.id).toBe(own);
  expect(f.store.knowledgeRevision(own)!.runId).toBe(result.runId);
  expect(processed(f)).toEqual([]);
  const range = f.store.db.prepare("SELECT completed_run, closed_at FROM dreaming_ranges WHERE id = ?").get(rangeId)!;
  expect(range).toEqual({ completed_run: null, closed_at: null });
  expect(f.store.getClaim(f.session.id, "dreaming")).toBeNull();
  const run = f.store.getRun(result.runId)!;
  expect(run.request).toBe(JSON.stringify(exact));
  expect(JSON.parse(run.response!)).toMatchObject({ output: "provider completed before terminal fault",
    check: { pool: `project:${f.project.id}`, frozenRevisionIds: [base.commit, trigger.commit], ownRevisionIds: [own] } });
  expect(JSON.parse(run.response!).problems.join(" ")).toContain(failure);
});

test("64c reference material is genuinely non-empty, capped and receipted when current out-of-range knowledge is oversized", async () => {
  const f = fixture();
  const references = Array.from({ length: 8 }, (_, index) => f.create(`reference-${index} ${"reference ".repeat(2_000)}`));
  const pool = `project:${f.project.id}`, pendingWeight = f.store.pendingPoolWeight(pool, f.target);
  f.store.setKnowledgeBudget("project", pendingWeight * 2);
  while (f.store.pendingVersions(pool, f.target).length) {
    const settled = await f.scenarios.run(f.memory, f.target, task => {
      const handles = suppliedHandles(task.material.changed);
      expect(handles.length).toBeGreaterThan(0);
      task.tools.find(tool => tool.name === "memory")!.execute({ operations: [],
        skipped: handles.map(knowledge => ({ knowledge, because: "fixture reviewed unchanged" })) });
      return success;
    });
    expect(settled.outcome).toBe("success");
  }
  expect(f.store.pendingVersions(pool, f.target)).toEqual([]);
  f.store.setKnowledgeBudget("project", 15_000);
  const { result } = await admitted(f, task => {
    expect(task.material.processed).toContain("Current pool knowledge outside this range:");
    expect(task.material.processed).toContain("omitted");
    expect(tokens(task.material.processed)).toBeLessThanOrEqual(task.admittedProcessedInputCap);
    const supplied = [...task.material.processed.matchAll(/\[K\d+#[a-z]+\]/g)].length;
    expect(supplied).toBeGreaterThan(0);
    expect(supplied).toBeLessThan(references.length);
    skipRest(task);
    return success;
  });
  // 104: the oversized references keep the pool over its budget, so the run is not a success.
  expect(result).toMatchObject({ outcome: "failure", problems: [expect.stringContaining("over budget")] });
});

test("64c frozen material preserves changed and direct-fact capacity guarantees with honest omission", async () => {
  const f = fixture();
  const hugeFacts = f.store.commitNotingRun({ run: { kind: "manual", sessionId: f.session.id, createdAt: "now" }, facts: ["first", "second"].map(label => ({
    turnId: f.turn.id, entryIds: [f.entry.id], category: "decision" as const, actor: "user" as const,
    text: `${label}-direct-fact ${"evidence ".repeat(8_000)}`, source: [`T${f.turn.id}#E1`], createdAt: "now",
  })) });
  if (!hugeFacts.ok) throw new Error(hugeFacts.problems.join("; "));
  f.create("direct fact target", "project", hugeFacts.facts.map(fact => fact.id));
  const { result } = await admitted(f, task => {
    expect(tokens(task.material.processed)).toBeLessThanOrEqual(task.admittedProcessedInputCap);
    expect(tokens(task.material.changed)).toBeLessThanOrEqual(15_000);
    expect(tokens(task.material.facts)).toBeLessThanOrEqual(10_000);
    expect(task.material.facts).toContain("first-direct-fact");
    expect(task.material.facts).toContain("Omitted whole direct facts beyond 10000");
    expect(task.material.facts).not.toContain("second-direct-fact");
    skipRest(task); // 104: success deliberates the whole frozen range
    return success;
  });
  expect(result.outcome).toBe("success");
});

// 103 review counterexample: a Changed item's scheduling weight is its diff, not the size its
// current version occupies in the pool. This fixture makes a pool of exactly one processed item,
// then lands a one-word Noter edit on it outside the Dreamer, so the pending item is "Changed"
// with a tiny diff weight but a large current body — the two must not be confused.
async function smallUpdateFixture() {
  const f = fixture();
  f.memory.config.dreaming.triggerTokens = 1;
  const projectPool = `project:${f.project.id}`;
  const base = f.create("Already-processed project knowledge that stays after this run. ".repeat(20) + "marker-original.");
  const firstRun = await f.scenarios.run(f.memory, f.target, task => {
    task.acknowledgeRequest();
    task.tools.find(tool => tool.name === "memory")!.execute({ operations: [],
      skipped: [{ knowledge: history(f, base), because: "fixture: mark processed" }] });
    return success;
  });
  if (firstRun.outcome !== "success") throw new Error(JSON.stringify(firstRun));
  const poolBeforeEdit = f.store.knowledgePools(f.target).find(pool => pool.pool === projectPool)!.tokens;

  const updated = commitNoterKnowledge(f.store, { run: { sessionId: f.session.id, createdAt: "now" }, operations: [{
    op: "update", knowledgeId: base.knowledgeId, baseCommit: base.commit, category: "constraint", scope: "project",
    supports: [f.fact], topics: [], reason: "one-word correction", createdAt: "now",
    text: "Already-processed project knowledge that stays after this run. ".repeat(20) + "marker-corrected.",
  }] });
  if (!updated.ok) throw new Error(updated.problems.join("; "));
  return { f, projectPool, poolBeforeEdit, updated: updated.committed[0]! };
}

test("103 order instruction: absent for a small update — the excluded size is the item's whole current body, not its diff weight", async () => {
  const { f, poolBeforeEdit, updated } = await smallUpdateFixture();
  // The pool has one item; excluding its current version entirely empties the pool, so the
  // correct remainder is 0. A budget comfortably above 0 but well below the pre-edit pool size
  // is over budget under the old (diff-weight) formula and within budget under the fix.
  expect(poolBeforeEdit).toBeGreaterThan(100);
  f.store.setKnowledgeBudget("project", 20);

  let seenBound = "";
  const secondRun = await f.scenarios.run(f.memory, f.target, task => {
    task.acknowledgeRequest();
    seenBound = task.material.bound;
    task.tools.find(tool => tool.name === "memory")!.execute({ operations: [],
      skipped: [{ knowledge: `K${updated.knowledgeId}@v${f.store.versionOrdinal(updated.knowledgeId, updated.commit)}`, because: "fixture reviewed unchanged" }] });
    return success;
  });
  // 104: the fixture budget keeps the pool over budget, so the run is not a success.
  expect(secondRun, JSON.stringify(secondRun)).toMatchObject({ outcome: "failure", problems: [expect.stringContaining("over budget")] });
  expect(seenBound).toBe(`Run wall-clock bound: ${f.memory.config.dreaming.timeoutMs} ms. Wrap up before this deadline.`);
});

test("103 order instruction: absent at the boundary where the remainder exactly equals budget", async () => {
  const { f, updated } = await smallUpdateFixture();
  f.store.setKnowledgeBudget("project", 0); // the pool's only item is fully excluded: remainder is 0, exactly at budget

  let seenBound = "";
  const secondRun = await f.scenarios.run(f.memory, f.target, task => {
    task.acknowledgeRequest();
    seenBound = task.material.bound;
    task.tools.find(tool => tool.name === "memory")!.execute({ operations: [],
      skipped: [{ knowledge: `K${updated.knowledgeId}@v${f.store.versionOrdinal(updated.knowledgeId, updated.commit)}`, because: "fixture reviewed unchanged" }] });
    return success;
  });
  // 104: the fixture budget keeps the pool over budget, so the run is not a success.
  expect(secondRun, JSON.stringify(secondRun)).toMatchObject({ outcome: "failure", problems: [expect.stringContaining("over budget")] });
  expect(seenBound).toBe(`Run wall-clock bound: ${f.memory.config.dreaming.timeoutMs} ms. Wrap up before this deadline.`);
});

// 103 review counterexample: an Archived item's scheduling weight is its removed body, but an
// archived revision is never part of the current pool (76), so excluding it removes nothing.
test("103 order instruction: present for an archive — the excluded size is 0, since an archived item never occupies the current pool", async () => {
  const f = fixture();
  f.memory.config.dreaming.triggerTokens = 1;
  const projectPool = `project:${f.project.id}`;
  const stays = f.create("Project knowledge that remains current after the archive below. ".repeat(20));
  const victim = f.create("Project knowledge retired by a later Noter archive. ".repeat(10));
  const firstRun = await f.scenarios.run(f.memory, f.target, task => {
    task.acknowledgeRequest();
    task.tools.find(tool => tool.name === "memory")!.execute({ operations: [], skipped: [
      { knowledge: history(f, stays), because: "fixture: mark processed" },
      { knowledge: history(f, victim), because: "fixture: mark processed" }] });
    return success;
  });
  expect(firstRun.outcome, JSON.stringify(firstRun)).toBe("success");

  const archived = commitNoterKnowledge(f.store, { run: { sessionId: f.session.id, createdAt: "now" }, operations: [{
    op: "archive", kind: "budget", knowledgeId: victim.knowledgeId, baseCommit: victim.commit, supports: [f.fact], reason: "superseded", createdAt: "now",
  }] });
  if (!archived.ok) throw new Error(archived.problems.join("; "));
  const archivedItem = archived.committed[0]!;

  // Archiving removed `victim` from the current pool; its removed body was never part of the
  // pool size, so the pool now equals `stays` alone. Budget one below that: over budget without
  // any exclusion needed, since the archive excludes nothing.
  const poolTokens = f.store.knowledgePools(f.target).find(pool => pool.pool === projectPool)!.tokens;
  f.store.setKnowledgeBudget("project", poolTokens - 1);

  let seenBound = "", checkReceipt = "";
  const secondRun = await f.scenarios.run(f.memory, f.target, task => {
    task.acknowledgeRequest();
    seenBound = task.material.bound;
    checkReceipt = String(task.tools.find(tool => tool.name === "check")!.execute({}));
    task.tools.find(tool => tool.name === "memory")!.execute({ operations: [],
      skipped: [{ knowledge: `K${archivedItem.knowledgeId}@v${f.store.versionOrdinal(archivedItem.knowledgeId, archivedItem.commit)}`, because: "fixture reviewed unchanged" }] });
    return success;
  });
  // 104: the fixture budget keeps the pool over budget, so the run is not a success.
  expect(secondRun, JSON.stringify(secondRun)).toMatchObject({ outcome: "failure", problems: [expect.stringContaining("over budget")] });

  const match = seenBound.match(/This pool is (\d+)\/(\d+) tokens; this run's pending items occupy (\d+); without them it is still (\d+), over budget\./);
  expect(match, seenBound).toBeTruthy();
  const shownPoolTokens = Number(match![1]), budget = Number(match![2]), excludedSize = Number(match![3]), shownRemainder = Number(match![4]);
  expect(shownPoolTokens).toBe(poolTokens);
  expect(excludedSize).toBe(0); // the archived item excludes nothing
  expect(shownRemainder).toBe(shownPoolTokens); // remainder equals the unexcluded pool size
  expect(shownRemainder).toBeGreaterThan(budget);
  expect(checkReceipt).toContain(`${projectPool}: ${shownPoolTokens}/${budget} tokens`);
});

test("103 order instruction: absent when the pool without this run's pending items is within budget", async () => {
  const f = fixture();
  const { result } = await admitted(f, (task, trigger) => {
    task.acknowledgeRequest();
    expect(task.material.bound).toBe(`Run wall-clock bound: ${f.memory.config.dreaming.timeoutMs} ms. Wrap up before this deadline.`);
    task.tools.find(tool => tool.name === "memory")!.execute({ operations: [],
      skipped: [{ knowledge: history(f, trigger), because: "fixture reviewed unchanged" }] });
    return success;
  });
  expect(result.outcome, JSON.stringify(result)).toBe("success");
});
