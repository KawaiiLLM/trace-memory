import { afterEach, expect, test } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { Store } from "../../../src/core/store/index.ts";
import { deriveKnowledgeBudgets } from "../../../src/core/store/processing.ts";
import { tokens, renderKnowledge } from "../../../src/core/render/index.ts";

const stores: Store[] = [], dirs: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const open = (path = ":memory:") => { const store = new Store(path); stores.push(store); return store; };
const file = () => { const dir = mkdtempSync(join(tmpdir(), "tm-budget-policy-")); dirs.push(dir); return join(dir, "trace.db"); };

interface WorkerMessage { type: string; ok?: boolean; error?: string; sql?: string; value?: unknown }

function operationWorker(path: string, release = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))) {
  const module = new URL("../../../src/core/store/index.ts", import.meta.url).href;
  const child = new Worker(`
    const { workerData, parentPort } = require('node:worker_threads');
    import(workerData.module).then(({ Store }) => {
      const store = new Store(workerData.path);
      const execute = action => {
        if (action.kind === 'budget') return store.setKnowledgeBudget(action.field, action.value);
        if (action.kind === 'complete') return store.completeDreaming(action.runId, action.eventIds, action.resultIds);
        if (action.kind === 'placement') return store.declareProject(action.sessionId, action.project, 'mark');
        throw new Error('unknown worker action');
      };
      parentPort.postMessage({ type: 'ready' });
      parentPort.on('message', message => {
        if (message.type === 'close') { store.close(); parentPort.postMessage({ type: 'closed' }); return; }
        if (message.type === 'hold') {
          try {
            let value;
            store.transaction(() => {
              value = execute(message.action);
              parentPort.postMessage({ type: 'held', ok: true });
              Atomics.wait(new Int32Array(workerData.release), 0, 0);
            });
            parentPort.postMessage({ type: 'result', ok: true, value });
          } catch (error) { parentPort.postMessage({ type: 'held', ok: false, error: String(error) }); }
          return;
        }
        parentPort.postMessage({ type: 'started' });
        const originalExec = store.db.exec.bind(store.db);
        let checkedContention = false;
        store.db.exec = sql => {
          if (!checkedContention && String(sql).trim() === 'BEGIN IMMEDIATE') {
            checkedContention = true;
            originalExec('PRAGMA busy_timeout = 0');
            try { return originalExec(sql); }
            catch (error) {
              if (!String(error).includes('locked')) throw error;
              parentPort.postMessage({ type: 'blocked' });
              Atomics.wait(new Int32Array(workerData.release), 0, 0);
              originalExec('PRAGMA busy_timeout = 5000');
              return originalExec(sql);
            }
          }
          return originalExec(sql);
        };
        try { parentPort.postMessage({ type: 'result', ok: true, value: execute(message.action) }); }
        catch (error) { parentPort.postMessage({ type: 'result', ok: false, error: String(error) }); }
      });
    }).catch(error => { throw error; });
  `, { eval: true, workerData: { module, path, release: release.buffer } });
  const queued: WorkerMessage[] = [];
  const waiting: { type: string; resolve: (value: WorkerMessage) => void; reject: (error: Error) => void }[] = [];
  child.on("message", (message: WorkerMessage) => {
    const index = waiting.findIndex(waiter => waiter.type === message.type);
    if (index >= 0) waiting.splice(index, 1)[0]!.resolve(message);
    else queued.push(message);
  });
  child.on("error", error => { for (const waiter of waiting.splice(0)) waiter.reject(error); });
  const wait = (type: string) => {
    const index = queued.findIndex(message => message.type === type);
    if (index >= 0) return Promise.resolve(queued.splice(index, 1)[0]!);
    return new Promise<WorkerMessage>((resolve, reject) => waiting.push({ type, resolve, reject }));
  };
  return {
    child, release, wait,
    send: (message: unknown) => child.postMessage(message),
    async close() { child.postMessage({ type: "close" }); await wait("closed"); await child.terminate(); },
  };
}

