import { afterEach, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { TraceMemory, type DreamingAgentInput, type RunAgentResult } from "../../../src/core/api/index.ts";
import { renderKnowledge, tokens } from "../../../src/core/render/index.ts";
import { AdmittedDreamerScenarios, createDreamerTrigger } from "../../admitted-dreamer-scenario.ts";
import { dreamerWrite, skipRest, suppliedHandles } from "../../dreaming-skips.ts";
import { knowledgeBatch, receiptCommit } from "../../support/seed.ts";
import { canonicalToolNames } from "../../../src/core/prompts/tool-names.ts";
import { loadPrompt } from "../../../src/core/prompts/load.ts";
import { withRetrievalPolicy } from "../../../src/core/render/retrieval-policy.ts";
import { dreamingToolDefinitions, pricedToolDefinitions } from "../../../src/core/api/tools.ts";
import { commitNoterKnowledge } from "../../noting-knowledge-fixture.ts";

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
  return receiptCommit(f.store, item);
};
const processed = (f: ReturnType<typeof fixture>) => f.store.db.prepare("SELECT pool, revision_id, run_id FROM knowledge_processed ORDER BY pool, revision_id").all();

async function admitted(f: ReturnType<typeof fixture>, scenario: (input: DreamingAgentInput, trigger: { knowledgeId: number; commit: number }) => Promise<RunAgentResult> | RunAgentResult,
  scope: "global" | "project" | "session" = "project") {
  const trigger = createDreamerTrigger(f.memory, f.target, f.fact, f.store.listKnowledgeRevisions().length + 1, scope);
  return { trigger, result: await f.scenarios.run(f.memory, f.target, input => scenario(input, trigger)) };
}

test("native Read token estimate counts in Dreamer capacity before dispatch", async () => {
  const f = fixture();
  createDreamerTrigger(f.memory, f.target, f.fact, 1);
  let base: DreamingAgentInput | undefined;
  const stop = (task: DreamingAgentInput) => {
    task.acknowledgeRequest();
    return { outcome: "failure" as const, output: "capacity fixture stopped without writes", request: { exact: "capacity" } };
  };
  await f.scenarios.run(f.memory, f.target, task => { base = task; return stop(task); });
  if (!base) throw new Error("missing baseline Dreamer dispatch");
  const nativeReadToolTokens = 402;
  const definitions = pricedToolDefinitions(dreamingToolDefinitions(), canonicalToolNames);
  const price = tokens(base.prompt) + tokens(JSON.stringify(definitions)) + nativeReadToolTokens + tokens(base.text);
  const bounded = { ...f.target, nativeReadToolTokens, capacity: { inputTokens: price - 1, prefixTokens: 0 } };
  const runs = f.store.listRuns(f.session.id).length;
  await expect(f.scenarios.run(f.memory, bounded, () => { throw new Error("over-cap dispatch"); })).rejects.toThrow(/Dreaming capacity/);
  expect(f.store.listRuns(f.session.id)).toHaveLength(runs);
  const exact = { ...bounded, capacity: { inputTokens: price, prefixTokens: 0 } };
  await f.scenarios.run(f.memory, exact, task => {
    expect(tokens(task.prompt) + tokens(JSON.stringify(definitions)) + nativeReadToolTokens + tokens(task.text)).toBe(price);
    return stop(task);
  });
  expect(f.store.listRuns(f.session.id)).toHaveLength(runs + 1);
  expect(processed(f)).toEqual([]);
});

test("136 review SPEC4: a Dreamer's over-long search output is saved where its host says, and the path is in the result", async () => {
  const f = fixture();
  const saved: string[] = [];
  let answer = "";
  const { result } = await admitted(f, async task => {
    task.setSpill!(text => { saved.push(text); return "/where/the/host/saved/it"; });
    answer = await task.tools.find(tool => tool.name === "search")!.execute({ layer: "knowledge", code: "text('HEAD ' + 'word '.repeat(60000) + ' TAIL')" });
    task.acknowledgeRequest();
    return { outcome: "failure", output: "fixture stopped", request: { exact: "spill" } };
  });
  expect(result.outcome).toBe("failure");
  expect(answer).toContain("[Full output: /where/the/host/saved/it]");
  expect(answer).not.toContain("not saved");
  expect(saved).toHaveLength(1);
  expect(saved[0]!.startsWith("HEAD word")).toBe(true); expect(saved[0]!.endsWith(" TAIL")).toBe(true);
});

