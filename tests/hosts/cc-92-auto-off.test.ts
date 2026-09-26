import { expect, test } from "vitest";
import { sourceSeededMemory, type DreamingAgentInput, type NotingAgentInput, type RunAgentResult } from "../source-fixture.ts";
import { CcTaskScheduler } from "../../src/hosts/cc/scheduler.ts";
import { resolveCcHostConfig } from "../../src/hosts/cc/config.ts";
import type { CcReconcileResult } from "../../src/hosts/cc/importer.ts";

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
  }, { dreaming: { triggerTokens: 1 } });
  const worker = resolveCcHostConfig({ stateDir: "/tmp/unused-92-auto-off", notingModel: "synthetic", notingThinking: "high",
    "dreaming.model": "synthetic", "dreaming.thinking": "high",
    worker: { cwd: "/tmp", claudeExecutable: "/missing/unused-claude", claudeVersion: "2.1.280", contextWindows: { synthetic: 200_000 } } }).worker;
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
    const factResult = tools.find(tool => tool.name === "note")!.execute({ facts: [{ text: "Three rules have distinct purposes", source: [`T${turn.id}#E1`] }] });
    expect(factResult).not.toContain("rejected:");
    const factReceipt = JSON.parse(factResult);
    expect(factReceipt.factIds).toHaveLength(1);
    const fid = factReceipt.factIds[0];
    const written = store.commitConsolidationRun({ path: target, run: { kind: "manual", sessionId: session.id, createdAt: "now" }, operations: [1, 2, 3].map(n => ({
      op: "create", handle: `$${n}`, author: "fixture", category: "constraint", scope: "session", text: `Rule ${n}`, supports: [fid], topics: [], reason: "evidence", createdAt: "now",
    })) });
    if (!written.ok) throw Error(written.problems.join("; "));
    const [changed, skipped, untouched] = written.committed;
    let own = 0, lateWrite!: () => string, observedAbort = false;
    executeDream = task => {
      const write = task.tools.find(tool => tool.name === "memory")!;
      const update = { operations: [{ op: "update", id: `K${changed!.knowledgeId}#${store.versionTag(changed!.knowledgeId, changed!.commit)}`,
        text: "Rule 1 maintained", category: "constraint", scope: "session", topics: [], supports: [], reason: "maintenance" }], skipped: [] };
      expect(write.execute(update)).not.toContain("rejected:");
      own = store.currentCommit(changed!.knowledgeId, target)[0]!.id;
      expect(write.execute({ operations: [], skipped: [{ knowledge: `K${skipped!.knowledgeId}@v1`, because: "checked unchanged" }] })).not.toContain("rejected:");
      const claim = store.getClaim(session.id, "dreaming")!;
      const rangeId = store.openDreamingRange(session.id, "main")!.id;
      lateWrite = () => write.execute(update);
      const signal = task.signal;
      if (!signal) throw Error("Dreamer worker has no cancellation signal");
      return new Promise(resolve => signal.addEventListener("abort", () => {
        observedAbort = true;
        expect(store.enabled(session.id)).toBe(false);
        expect(nCalls).toBe(3);
        expect(store.getClaim(session.id, "dreaming")).toEqual(claim);
        expect(store.openDreamingRange(session.id, "main")!.id).toBe(rangeId);
        expect(lateWrite()).toContain("rejected:");
        expect(tools.find(tool => tool.name === "note")!.execute({ facts: [] })).toContain("Disabled");
        resolve({ outcome: "cancelled", output: "aborted", request: { fixture: "cc-auto-off", kind: "dreaming" } });
      }, { once: true }));
    };
    // The importer projection names real Store source IDs; only its native snapshot is unused by this scheduler.
    const projection: CcReconcileResult = { state: "ready", ...target, coreSessionId: session.id, selectedEntryIds: entries,
      selectedCount: entries.length, selectedTailId: entries.at(-1)!, selectedAppendedEntryIds: [], appendedEntryIds: [], problems: [],
      snapshot: { path: "/unused/fixture.jsonl", exists: true, size: 0, modifiedMs: 0, changedMs: 0, device: 0, inode: 0,
        completeBytes: 0, recordCount: 0, records: [], incompleteBytes: 0, changed: false, reset: false } };
    scheduler.reconcile(projection, false);
    expect(scheduler.startCatchup(projection).state).toBe("running");
    for (let i = 0; i < 30 && scheduler.running().length; i++) await new Promise<void>(resolve => setImmediate(resolve));
    expect(scheduler.running()).toEqual([]);
    expect(observedAbort).toBe(true);
    expect(nCalls).toBe(3); expect(dCalls).toBe(1);
    expect(scheduler.catchupStatus().state).toBe("stopped");
    expect(diagnostics.some(message => message.includes("off after three failures"))).toBe(true);
    expect(store.getClaim(session.id, "dreaming")).toBeNull();
    expect(store.openDreamingRange(session.id, "main")).toBeNull();
    expect(lateWrite()).toContain("rejected:");
    const processed = store.db.prepare("SELECT revision_id FROM knowledge_processed WHERE pool=? ORDER BY revision_id")
      .all(`session:${session.id}`).map(row => Number(row.revision_id));
    expect(processed).toEqual([skipped!.commit, own].sort((a, b) => a - b));
    expect(store.pendingVersions(`session:${session.id}`, target).map(item => item.revisionId)).toEqual([untouched!.commit]);
    expect(memory.pendingEntries(session.id, "main", turn.id).map(entry => entry.id)).toEqual(entries);
    expect(store.listRuns(session.id).filter(run => run.kind === "dreaming").at(-1)?.outcome).toBe("cancelled");
    expect(store.taskFailures(session.id).filter(item => item.phase === "dreaming")).toEqual([]);
    scheduler.reconcile({ ...projection, appendedEntryIds: entries, selectedAppendedEntryIds: entries });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(nCalls).toBe(3); expect(dCalls).toBe(1);
  } finally { scheduler.stop(); memory.close(); }
});
