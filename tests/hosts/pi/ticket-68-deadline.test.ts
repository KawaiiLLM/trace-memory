import { expect, test, vi } from "vitest";
import { host, reply, dreamerFiles, type Reply } from "./test-host.ts";
import { knowledge } from "../../support/seed.ts";
import { block } from "../../support/workspace.ts";

test("68: shared deadline fences a real Pi worker, releases its claim and permits the next run", async () => {
  const h = host({ "noting.triggerTokens": 1e9, "dreaming.triggerOperations": 1, "dreaming.timeoutMs": 300 });
  let release!: () => void, signal: AbortSignal | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    await h.emit("session_start"); await h.turn();
    const store = h.memory.store, path = { sessionId: 1, branch: "main", headTurnId: 1 };
    const user = store.sourcePath(1, "main", 1).find(value => store.getSourceEntry(value.id)?.role === "user")!;
    const note = h.memory.tools({ kind: "manual", ...path, currentTurnId: 1 }).find(tool => tool.name === "note")!;
    expect(JSON.parse(note.execute({ title: "A rule", sources: `[T1#E${user.entryOrdinal}] A rule` })).factIds).toHaveLength(1);
    // A Noter-written item makes the Dreamer due (2026-10-22).
    const item = knowledge(store, path, "project", "constraint", [1], "A durable rule", { operation: { title: "Fixture title" } });
    const revisions = () => store.listKnowledgeRevisions().length, before = revisions();
    let hung = false;
    // The model checks, then its next request hangs past the deadline and answers late with a valid batch.
    h.provider(async (c, abort): Promise<Reply> => {
      if (!hung && c.messages.some(m => m.role === "toolResult")) {
        hung = true; signal = abort; await gate;
        const file = /File: (\S+?\.md)/.exec(JSON.stringify(c.messages))![1]!;
        return { ...reply(""), stopReason: "toolUse", content: [{ type: "toolCall", id: "late", name: "write", arguments: {
          path: file, content: block(`update K${item.knowledgeId}@v1`, { reason: "too late" }, "A durable rule, too late") } as never }] };
      }
      return dreamerFiles(c) ?? reply("Done");
    }, { autoStop: false, ignoreAbort: true });
    await h.turn();
    await vi.waitFor(() => expect(store.listRuns(1).filter(run => run.kind === "dreaming").at(-1)?.outcome).toBe("failure"), { timeout: 4000 });
    const failed = store.listRuns(1).filter(run => run.kind === "dreaming").at(-1)!;
    expect(JSON.parse(failed.response!).problems.join(" ")).toMatch(/timeout|deadline|300 ms/i);
    expect(signal?.aborted).toBe(true);
    expect(store.getClaim(1, "dreaming")).toBeNull();
    expect(store.handoff(1, "dreaming")).toMatchObject({ nextTask: "notes" });
    release(); await h.drain();
    expect(revisions()).toBe(before); // the late write changed nothing
    // The next run is admitted and completes.
    h.provider(async c => dreamerFiles(c) ?? reply("Done"), { autoStop: false });
    await h.turn(); await h.drain();
    expect(store.noterOperations(store.knowledgePath(1))).toBe(0);
    expect(store.getClaim(1, "dreaming")).toBeNull();
    expect(store.enabled(1)).toBe(true);
  } finally { release(); await h.dispose(); }
});