async function overlap(path: string, winnerAction: unknown, loserAction: unknown) {
  const release = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const winner = operationWorker(path, release), loser = operationWorker(path, release);
  await Promise.all([winner.wait("ready"), loser.wait("ready")]);
  winner.send({ type: "hold", action: winnerAction });
  const held = await winner.wait("held");
  expect(held).toMatchObject({ ok: true });
  loser.send({ type: "run", action: loserAction });
  await loser.wait("started");
  await loser.wait("blocked"); // the real operation's BEGIN observed the winner's uncommitted lock
  Atomics.store(release, 0, 1); Atomics.notify(release, 0, 2);
  const [won, lost] = await Promise.all([winner.wait("result"), loser.wait("result")]);
  await Promise.all([winner.close(), loser.close()]);
  return { won, lost };
}

function initializationWorker(path: string, role: "holder" | "observer", release: Int32Array) {
  const module = new URL("../../../src/core/store/index.ts", import.meta.url).href;
  const child = new Worker(`
    const { workerData, parentPort } = require('node:worker_threads');
    const release = new Int32Array(workerData.release);
    parentPort.once('message', async message => {
      try {
        if (message.type !== 'construct') throw new Error('unknown initialization worker action');
        const { DatabaseSync } = require('node:sqlite');
        const originalExec = DatabaseSync.prototype.exec;
        let probed = false;
        DatabaseSync.prototype.exec = function(sql) {
          const text = String(sql);
          if (!probed && /\\bBEGIN\\s+IMMEDIATE\\b/i.test(text)) {
            probed = true;
            originalExec.call(this, 'PRAGMA busy_timeout = 0');
            if (workerData.role === 'holder') {
              const value = originalExec.call(this, sql);
              parentPort.postMessage({ type: 'held', sql: text });
              Atomics.wait(release, 0, 0);
              originalExec.call(this, 'PRAGMA busy_timeout = 5000');
              return value;
            }
            try {
              originalExec.call(this, sql);
              throw new Error('constructor contention probe unexpectedly acquired the initialization lock');
            } catch (error) {
              if (!String(error).includes('locked')) throw error;
              parentPort.postMessage({ type: 'blocked', sql: text, error: String(error) });
              Atomics.wait(release, 0, 0);
              originalExec.call(this, 'PRAGMA busy_timeout = 5000');
              return originalExec.call(this, sql);
            }
          }
          return originalExec.call(this, sql);
        };
        const { Store } = await import(workerData.module);
        const store = new Store(workerData.path);
        let value;
        try { value = store.knowledgeBudgets(); }
        finally { store.close(); }
        parentPort.postMessage({ type: 'result', ok: true, value });
      } catch (error) {
        parentPort.postMessage({ type: 'result', ok: false, error: String(error) });
      }
    });
  `, { eval: true, workerData: { module, path, role, release: release.buffer } });
  const queued: WorkerMessage[] = [];
  let waiting: { resolve: (value: WorkerMessage) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | undefined;
  let failed: Error | undefined;
  child.on("message", (message: WorkerMessage) => {
    if (waiting) {
      const waiter = waiting; waiting = undefined; clearTimeout(waiter.timer); waiter.resolve(message);
    } else queued.push(message);
  });
  child.on("error", error => {
    failed = error;
    if (waiting) {
      const waiter = waiting; waiting = undefined; clearTimeout(waiter.timer); waiter.reject(error);
    }
  });
  return {
    child,
    start: () => child.postMessage({ type: "construct" }),
    next: () => {
      if (queued.length) return Promise.resolve(queued.shift()!);
      if (failed) return Promise.reject(failed);
      if (waiting) return Promise.reject(new Error("initialization worker already has a pending message wait"));
      return new Promise<WorkerMessage>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting = undefined;
          reject(new Error(`timed out waiting for ${role} initialization worker`));
        }, 5_000);
        waiting = { resolve, reject, timer };
      });
    },
  };
}

