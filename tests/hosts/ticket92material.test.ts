import { expect, test, vi } from "vitest";
import { sourceSeededMemory, seedSourceEntry, type NotingAgentInput } from "../source-fixture.ts";
import { CcTaskScheduler } from "../../src/hosts/cc/scheduler.ts";
import type { CcReconcileResult } from "../../src/hosts/cc/importer.ts";
import { resolveCcHostConfig } from "../../src/hosts/cc/config.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { submitEmpty } from "../support/noter.ts";

const worker = resolveCcHostConfig({ dbPath: "/unused/material.db", stateDir: "/unused/material",
  notingModel: "synthetic", notingThinking: "medium",
  "dreaming.model": "synthetic", "dreaming.thinking": "medium",
  // The worker's directory holds the Noter's workspaces, so it must exist.
  worker: { cwd: mkdtempSync(join(tmpdir(), "material-")), claudeExecutable: "/never-invoke-claude", contextWindows: { synthetic: 200_000, sonnet: 200_000 } } }).worker;

for (const cancel of [false, true]) {
  test(`ticket92material CC actual scheduler/core admission ${cancel ? "cancels without processing" : "drains exact multi-batch Raw"}`, async () => {
    const tasks: NotingAgentInput[] = [];
    let release: (() => void) | undefined;
    const memory = sourceSeededMemory(":memory:", async raw => {
      const input = raw as NotingAgentInput;
      tasks.push(input);
      const request = { text: input.text };
      input.reportRequest(request);
      if (cancel) await new Promise<void>(resolve => { release = resolve; });
      submitEmpty(input);
      return { outcome: "success", output: "done", request };
    });
    let scheduler: CcTaskScheduler | undefined;
    try {
      const project = memory.store.createProject({ name: "material", declaredBy: "mark" });
      const session = memory.store.createSession({ host: "cc:material", projectId: project.id, enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
      const turn = memory.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "evidence", startedAt: "now" });
      for (let index = 0; index < 12; index++) seedSourceEntry(memory, turn.id, "assistant", `${index} ${"source ".repeat(1200)}`);
      const entries = memory.store.listSourceEntries(session.id).map(entry => entry.id);
      memory.selectEntries(session.id, "main", entries);
      const projection: CcReconcileResult = { state: "ready", coreSessionId: session.id, branch: "main", headTurnId: turn.id,
        selectedEntryIds: entries, selectedCount: entries.length, selectedTailId: entries.at(-1)!, selectedAppendedEntryIds: [], appendedEntryIds: [], problems: [],
        snapshot: { path: "/unused/material/transcript", exists: true, size: 0, modifiedMs: 0, changedMs: 0, device: 0, inode: 0,
          completeBytes: 0, recordCount: 0, records: [], incompleteBytes: 0, changed: false, reset: false } };
      const diagnostics: string[] = [];
      scheduler = new CcTaskScheduler(memory, worker, message => diagnostics.push(message));
      scheduler.reconcile(projection);
      scheduler.startCatchup(projection);
      if (cancel) {
        await vi.waitFor(() => expect(release).toBeDefined());
        scheduler.stopCatchup("test cancellation");
        memory.cancelTasks();
        release!();
        await vi.waitFor(() => expect(scheduler!.running()).toEqual([]));
        expect(memory.pendingEntries(session.id, "main", turn.id).map(entry => entry.id)).toEqual(entries);
        expect(tasks).toHaveLength(1);
      } else {
        await vi.waitFor(() => expect(scheduler!.catchupStatus().state).toBe("completed"));
        const writes = tasks.filter(task => task.task === "write"); // each batch is a write run and a verify run over the same entries
        expect(writes.length).toBeGreaterThan(1);
        expect(tasks).toHaveLength(2 * writes.length);
        expect(writes.flatMap(task => task.entryIds)).toEqual(entries);
        for (const task of tasks) {
          expect(task.material.entries.map(entry => entry.id)).toEqual(task.entryIds);
          expect(task.text).toContain("Target session agent: Claude Code");
        }
        expect(memory.pendingEntries(session.id, "main", turn.id)).toEqual([]);
        expect(diagnostics).toEqual([]);
      }
    } finally { release?.(); scheduler?.stopCatchup("fixture shutdown"); memory.close(); }
  });
}
