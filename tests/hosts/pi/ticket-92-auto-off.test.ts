import { expect, test, vi } from "vitest";
import { host, reply, type Reply } from "./test-host.ts";

function memoryCall(batch: { operations: Array<Record<string, string | string[]>>; skipped: Array<{ knowledge: string; because: string }> }): Reply {
  return { ...reply(""), stopReason: "toolUse", content: [{ type: "toolCall", id: "maintenance", name: "memory", arguments: batch }] };
}

// Real Pi extension/AgentSession with the existing local provider wire; no remote API.
test("92/07: Pi catchup third N failure cancels D, retaining its exact claim only through settlement", async () => {
  const f = host({ "noting.triggerTokens": 10_000, "noting.forkModeDefault": false, "dreaming.triggerTokens": 1 });
  let ready!: () => void;
  try {
    await f.emit("session_start");
    await f.prompt("three independent rules"); await f.answer();
    const store = f.memory.store, session = store.getSession(1)!;
    const turn = store.listTurns(session.id)[0]!;
    const target = { sessionId: session.id, branch: "main", headTurnId: turn.id };
    const tools = f.memory.tools({ kind: "manual", ...target, currentTurnId: turn.id });
    const factResult = tools.find(tool => tool.name === "note")!.execute({ facts: [{ title: "Three rules", sources: [{ address: `T${turn.id}#E1`, text: "Three rules have distinct purposes" }] }] });
    expect(factResult).not.toContain("rejected:");
    const noted = JSON.parse(factResult);
    expect(noted.factIds).toHaveLength(1);
    const written = store.commitConsolidationRun({ path: target, run: { kind: "manual", sessionId: session.id, createdAt: "now" }, operations: [1, 2, 3].map(n => ({
      op: "create", handle: `$${n}`, author: "fixture", text: `Rule ${n}`, category: "constraint", scope: "session", supports: [noted.factIds[0]], topics: [], reason: "evidence", createdAt: "now",
    })) });
    if (!written.ok) throw Error(written.problems.join("; "));
    const [changed, skipped, untouched] = written.committed;
    const entries = f.memory.pendingEntries(session.id, "main", turn.id).map(entry => entry.id);
    const dreamReady = new Promise<void>(resolve => { ready = resolve; });
    let nCalls = 0, dCalls = 0, own = 0, abortChecked = false;
    f.provider(async (conversation, signal): Promise<Reply> => {
      if (conversation.systemPrompt?.startsWith("# Noting")) {
        await dreamReady; nCalls++;
        return { ...reply(""), stopReason: "error", errorMessage: "intentional Noter failure" };
      }
      expect(conversation.systemPrompt).toContain("# Dreamer");
      dCalls++;
      if (dCalls === 1) return memoryCall({ operations: [{ op: "update", id: `K${changed!.knowledgeId}#${store.versionTag(changed!.knowledgeId, changed!.commit)}`,
        text: "Rule 1 maintained", category: "constraint", scope: "session", topics: [], supports: [], reason: "maintenance" }],
        skipped: [{ knowledge: `K${skipped!.knowledgeId}@v1`, because: "checked unchanged" }] });
      if (dCalls !== 2) throw Error(`Unexpected Dreamer provider round ${dCalls}`);
      const result = conversation.messages.filter(message => message.role === "toolResult").at(-1)!;
      expect(JSON.stringify(result)).not.toContain("rejected:");
      own = store.currentCommit(changed!.knowledgeId, target)[0]!.id;
      expect(own).not.toBe(changed!.commit);
      const claim = store.getClaim(session.id, "dreaming")!;
      const rangeId = store.openDreamingRange(session.id, "main")!.id;
      if (!signal) throw Error("Dreamer provider request has no cancellation signal");
      ready();
      return new Promise<Reply>(resolve => signal.addEventListener("abort", () => {
        expect(nCalls).toBe(3);
        expect(store.enabled(session.id)).toBe(false);
        expect(store.getClaim(session.id, "dreaming")).toEqual(claim);
        expect(store.openDreamingRange(session.id, "main")!.id).toBe(rangeId);
        expect(tools.find(tool => tool.name === "note")!.execute({ facts: [] })).toContain("Disabled");
        abortChecked = true;
        // Deliberately return a late write after abort; native cancellation must not dispatch it.
        resolve(memoryCall({ operations: [{ op: "archive", id: `K${untouched!.knowledgeId}#${store.versionTag(untouched!.knowledgeId, untouched!.commit)}`,
          supports: [], reason: "late forbidden write" }], skipped: [] }));
      }, { once: true }));
    }, { autoStop: false, ignoreAbort: true });
    await f.commands.get("trace")!.handler("catchup", f.ctx);
    await vi.waitFor(() => expect(store.enabled(session.id), f.notices.join("\n")).toBe(false));
    await vi.waitFor(() => expect(store.getClaim(session.id, "dreaming")).toBeNull());
    expect(abortChecked).toBe(true);
    expect(nCalls).toBe(3); expect(dCalls).toBe(2);
    expect(store.openDreamingRange(session.id, "main")).toBeNull();
    const processed = store.db.prepare("SELECT revision_id FROM knowledge_processed WHERE pool=? ORDER BY revision_id")
      .all(`session:${session.id}`).map(row => Number(row.revision_id));
    expect(processed).toEqual([skipped!.commit, own].sort((a, b) => a - b));
    expect(store.pendingVersions(`session:${session.id}`, target).map(item => item.revisionId)).toEqual([untouched!.commit]);
    expect(store.currentCommit(untouched!.knowledgeId, target)[0]!.id).toBe(untouched!.commit);
    expect(f.memory.pendingEntries(session.id, "main", turn.id).map(entry => entry.id)).toEqual(entries);
    expect(store.taskFailures(session.id).filter(item => item.phase === "dreaming")).toEqual([]);
    expect(store.listRuns(session.id).filter(run => run.kind === "dreaming").at(-1)?.outcome).toBe("cancelled");
    expect(f.notices.some(message => message.includes("off after three failures"))).toBe(true);
    await f.emit("agent_settled"); await f.drain();
    expect(nCalls).toBe(3); expect(dCalls).toBe(2);
  } finally { ready?.(); await f.dispose(); }
});