test("35d defaults and derived capacities are one exact safe-integer policy", () => {
  const store = open();
  expect(store.knowledgeBudgets()).toEqual({
    global: 4_000, project: 10_000, session: 1_000,
    applicable: 15_000, injection: 20_000, dreamingProcessedInput: 20_000,
  });
  expect(deriveKnowledgeBudgets({ global: 4_000, project: 15_000, session: 1_000 })).toMatchObject({
    applicable: 20_000, injection: 25_000, dreamingProcessedInput: 25_000,
  });
  expect(deriveKnowledgeBudgets({ global: 0, project: 0, session: 0 })).toMatchObject({
    applicable: 0, injection: 5_000, dreamingProcessedInput: 5_000,
  });
  for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    expect(() => deriveKnowledgeBudgets({ global: value, project: 0, session: 0 })).toThrow(/Global Knowledge budget.*nonnegative safe integer/);
  expect(() => deriveKnowledgeBudgets({ global: Number.MAX_SAFE_INTEGER, project: 0, session: 0 })).toThrow(/derived injection.*safe integer/);
  expect(() => deriveKnowledgeBudgets({ global: Number.MAX_SAFE_INTEGER - 4_999, project: 5_000, session: 0 })).toThrow(/applicable.*safe integer/);
});

test("35d edits one latest field, survives reopen, and independent databases stay independent", () => {
  const first = file(), second = file();
  const a = open(first), stale = a.knowledgeBudgets();
  const unrelated = a.createProject({ name: "unchanged", declaredBy: "mark" });
  const beforeMemory = a.db.prepare("SELECT * FROM projects WHERE id = ?").get(unrelated.id);
  expect(a.setKnowledgeBudget("project", 15_000)).toMatchObject({ changed: true, policy: { project: 15_000, injection: 25_000 } });
  const changes = (a.db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
  expect(a.setKnowledgeBudget("project", 15_000)).toMatchObject({ changed: false });
  expect((a.db.prepare("SELECT total_changes() AS n").get() as { n: number }).n).toBe(changes);
  expect(a.db.prepare("SELECT * FROM projects WHERE id = ?").get(unrelated.id)).toEqual(beforeMemory);
  const peer = open(first);
  expect(peer.setKnowledgeBudget("session", 2_000)).toMatchObject({ policy: { global: stale.global, project: 15_000, session: 2_000 } });
  expect(a.knowledgeBudgets()).toMatchObject({ global: 4_000, project: 15_000, session: 2_000, applicable: 21_000, injection: 26_000 });
  expect(open(second).knowledgeBudgets()).toMatchObject({ global: 4_000, project: 10_000, session: 1_000 });
  a.close(); stores.splice(stores.indexOf(a), 1);
  expect(open(first).knowledgeBudgets()).toMatchObject({ global: 4_000, project: 15_000, session: 2_000 });
});

test("35d supported pre-policy data upgrades without changing memory rows", () => {
  const path = file(), legacy = open(path);
  const project = legacy.createProject({ name: "preserved", declaredBy: "mark" });
  const session = legacy.createSession({ host: "test", projectId: project.id, enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
  legacy.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "preserve me", startedAt: "now" });
  const before = legacy.db.prepare("SELECT * FROM turns").all();
  legacy.db.exec("DROP TABLE knowledge_budget_policy"); // exact supported schema immediately before 35d
  legacy.close(); stores.splice(stores.indexOf(legacy), 1);
  const upgraded = open(path);
  expect(upgraded.knowledgeBudgets()).toMatchObject({ global: 4_000, project: 10_000, session: 1_000 });
  expect(upgraded.db.prepare("SELECT * FROM turns").all()).toEqual(before);
  expect(upgraded.db.prepare("SELECT count(*) AS n FROM knowledge_budget_policy").get()!.n).toBe(1);
});

test("35d a later upgrade failure rolls back the newly introduced policy and reopens stably", () => {
  const path = file(), legacy = open(path);
  const project = legacy.createProject({ name: "migration", declaredBy: "mark" });
  const session = legacy.createSession({ host: "test", projectId: project.id, enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
  const turn = legacy.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "legacy", startedAt: "now" });
  const entry = legacy.appendSourceEntry({ sessionId: session.id, turnId: turn.id, nativeLineage: "legacy", nativeId: "entry",
    role: "user", text: "legacy", raw: "legacy", calls: [] });
  legacy.db.prepare("UPDATE source_entries SET blocks = NULL WHERE id = ?").run(entry.id);
  legacy.db.exec("DROP TABLE knowledge_budget_policy");
  legacy.close(); stores.splice(stores.indexOf(legacy), 1);

  expect(() => new Store(path, () => { throw new Error("injected later migration failure"); })).toThrow("injected later migration failure");
  const failed = new DatabaseSync(path);
  expect(failed.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_budget_policy'").get()).toBeUndefined();
  expect(failed.prepare("SELECT blocks FROM source_entries WHERE id = ?").get(entry.id)!.blocks).toBeNull();
  failed.close();

  const reopened = new Store(path, () => [{ kind: "text", text: "legacy" }]); stores.push(reopened);
  expect(reopened.knowledgeBudgets()).toMatchObject({ global: 4_000, project: 10_000, session: 1_000 });
  expect(reopened.db.prepare("SELECT count(*) AS n FROM knowledge_budget_policy").get()!.n).toBe(1);
  reopened.close(); stores.splice(stores.indexOf(reopened), 1);
  const stable = open(path);
  expect(stable.knowledgeBudgets()).toMatchObject({ global: 4_000, project: 10_000, session: 1_000 });
});

test("35d policy creation rolls back when final upgrade integrity validation fails", () => {
  const path = file(), legacy = open(path);
  legacy.db.exec("DROP TABLE knowledge_budget_policy; PRAGMA foreign_keys = OFF; CREATE TABLE upgrade_probe(session_id INTEGER REFERENCES sessions(id)); INSERT INTO upgrade_probe VALUES (999999); PRAGMA foreign_keys = ON");
  legacy.close(); stores.splice(stores.indexOf(legacy), 1);
  expect(() => new Store(path)).toThrow("Store migration: foreign key violations");
  const failed = new DatabaseSync(path);
  expect(failed.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_budget_policy'").get()).toBeUndefined();
  failed.exec("DELETE FROM upgrade_probe"); failed.close();
  expect(open(path).knowledgeBudgets()).toMatchObject({ global: 4_000, project: 10_000, session: 1_000 });
});

test("35d initialization is idempotent and invalid stored arithmetic fails instead of falling back", () => {
  const path = file();
  const a = open(path);
  a.setKnowledgeBudget("global", 4_321);
  a.close(); stores.splice(stores.indexOf(a), 1);
  const b = open(path);
  expect(b.knowledgeBudgets().global).toBe(4_321);
  expect(b.db.prepare("SELECT count(*) AS n FROM knowledge_budget_policy").get()!.n).toBe(1);
  b.close(); stores.splice(stores.indexOf(b), 1);
  const unchanged = readFileSync(path);
  const noWrite = open(path);
  noWrite.close(); stores.splice(stores.indexOf(noWrite), 1);
  expect(readFileSync(path)).toEqual(unchanged);
  const raw = new DatabaseSync(path);
  raw.exec("PRAGMA ignore_check_constraints=ON");
  raw.prepare("UPDATE knowledge_budget_policy SET global_tokens = ?, project_tokens = ?, session_tokens = 0 WHERE id = 1")
    .run(Number.MAX_SAFE_INTEGER, 1);
  raw.close();
  const invalid = readFileSync(path);
  expect(() => new Store(path)).toThrow(/stored Knowledge budget policy.*derived applicable.*safe integer/);
  expect(readFileSync(path)).toEqual(invalid); // opening never resets an invalid row
});

function processedProjectKnowledge(store: Store, text: string, name = "race-project", scope: "project" | "session" = "project") {
  const project = store.createProject({ name, declaredBy: "mark" });
  const session = store.createSession({ host: "test", projectId: project.id, enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
  const turn = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "evidence", startedAt: "now" });
  const noted = store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, createdAt: "now" }, facts: [{
    turnId: turn.id, category: "decision", actor: "user", text: "evidence", source: [`T${turn.id}#user`], createdAt: "now",
  }] });
  if (!noted.ok) throw new Error(noted.problems.join("; "));
  const written = store.commitConsolidationRun({ run: { kind: "manual", sessionId: session.id, createdAt: "now" }, operations: [{
    op: "create", handle: "$1", author: "test", text, category: "constraint", scope, supports: [noted.facts[0]!.id], topics: [], reason: "race fixture", createdAt: "now",
  }] });
  if (!written.ok) throw new Error(written.problems.join("; "));
  const commit = written.committed[0]!.commit;
  const revision = store.knowledgeRevision(commit)!;
  const used = tokens(renderKnowledge({ knowledge: store.getKnowledge(revision.knowledgeId)!, revision }));
  return { project, session, turn, commit, used };
}

