import { writeFileSync } from "node:fs";
import { expect, test } from "vitest";
import { sourceSeededMemory, type DreamingAgentInput, type NotingAgentInput, type RunAgentResult } from "../source-fixture.ts";
import { CcTaskScheduler } from "../../src/hosts/cc/scheduler.ts";
import { resolveCcHostConfig } from "../../src/hosts/cc/config.ts";
import type { CcReconcileResult } from "../../src/hosts/cc/importer.ts";
import { knowledgeBatch } from "../support/seed.ts";
import { block } from "../support/workspace.ts";

// Real scheduler + core lifecycle; the provider is an explicit in-process worker stub, not native CC.
test("92/07: CC catchup third N failure cancels active D without losing exact settlement authority", async () => {
  let executeDream!: (task: DreamingAgentInput) => Promise<RunAgentResult>;
  let nCalls = 0, dCalls = 0;
  const memory = sourceSeededMemory(":memory:", async raw => {
    const task = raw as NotingAgentInput | DreamingAgentInput;
    const request = { fixture: "cc-auto-off", kind: task.kind };
    task.reportRequest(request);
    if (task.kind === "dreaming") { dCalls++; return executeDream(task); }
    nCalls++;
    return { outcome: "failure", output: "intentional Noter failure", request };
  }, { dreaming: { triggerOperations: 1 } });
  const worker = resolveCcHostConfig({ stateDir: "/tmp/unused-92-auto-off", notingModel: "synthetic", notingThinking: "high",
    "dreaming.model": "synthetic", "dreaming.thinking": "high",
    worker: { cwd: "/tmp", claudeExecutable: "/missing/unused-claude", contextWindows: { synthetic: 200_000, sonnet: 200_000 } } }).worker;
  const diagnostics: string[] = [];
  const scheduler = new CcTaskScheduler(memory, worker, message => diagnostics.push(message));
  try {
    const store = memory.store;
    const project = store.createProject({ name: "auto-off", declaredBy: "mark" });
    const session = store.createSession({ projectId: project.id, host: "cc:auto-off", enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
    const turn = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "maintain three independent rules", startedAt: "now" });
    const target = { sessionId: session.id, branch: "main", headTurnId: turn.id };
    const entries = memory.pendingEntries(session.id, "main", turn.id).map(entry => entry.id);
    const tools = memory.tools({ kind: "manual", ...target, currentTurnId: turn.id });
    const factResult = tools.find(tool => tool.name === "note")!.execute({ title: "Three rules", sources: `[T${turn.id}#E1] Three rules have distinct purposes` });
    expect(factResult).not.toContain("rejected:");
    const factReceipt = JSON.parse(factResult);
    expect(factReceipt.factIds).toHaveLength(1);
    const fid = factReceipt.factIds[0];
    // Noter-written items make the Dreamer due (2026-10-22).
    const written = knowledgeBatch(store, target, [1, 2, 3].map(n => ({ scope: "session" as const, category: "constraint" as const, supports: [fid], text: `Rule ${n}`, title: "Fixture title" })));
    const [changed, skipped, untouched] = written.committed;
    let observedAbort = false, lateWrite!: () => string | undefined, claim: ReturnType<typeof store.getClaim> = null, revisionsAtAbort = 0;
    const revisions = () => store.listKnowledgeRevisions().length;
    const fileOf = async (task: DreamingAgentInput) => /(?:Your file|File): (\S+?\.md)/.exec(String(await task.tools.find(tool => tool.name === "check")!.execute({})))![1]!;
    executeDream = async task => {
      const request = { fixture: "cc-auto-off", kind: "dreaming" };
      if (task.task === "curate") { // the batch is kept at its pass end, before the stop
        writeFileSync(await fileOf(task), block(`update K${changed!.knowledgeId}@v1`, { reason: "maintenance" }, "Rule 1 maintained"));
        expect(task.passEnd()).toBeUndefined();
        return { outcome: "success", output: "curated", request };
      }
      expect(task.task).toBe("verify");
      const file = await fileOf(task);
      claim = store.getClaim(session.id, "dreaming");
      lateWrite = () => {
        writeFileSync(file, block(`edit 1 update K${changed!.knowledgeId}@v1`, { evidence: `trace://F${fid}` }, "Late rewrite"));
        return task.passEnd();
      };
      const signal = task.signal;
      if (!signal) throw Error("Dreamer worker has no cancellation signal");
      return new Promise(resolve => signal.addEventListener("abort", () => {
        observedAbort = true;
        expect(store.enabled(session.id)).toBe(false);
        expect(nCalls).toBe(3);
        expect(store.getClaim(session.id, "dreaming")).toEqual({ ...claim, expiresAt: 0 }); // the same claim row stays until settlement; memory off expires its lease
        revisionsAtAbort = revisions();
        expect(lateWrite()).toBeUndefined(); // a late pass end applies nothing
        expect(tools.find(tool => tool.name === "note")!.execute({})).toContain("Disabled");
        resolve({ outcome: "cancelled", output: "aborted", request });
      }, { once: true }));
    };
    // The importer projection names real Store source IDs; only its native snapshot is unused by this scheduler.
    const projection: CcReconcileResult = { state: "ready", ...target, coreSessionId: session.id, selectedEntryIds: entries,
      selectedCount: entries.length, selectedTailId: entries.at(-1)!, selectedAppendedEntryIds: [], appendedEntryIds: [], problems: [],
      snapshot: { path: "/unused/fixture.jsonl", exists: true, size: 0, modifiedMs: 0, changedMs: 0, device: 0, inode: 0,
        completeBytes: 0, recordCount: 0, records: [], incompleteBytes: 0, changed: false, reset: false } };
    scheduler.reconcile(projection);
    expect(scheduler.startCatchup(projection).state).toBe("running");
    for (let i = 0; i < 30 && scheduler.running().length; i++) await new Promise<void>(resolve => setImmediate(resolve));
    expect(scheduler.running()).toEqual([]);
    expect(observedAbort).toBe(true);
    expect(nCalls).toBe(3); expect(dCalls).toBe(2); // curate, then verify
    expect(scheduler.catchupStatus().state).toBe("stopped");
    expect(diagnostics.some(message => message.includes("off after three failures"))).toBe(true);
    expect(store.getClaim(session.id, "dreaming")).toBeNull();
    expect(lateWrite()).toBeUndefined();
    expect(revisions()).toBe(revisionsAtAbort); // curate's batch is kept as a proposal, nothing is applied before verify passes; the late write added nothing
    expect(store.currentKnowledge(target).find(value => value.knowledge.id === changed!.knowledgeId)!.revision.text).toBe("Rule 1");
    expect(store.currentCommit(untouched!.knowledgeId, target)[0]!.id).toBe(untouched!.commit);
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM knowledge_processed WHERE pool=?").get(`session:${session.id}`)!.n).toBe(0); // coverage is written when verify passes, and it did not
    expect(memory.pendingEntries(session.id, "main", turn.id).map(entry => entry.id)).toEqual(entries);
    expect(store.listRuns(session.id).filter(run => run.kind === "dreaming").at(-1)?.outcome).toBe("cancelled");
    expect(store.taskFailures(session.id).filter(item => item.phase === "dreaming")).toEqual([]);
    scheduler.reconcile({ ...projection, appendedEntryIds: entries, selectedAppendedEntryIds: entries });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(nCalls).toBe(3); expect(dCalls).toBe(2);
  } finally { scheduler.stop(); memory.close(); }
});