test("Dreamer instructions use its fresh host's exposed check, memory and read tools in the audited prompt", async () => {
  const f = fixture();
  createDreamerTrigger(f.memory, f.target, f.fact, 1);
  const names = { ...canonicalToolNames, search: "mcp__trace_memory__search", note: "mcp__trace_memory__note", memory: "mcp__trace_memory__memory", check: "mcp__trace_memory__check", read: "Read", grep: "Grep" };
  const rendered = withRetrievalPolicy(loadPrompt("dreaming.md", names), names); // 137: the policy is part of a fresh Dreamer's system prompt

  let finished = false;
  const result = await f.scenarios.run(f.memory, { ...f.target, toolNames: names } as typeof f.target, task => {
    expect(task.prompt).toBe(rendered);
    expect(task.prompt).toContain("`mcp__trace_memory__check`");
    expect(task.prompt).toContain("`mcp__trace_memory__memory`");
    expect(task.prompt).not.toContain("{{tool.");
    expect(task.prompt.split("When to look up memory").length).toBe(2);
    expect(task.prompt).toContain("Find topics and exact strings with mcp__trace_memory__search;");
    expect(task.promptHash).toBe(createHash("sha256").update(rendered).digest("hex"));
    expect(task.tools.map(tool => tool.name)).toEqual(["search", "check", "memory"]);
    task.acknowledgeRequest();
    finished = true; // the run's expected failure must not hide an assertion error above
    return { outcome: "failure", output: "fixture stopped", request: { exact: "dream names" } };
  });
  expect(finished).toBe(true);
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
    expect(task.tools.map(tool => tool.name)).toEqual(["search", "check", "memory"]);
    dreamerWrite(task.tools.find(tool => tool.name === "memory")!, { operations: [], skipped: [base, trigger]
      .map(item => ({ knowledge: history(f, item), because: "fixture reviewed unchanged" })) });
    return { outcome: "success", output: "audited", request: exact, nativeLog: "/tmp/dream.jsonl",
      usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, cost: { total: 0.1 } } };
  });
  expect(result.outcome, JSON.stringify(result)).toBe("success");
  if (!("runId" in result)) throw new Error("missing run id");
  const run = f.store.getRun(result.runId)!;
  expect(run.request).toBe(JSON.stringify(exact));
  expect(JSON.parse(run.response!)).toMatchObject({ output: "audited", nativeLog: "/tmp/dream.jsonl",
    usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, cost: { total: 0.1 } }, check: { totals: expect.arrayContaining([expect.objectContaining({ pool: `project:${f.project.id}` })]) } });
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
  expect(f.store.dreamingDue(f.target, f.memory.config.dreaming.triggerTokens)).toBe(true);
});