function completionRun(store: Store, item: ReturnType<typeof processedProjectKnowledge>) {
  const path = { sessionId: item.session.id, branch: "main", headTurnId: item.turn.id };
  const range = store.retainDreamingRange(path, [item.commit]);
  return store.recordRun({ kind: "dreaming", sessionId: item.session.id, branch: path.branch,
    dreamingRangeId: range.id, outcome: "success", createdAt: "now" });
}

test("35d Project and Session budgets apply independently to each owner pool", () => {
  const store = open();
  const items = [
    processedProjectKnowledge(store, "x ".repeat(6_000), "owner-project-a"),
    processedProjectKnowledge(store, "y ".repeat(6_000), "owner-project-b"),
    processedProjectKnowledge(store, "m ".repeat(600), "owner-session-a", "session"),
    processedProjectKnowledge(store, "n ".repeat(600), "owner-session-b", "session"),
  ];
  expect(items[0]!.used + items[1]!.used).toBeGreaterThan(store.knowledgeBudgets().project);
  expect(items[2]!.used + items[3]!.used).toBeGreaterThan(store.knowledgeBudgets().session);
  for (const item of items) {
    const run = completionRun(store, item);
    store.completeDreaming(run.id, [item.commit], [item.commit]);
    expect(store.isKnowledgeProcessed(item.commit)).toBe(true);
  }
});

test("35d reductions diagnose current processed owners and pending revisions do not count as processed", () => {
  const store = open();
  store.setKnowledgeBudget("project", 20_000);
  const item = processedProjectKnowledge(store, "current ".repeat(3_000));
  expect(item.used).toBeGreaterThan(1_000);
  const run = completionRun(store, item);
  store.completeDreaming(run.id, [item.commit], [item.commit]);
  const used = store.checkProcessedScopes().totals.find(total => total.scope === `project:${item.project.id}`)!.tokens;
  expect(() => store.setKnowledgeBudget("project", used - 1)).toThrow(new RegExp(`project:${item.project.id}: used ${used} tokens, proposed cap ${used - 1}, overage 1`));
  expect(store.knowledgeBudgets().project).toBe(20_000);

  const pending = processedProjectKnowledge(store, "pending ".repeat(5_000));
  expect(pending.used).toBeGreaterThan(item.used);
  expect(store.setKnowledgeBudget("project", used).policy.project).toBe(used);
  const pendingRun = completionRun(store, pending);
  expect(() => store.completeDreaming(pendingRun.id, [pending.commit], [pending.commit])).toThrow(/project:.*exceeds/);
  expect(store.isKnowledgeProcessed(pending.commit)).toBe(false);
});

test("35d sequential two-connection orders enforce policy reduction against certification", () => {
  const path = file(), writer = open(path), settings = open(path);
  writer.setKnowledgeBudget("project", 20_000);
  const first = processedProjectKnowledge(writer, "growth ".repeat(2_500));
  const firstRun = completionRun(writer, first);
  writer.completeDreaming(firstRun.id, [first.commit], [first.commit]); // growth wins
  const used = writer.checkProcessedScopes().totals.find(total => total.scope === `project:${first.project.id}`)!.tokens;
  expect(() => settings.setKnowledgeBudget("project", used - 1)).toThrow(/overage 1/);

  settings.setKnowledgeBudget("project", used);
  const later = processedProjectKnowledge(writer, "later growth ".repeat(3_000));
  const laterRun = completionRun(writer, later);
  expect(() => writer.completeDreaming(laterRun.id, [later.commit], [later.commit])).toThrow(/processed knowledge.*exceeds/);
  expect(writer.knowledgeBudgets()).toEqual(settings.knowledgeBudgets());
});