test("64c cancellation after a commit consumes the frozen revisions and the own revision in its resulting pool", async () => {
  const f = fixture(), base = f.create("project source");
  let own = 0;
  const { trigger, result } = await admitted(f, (task, trigger) => {
    const committed = JSON.parse(dreamerWrite(task.tools.find(tool => tool.name === "memory")!, { operations: [{
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

test("127: each call commits in its own transaction; a Store write failure refuses and rolls back only its own call, which then blocks", async () => {
  const f = fixture(), first = f.create("first base"), second = f.create("second base");
  const before = f.store.listKnowledgeRevisions().length;
  let firstCommit = 0, finished = false;
  const { result } = await admitted(f, (task, trigger) => {
    f.store.db.exec(`CREATE TRIGGER reject_second_legal_update BEFORE INSERT ON knowledge_revisions
      WHEN NEW.knowledge_id = ${second.knowledgeId} BEGIN SELECT RAISE(ABORT, 'injected second legal update failure'); END`);
    const update = (base: typeof first, text: string) => ({ op: "update", id: address(f, base), text, category: "constraint", scope: "project", supports: [], topics: [], reason: text });
    const memory = task.tools.find(tool => tool.name === "memory")!;
    expect(memory.execute(update(first, "first legal update commits on its own"))).toContain('"committed"');
    firstCommit = f.store.currentCommit(first.knowledgeId, f.target)[0]!.id;
    const refused = JSON.parse(memory.execute(update(second, "second legal update reaches Store insertion")));
    expect(refused.results).toEqual([expect.stringMatching(/^rejected: M1: .*injected second legal update failure/)]);
    expect(f.store.listKnowledgeRevisions()).toHaveLength(before + 2); // the trigger and the first update; the refused call wrote nothing
    expect(memory.execute({ skip: history(f, trigger), because: "fixture trigger" })).toContain('"rejected":{"M1"');
    finished = true;
    return success;
  });
  expect(finished).toBe(true);
  expect(result.outcome).toBe("failure");
  expect("problems" in result && result.problems[0]).toMatch(/^M1: .*injected second legal update failure/);
  expect(f.store.currentCommit(first.knowledgeId, f.target)[0]!.id).toBe(firstCommit);
  expect(firstCommit).not.toBe(first.commit);
  expect(f.store.currentCommit(second.knowledgeId, f.target)[0]!.id).toBe(second.commit);
  expect(f.store.listKnowledgeRevisions()).toHaveLength(before + 2);
});

test("127: update, merge, split and both archive kinds are each one call that commits at once", async () => {
  const f = fixture();
  const [updated, survivor, absorbed, parent, budget, invalid] = knowledgeBatch(f.store, f.target,
    ["update me", "merge survivor", "merge absorbed", "split parent", "budget archive", "invalid archive"]
      .map(text => ({ scope: "project" as const, category: "constraint" as const, supports: [f.fact], text })), { kind: "manual", createdAt: "now" }).committed;
  const { result } = await admitted(f, (task, trigger) => {
    const memory = task.tools.find(tool => tool.name === "memory")!;
    const call = (input: Record<string, unknown>, results: number) => {
      const before = f.store.listKnowledgeRevisions().length;
      const receipt = JSON.parse(memory.execute(input));
      expect(receipt).toMatchObject({ results: ["ok"] });
      expect(receipt).not.toHaveProperty("rejected");
      expect(f.store.listKnowledgeRevisions().length - before).toBe(results); // in the store before the next call
      return receipt;
    };
    const content = { category: "constraint", scope: "project", topics: [], supports: [] };
    call({ op: "update", id: address(f, updated!), text: "updated", ...content, reason: "rewrite" }, 1);
    call({ op: "merge", id: address(f, survivor!), absorb: [address(f, absorbed!)], text: "merged", ...content, reason: "same rule" }, 1);
    expect(call({ op: "split", id: address(f, parent!), children: [{ text: "one", category: "constraint", topics: [] },
      { text: "two", category: "reference", topics: [] }], supports: [], reason: "two rules" }, 2).committed).toHaveLength(2);
    call({ op: "archive", kind: "budget", id: address(f, budget!), supports: [], reason: "over budget" }, 1);
    call({ op: "archive", kind: "invalid", id: address(f, invalid!), text: "The rule no longer holds: the user corrected its basis; nothing replaces it.",
      supports: [], reason: "contradicted" }, 1);
    expect(JSON.parse(memory.execute({ skip: history(f, trigger), because: "fixture trigger" }))).toEqual({ results: ["ok"], committed: [], diagnostics: [] });
    expect(task.tools.find(tool => tool.name === "check")!.execute({})).toContain("Blockers: none");
    return success;
  });
  expect(result.outcome, JSON.stringify(result)).toBe("success");
  const current = (item: { knowledgeId: number }) => f.store.currentCommit(item.knowledgeId, f.target)[0];
  expect(current(updated!)?.text).toBe("updated");
  expect(current(survivor!)?.text).toBe("merged");
  expect(current(absorbed!)).toBeUndefined();
  expect([current(parent!), current(budget!)?.archiveKind, current(invalid!)?.archiveKind]).toEqual([undefined, "budget", "invalid"]);
});

test("127: a refused call holds Mn and blocks check and the end pass until slot or drop; a later sibling's commit never clears it", async () => {
  for (const resolved of [false, true]) {
    const f = fixture();
    const [a, b] = knowledgeBatch(f.store, f.target, ["rule A", "rule B"].map(text => ({ scope: "project" as const,
      category: "constraint" as const, supports: [f.fact], text })), { kind: "manual", createdAt: "now" }).committed;
    let review = "", finished = false;
    const { result } = await admitted(f, (task, trigger) => {
      const memory = task.tools.find(tool => tool.name === "memory")!, check = () => task.tools.find(tool => tool.name === "check")!.execute({});
      const update = (item: { knowledgeId: number; commit: number }, text: string, id = address(f, item)) =>
        ({ op: "update", id, text, category: "constraint", scope: "project", topics: [], supports: [], reason: text });
      // One response's calls run in order: a refused update, then two legal siblings that commit.
      expect(JSON.parse(memory.execute(update(a!, "A rewritten", `K${a!.knowledgeId}#zzzz`))))
        .toEqual({ results: [expect.stringMatching(/^rejected: M1: /)], rejected: { M1: expect.any(String) } });
      expect(JSON.parse(memory.execute(update(b!, "B rewritten")))).toMatchObject({ results: ["ok"], rejected: { M1: expect.any(String) } });
      expect(JSON.parse(memory.execute({ skip: history(f, trigger), because: "fixture trigger" }))).toHaveProperty("rejected.M1");
      expect(check()).toMatch(/\nBlockers: M1: /);
      review = task.passEnd(1)!;
      if (!resolved) { finished = true; return success; }
      expect(memory.execute({ slot: "M1", ...update(a!, "A rewritten", "K999#zzzz") })).toContain("rejected: M1: "); // a refused resubmission keeps its number
      expect(memory.execute(update(a!, "A rewritten", "K998#zzzz"))).toContain("rejected: M2: ");
      expect(memory.execute({ drop: "M2" })).toContain("dropped: M2");
      expect(memory.execute({ drop: "M2" })).toContain("rejected: M2: unknown M slot M2"); // a call error
      expect(check()).toContain("unknown M slot M2");
      expect(JSON.parse(memory.execute({ slot: "M1", ...update(a!, "A rewritten") }))).toMatchObject({ results: ["ok"], committed: [{ knowledgeId: a!.knowledgeId }] });
      expect(check()).toContain("Blockers: none");
      expect(memory.execute(update(a!, "stale", address(f, a!)))).toContain("rejected: M3: "); // numbers never recycle
      expect(memory.execute({ drop: "M3" })).toContain("dropped: M3");
      finished = true;
      return success;
    });
    expect(finished).toBe(true);
    expect(review.split("\n\nBlockers:\n")[1]!.split("\n\n")[0]).toMatch(/^M1: /);
    expect(result.outcome).toBe(resolved ? "success" : "failure");
    if (!resolved) expect("problems" in result && result.problems[0]).toMatch(/^M1: /);
    expect(f.store.currentCommit(b!.knowledgeId, f.target)[0]!.text).toBe("B rewritten");
    expect(f.store.currentCommit(a!.knowledgeId, f.target)[0]!.text).toBe(resolved ? "A rewritten" : "rule A");
  }
});

test("127: an item missing required fields is numbered, not a top-level call error, and survives a later sibling's commit", async () => {
  const f = fixture();
  const [a] = knowledgeBatch(f.store, f.target, [{ scope: "project", category: "constraint", supports: [f.fact], text: "rule A" }],
    { kind: "manual", createdAt: "now" }).committed;
  let finished = false;
  const { result } = await admitted(f, (task, trigger) => {
    const memory = task.tools.find(tool => tool.name === "memory")!, check = () => task.tools.find(tool => tool.name === "check")!.execute({});
    expect(memory.execute({ op: "update" })).toContain("rejected: M1: ");
    expect(JSON.parse(memory.execute({ op: "update", id: address(f, a!), text: "rule A, clarified", category: "constraint", scope: "project",
      topics: [], supports: [], reason: "clarify" }))).toMatchObject({ results: ["ok"], rejected: { M1: expect.any(String) } });
    expect(memory.execute({ skip: history(f, trigger), because: "fixture trigger" })).toContain('"committed":[]');
    expect(check()).toMatch(/\nBlockers: M1: /);
    finished = true;
    return success;
  });
  expect(finished).toBe(true);
  expect(result.outcome).toBe("failure");
  expect("problems" in result && result.problems).toEqual([expect.stringMatching(/^M1: /)]);
});

test("127: a host-refused Dreamer call is recorded as the Noter's: an item numbers Mn, a shapeless call is a call error, a duplicate report is ignored", async () => {
  const f = fixture();
  const [a] = knowledgeBatch(f.store, f.target, [{ scope: "project", category: "constraint", supports: [f.fact], text: "rule A" }],
    { kind: "manual", createdAt: "now" }).committed;
  const { result } = await admitted(f, (task, trigger) => {
    const memory = task.tools.find(tool => tool.name === "memory")!, check = () => task.tools.find(tool => tool.name === "check")!.execute({});
    const update = { op: "update", id: address(f, a!), text: "rule A, clarified", category: "constraint", scope: "project", topics: [], supports: [], reason: "clarify" };
    for (let report = 0; report < 2; report++) task.reportToolRejection("native-1", "memory", { ...update, topics: "x" }, "native schema refused");
    expect(check()).toMatch(/\nBlockers: M1: native schema refused; frozen versions/);
    task.reportToolRejection("native-2", "memory", { operations: [] }, "native shape refused");
    expect(check()).toMatch(/\nBlockers: native shape refused; M1: native schema refused; frozen versions/);
    expect(JSON.parse(memory.execute({ slot: "M1", ...update }))).toMatchObject({ results: ["ok"], committed: [{ knowledgeId: a!.knowledgeId }] });
    expect(memory.execute({ skip: history(f, trigger), because: "fixture trigger" })).toContain('"committed":[]');
    expect(check()).toContain("Blockers: none");
    return success;
  });
  expect(result.outcome, JSON.stringify(result)).toBe("success");
});

test("64c an exact version tag permits same-pool maintenance without a read grant or enlarged frozen range", async () => {
  const f = fixture(), base = f.create("frozen base");
  let late!: { knowledgeId: number; commit: number }, own = 0;
  const { trigger, result } = await admitted(f, (task, trigger) => {
    late = f.create("arrived after freeze");
    // A tag identifies the revision; no per-run read registration grants authority.
    expect(f.memory.trace(address(f, late), { itemBudget: null })).toContain("arrived after freeze");
    const receipt = JSON.parse(dreamerWrite(task.tools.find(tool => tool.name === "memory")!, { operations: [{
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
    const committed = JSON.parse(dreamerWrite(task.tools.find(tool => tool.name === "memory")!, { operations: [{
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
    check: { frozenRevisionIds: [base.commit, trigger.commit], ownRevisionIds: [own] } });
  expect(JSON.parse(run.response!).problems.join(" ")).toContain(failure);
});

test("64c reference material is genuinely non-empty, capped and receipted when current out-of-range knowledge is oversized", async () => {
  const f = fixture();
  f.memory.config.dreaming.triggerTokens = 5_000;
  const references = Array.from({ length: 8 }, (_, index) => f.create(`reference-${index} ${"reference ".repeat(2_000)}`));
  const pool = `project:${f.project.id}`, pendingWeight = f.store.pendingPoolWeight(pool, f.target);
  f.store.setKnowledgeBudget("project", pendingWeight * 2);
  while (f.store.pendingVersions(pool, f.target).length) {
    const settled = await f.scenarios.run(f.memory, f.target, task => {
      const handles = suppliedHandles(task.material.changed);
      expect(handles.length).toBeGreaterThan(0);
      dreamerWrite(task.tools.find(tool => tool.name === "memory")!, { operations: [],
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

test("134: Changed material supplies its current tag for a committed update without a read", async () => {
  const f = fixture();
  f.memory.config.dreaming.triggerTokens = 1;
  const base = f.create("保留范围。使用 red tiles。");
  const reference = JSON.parse(f.memory.tools({ kind: "manual", sessionId: f.session.id,
    branch: "main", currentTurnId: f.turn.id }).find(tool => tool.name === "memory")!.execute({
    op: "create", text: "Keep the independent reference unchanged.", category: "constraint", scope: "project",
    topics: ["retrieval context"], supports: [`F${f.fact}`], reason: "An unchanged reference for the next D",
  }));
  const first = await f.scenarios.run(f.memory, f.target, task => {
    task.acknowledgeRequest(); skipRest(task); return success;
  });
  expect(first.outcome, JSON.stringify(first)).toBe("success");
  const changed = commitNoterKnowledge(f.store, { path: f.target,
    run: { sessionId: f.session.id, branch: "main", createdAt: "now" },
    operations: [{ op: "update", knowledgeId: base.knowledgeId, baseCommit: base.commit,
      text: "保留范围。使用 blue tiles。", category: "constraint", scope: "project", topics: [],
      supports: [f.fact], reason: "New evidence changes one word", createdAt: "now" }] });
  if (!changed.ok) throw new Error(changed.problems.join("; "));
  const result = await f.scenarios.run(f.memory, f.target, task => {
    task.acknowledgeRequest();
    const tag = new RegExp(`\\[(K${base.knowledgeId}#[a-z]+)\\]`).exec(task.material.changed)?.[1];
    expect(tag, task.material.changed).toBe(`K${base.knowledgeId}#${f.store.versionTag(base.knowledgeId, changed.committed[0]!.commit)}`);
    expect(task.material.processed).toMatch(new RegExp(`\\[K${reference.committed[0].knowledgeId}#[a-z]+\\] \\[[^\\]]+\\] \\(${reference.tokens.after[0]} tokens\\)`));
    const shownCost = Number(new RegExp(`\\[${tag}\\] \\[[^\\]]+\\] \\((\\d+) tokens\\)`).exec(task.material.changed)![1]);
    const receipt = JSON.parse(task.tools.find(tool => tool.name === "memory")!.execute({
      op: "update", id: tag, text: "保留范围。使用 blue tiles，并保留条件。",
      category: "constraint", scope: "project", topics: [], supports: [], reason: "Keep the confirmed condition",
    }));
    expect(receipt.committed[0].knowledgeId).toBe(base.knowledgeId);
    expect(receipt.tokens.before).toEqual([shownCost]);
    return success;
  });
  expect(result.outcome, JSON.stringify(result)).toBe("success");
  expect(f.store.currentCommit(base.knowledgeId)[0]!.text).toContain("并保留条件");
});

test("139: the frozen material shows the dates of each item's supporting facts beside its token cost, and the cost does not move", async () => {
  const f = fixture();
  f.memory.config.dreaming.triggerTokens = 1;
  const [early, late] = ["2026-10-02T08:00:00.000Z", "2026-10-04T08:00:00.000Z"].map(createdAt => {
    const noted = f.store.commitNotingRun({ run: { kind: "manual", sessionId: f.session.id, createdAt: "now" }, facts: [{
      turnId: f.turn.id, entryIds: [f.entry.id], category: "decision", actor: "user", text: `rule at ${createdAt}`, source: [`T${f.turn.id}#E1`], createdAt }] });
    if (!noted.ok) throw new Error(noted.problems.join("; "));
    return noted.facts[0]!.id;
  }) as [number, number];
  const reference = f.create("Keep the reference rule.", "project", [early]);
  const first = await f.scenarios.run(f.memory, f.target, task => {
    task.acknowledgeRequest();
    expect(task.material.changed).toMatch(/\(\d+ tokens; facts 2026-10-02\)/);
    skipRest(task); return success;
  });
  expect(first.outcome, JSON.stringify(first)).toBe("success");
  f.create("Add the new rule.", "project", [early, late]);
  const result = await f.scenarios.run(f.memory, f.target, task => {
    task.acknowledgeRequest();
    const cost = (tag: string) => Number(new RegExp(`\\[${tag}\\] \\[[^\\]]+\\] \\((\\d+) tokens`).exec(task.text)![1]);
    expect(task.material.processed).toMatch(new RegExp(`\\[${address(f, reference)}\\] \\[[^\\]]+\\] \\(\\d+ tokens; facts 2026-10-02\\)`));
    expect(task.material.changed).toMatch(/New .*\n\[[^\n]*\(\d+ tokens; facts 2026-10-02\.\.2026-10-04\)/);
    expect(task.text).toContain(task.material.changed);
    const item = f.store.knowledgePools(f.target).flatMap(pool => pool.versions).find(value => value.revision.id === reference.commit)!;
    expect(cost(address(f, reference))).toBe(tokens(renderKnowledge(item, address(f, reference))));
    skipRest(task); return success;
  });
  expect(result.outcome, JSON.stringify(result)).toBe("success");
});

test("134: frozen material keeps newest whole direct facts within capacity and honestly omits older facts", async () => {
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
    expect(task.material.facts).toContain("second-direct-fact");
    expect(task.material.facts).toContain("Omitted whole direct facts beyond 10000");
    expect(task.material.facts).not.toContain("first-direct-fact");
    skipRest(task); // 104: success deliberates the whole frozen range
    return success;
  });
  expect(result.outcome).toBe("success");
});

// 131 supersedes 103's order: a run with pending items deliberates them first, however far over budget the
// processed knowledge alone is; the budget is only `check`'s verdict at the end.
test("131: a run with pending items is told no order even when its processed knowledge alone is over budget", async () => {
  const f = fixture();
  f.memory.config.dreaming.triggerTokens = 1;
  f.create("Project knowledge already processed. ".repeat(40));
  const deliberate = async () => { let bound = ""; const result = await f.scenarios.run(f.memory, f.target, input => {
    input.acknowledgeRequest(); bound = input.material.bound; skipRest(input); return success; }); return { result, bound }; };
  expect((await deliberate()).result.outcome).toBe("success");
  f.store.setKnowledgeBudget("project", f.store.knowledgePools(f.target).find(pool => pool.pool === `project:${f.project.id}`)!.tokens - 1);
  f.create("Project knowledge pending in this run. ".repeat(20));
  const { bound } = await deliberate();
  expect(bound).toBe(`Run wall-clock bound: ${f.memory.config.dreaming.timeoutMs} ms. Wrap up before this deadline.`);
});

test("131 (104): a run with no pending items, started by pool overflow, is told so, reaches check and reduces", async () => {
  const f = fixture();
  f.memory.config.dreaming.triggerTokens = 1;
  const oldest = f.create("Project knowledge already processed, older. ".repeat(40));
  f.create("Project knowledge already processed, newer. ".repeat(40));
  const projectPool = `project:${f.project.id}`;
  expect((await f.scenarios.run(f.memory, f.target, input => { input.acknowledgeRequest(); skipRest(input); return success; })).outcome).toBe("success");
  const size = f.store.knowledgePools(f.target).find(pool => pool.pool === projectPool)!.tokens;
  f.store.setKnowledgeBudget("global", 0); f.store.setKnowledgeBudget("session", 0);
  f.store.setKnowledgeBudget("project", size - 1);
  f.memory.config.compaction.sharedAllowanceTokens = 0;
  expect(f.memory.taskEligibility("dreaming", f.target).due).toBe(true);

  let bound = "", before = "", after = "";
  const result = await f.scenarios.run(f.memory, f.target, input => {
    input.acknowledgeRequest(); bound = input.material.bound;
    const tool = (name: string) => input.tools.find(value => value.name === name)!;
    expect(suppliedHandles(input.material.changed)).toEqual([]);
    before = String(tool("check").execute({}));
    tool("memory").execute({ op: "archive", kind: "budget", id: address(f, oldest), supports: [], reason: "over budget" });
    after = String(tool("check").execute({}));
    return success;
  });
  expect(bound).toContain(`Pool ${projectPool} is ${size}/${size - 1} tokens, over budget.`);
  expect(bound).toContain("This run has no pending items.");
  expect(before).toContain(`${projectPool}: ${size}/${size - 1} tokens`);
  expect(before).not.toContain("Blockers: none");
  expect(after).toContain("Blockers: none");
  expect(result, JSON.stringify(result)).toMatchObject({ outcome: "success" });
});