test("35d a reduction that wins is enforced by later project placement", () => {
  const path = file(), writer = open(path), settings = open(path);
  const first = processedProjectKnowledge(writer, "first ".repeat(1_000), "policy-project-a");
  const second = processedProjectKnowledge(writer, "second ".repeat(1_000), "policy-project-b");
  for (const item of [first, second]) {
    const run = completionRun(writer, item);
    writer.completeDreaming(run.id, [item.commit], [item.commit]);
  }
  const cap = Math.max(...writer.checkProcessedScopes().totals.filter(total => total.scope.startsWith("project:")).map(total => total.tokens));
  settings.setKnowledgeBudget("project", cap);
  expect(() => writer.declareProject(second.session.id, "policy-project-a", "mark")).toThrow(/Project placement rejected.*project:.*exceeds/);
  expect(writer.getSession(second.session.id)!.projectId).toBe(second.project.id);
  expect(writer.knowledgeBudgets().project).toBe(cap);
});

test.each(["project", "session"] as const)("35d real overlapping %s reduction and certification serialize safely in both winning orders", async scope => {
  for (const order of ["growth", "reduction"] as const) {
    const path = file(), setup = open(path);
    setup.setKnowledgeBudget(scope, 20_000);
    const item = processedProjectKnowledge(setup, `${scope} overlap `.repeat(1_000), `${scope}-${order}`, scope);
    const owner = scope === "project" ? `project:${item.project.id}` : `session:${item.session.id}`;
    const acceptedUsed = setup.checkProcessedScopes([item.commit]).totals.find(total => total.scope === owner)!.tokens;
    const run = completionRun(setup, item);
    setup.close(); stores.splice(stores.indexOf(setup), 1);
    const budget = { kind: "budget", field: scope, value: acceptedUsed - 1 };
    const complete = { kind: "complete", runId: run.id, eventIds: [item.commit], resultIds: [item.commit] };
    const result = order === "growth" ? await overlap(path, complete, budget) : await overlap(path, budget, complete);
    expect(result.won.ok).toBe(true);
    expect(result.lost.ok).toBe(false);
    expect(result.lost.error).toMatch(order === "growth" ? /overage 1/ : /processed knowledge.*exceeds/);
    const checked = open(path);
    expect(checked.isKnowledgeProcessed(item.commit)).toBe(order === "growth");
    expect(checked.knowledgeBudgets()[scope]).toBe(order === "growth" ? 20_000 : acceptedUsed - 1);
    checked.close(); stores.splice(stores.indexOf(checked), 1);
  }
});

test.each(["placement", "reduction"] as const)("35d real overlapping project placement and reduction are atomic when %s wins", async winnerName => {
  const path = file(), setup = open(path);
  setup.setKnowledgeBudget("project", 20_000);
  const first = processedProjectKnowledge(setup, "first placement ".repeat(1_000), `place-a-${winnerName}`);
  const second = processedProjectKnowledge(setup, "second placement ".repeat(1_000), `place-b-${winnerName}`);
  for (const item of [first, second]) {
    const run = completionRun(setup, item);
    setup.completeDreaming(run.id, [item.commit], [item.commit]);
  }
  const cap = Math.max(...setup.checkProcessedScopes().totals.filter(total => total.scope.startsWith("project:")).map(total => total.tokens));
  const destination = first.project.name;
  setup.close(); stores.splice(stores.indexOf(setup), 1);
  const placement = { kind: "placement", sessionId: second.session.id, project: destination };
  const reduction = { kind: "budget", field: "project", value: cap };
  const result = winnerName === "placement" ? await overlap(path, placement, reduction) : await overlap(path, reduction, placement);
  expect(result.won.ok).toBe(true);
  expect(result.lost.ok).toBe(false);
  expect(result.lost.error).toMatch(winnerName === "placement" ? /overage/ : /Project placement rejected.*exceeds/);
  const checked = open(path);
  expect(checked.getSession(second.session.id)!.projectId === first.project.id).toBe(winnerName === "placement");
  expect(checked.knowledgeBudgets().project).toBe(winnerName === "placement" ? 20_000 : cap);
});

test("35d concurrent constructors observe the initialization lock and publish exactly one default row", async () => {
  const path = file(), legacy = open(path);
  legacy.db.exec("DROP TABLE knowledge_budget_policy");
  legacy.close(); stores.splice(stores.indexOf(legacy), 1);
  const release = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const holder = initializationWorker(path, "holder", release);
  const observer = initializationWorker(path, "observer", release);
  try {
    // Listeners are installed before either start message. `held` is sent only after the first
    // constructor's real BEGIN IMMEDIATE succeeds and while that initialization transaction is open.
    holder.start();
    const held = await holder.next();
    expect(held).toMatchObject({ type: "held", sql: expect.stringMatching(/BEGIN IMMEDIATE/) });

    observer.start();
    const blocked = await observer.next();
    // This is not worker readiness: the second constructor reports only after its own BEGIN IMMEDIATE
    // receives SQLite's locked error from the first constructor's still-uncommitted transaction.
    expect(blocked).toMatchObject({
      type: "blocked",
      sql: expect.stringMatching(/BEGIN IMMEDIATE/),
      error: expect.stringMatching(/database is locked/),
    });

    Atomics.store(release, 0, 1); Atomics.notify(release, 0, 2);
    const results = await Promise.all([holder.next(), observer.next()]);
    const defaults = {
      global: 4_000, project: 10_000, session: 1_000,
      applicable: 15_000, injection: 20_000, dreamingProcessedInput: 20_000,
    };
    expect(results).toEqual([
      { type: "result", ok: true, value: defaults },
      { type: "result", ok: true, value: defaults },
    ]);

    const checked = open(path);
    expect(checked.db.prepare("SELECT count(*) AS n FROM knowledge_budget_policy").get()!.n).toBe(1);
    checked.setKnowledgeBudget("project", 15_000);
    checked.close(); stores.splice(stores.indexOf(checked), 1);
    const reopened = open(path);
    expect(reopened.knowledgeBudgets()).toMatchObject({ project: 15_000, applicable: 20_000, injection: 25_000 });
    expect(reopened.db.prepare("SELECT count(*) AS n FROM knowledge_budget_policy").get()!.n).toBe(1);
  } finally {
    // Failed lock assertions and worker failures cannot strand the holder or leave live workers.
    Atomics.store(release, 0, 1); Atomics.notify(release, 0, 2);
    await Promise.allSettled([holder.child.terminate(), observer.child.terminate()]);
  }
}, 15_000);
