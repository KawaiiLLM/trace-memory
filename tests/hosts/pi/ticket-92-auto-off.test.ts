import { expect, test, vi } from "vitest";
import { host, reply, dreamerFiles, type Reply } from "./test-host.ts";
import { knowledgeBatch } from "../../support/seed.ts";
import { block } from "../../support/workspace.ts";

// Real Pi extension/AgentSession with the existing local provider wire; no remote API.
test("92/07: Pi catchup third N failure cancels D, retaining its exact claim only through settlement", async () => {
  const f = host({ "noting.triggerTokens": 10_000, "dreaming.triggerOperations": 1 });
  let ready!: () => void;
  try {
    await f.emit("session_start");
    await f.prompt("three independent rules"); await f.answer();
    const store = f.memory.store, session = store.getSession(1)!;
    const turn = store.listTurns(session.id)[0]!;
    const target = { sessionId: session.id, branch: "main", headTurnId: turn.id };
    const tools = f.memory.tools({ kind: "manual", ...target, currentTurnId: turn.id });
    const factResult = tools.find(tool => tool.name === "note")!.execute({ title: "Three rules", sources: `[T${turn.id}#E1] Three rules have distinct purposes` });
    expect(factResult).not.toContain("rejected:");
    const noted = JSON.parse(factResult);
    expect(noted.factIds).toHaveLength(1);
    // Noter-written items make the Dreamer due (2026-10-22).
    const written = knowledgeBatch(store, target, [1, 2, 3].map(n => ({ scope: "project" as const, category: "constraint" as const, supports: [noted.factIds[0]], text: `Rule ${n}`, title: "Fixture title" })));
    const [changed, skipped, untouched] = written.committed;
    const entries = f.memory.pendingEntries(session.id, "main", turn.id).map(entry => entry.id);
    const dreamReady = new Promise<void>(resolve => { ready = resolve; });
    let nCalls = 0, abortChecked = false, claim: ReturnType<typeof store.getClaim> = null, revisionsAtAbort = 0;
    const revisions = () => store.listKnowledgeRevisions().length;
    const rewrite = block(`update K${changed!.knowledgeId}@v1`, { reason: "maintenance" }, "Rule 1 maintained");
    const late = (conversation: { messages: unknown[] }): Reply => ({ ...reply(""), stopReason: "toolUse", content: [{ type: "toolCall", id: "late", name: "write", arguments: {
      path: /Scores: (\S+?\.md)/.exec(JSON.stringify(conversation.messages))![1]!,
      content: `K${changed!.knowledgeId} 4 4 4\n` } as never }] });
    f.provider(async (conversation, signal): Promise<Reply> => {
      if (conversation.systemPrompt?.startsWith("# Noting")) {
        await dreamReady; nCalls++;
        return { ...reply(""), stopReason: "error", errorMessage: "intentional Noter failure" };
      }
      expect(conversation.systemPrompt).toMatch(/^# (Dreamer|Classifying)/);
      const scoring = /Task: scoring/.test(JSON.stringify(conversation.messages));
      if (!scoring) return dreamerFiles(conversation, { curate: rewrite }) ?? reply("Done");
      claim = store.getClaim(session.id, "dreaming");
      if (!signal) throw Error("Dreamer provider request has no cancellation signal");
      ready();
      return new Promise<Reply>(resolve => signal.addEventListener("abort", () => {
        expect(nCalls).toBe(3);
        expect(store.enabled(session.id)).toBe(false);
        // The same claim row stays until settlement; switching memory off only expires its lease.
        expect(store.getClaim(session.id, "dreaming")).toEqual({ ...claim, expiresAt: 0 });
        expect(tools.find(tool => tool.name === "note")!.execute({})).toContain("Disabled");
        revisionsAtAbort = revisions();
        abortChecked = true;
        // Return a late scoring write after abort; native cancellation must not dispatch it.
        resolve(late(conversation));
      }, { once: true }));
    }, { autoStop: false, ignoreAbort: true });
    await f.commands.get("trace")!.handler("catchup", f.ctx);
    await vi.waitFor(() => expect(store.enabled(session.id), f.notices.join("\n")).toBe(false));
    await vi.waitFor(() => expect(store.getClaim(session.id, "dreaming")).toBeNull());
    expect(abortChecked).toBe(true);
    expect(nCalls).toBe(3);
    // 169: scoring and curate are unpublished; a late write after abort changes nothing.
    expect(revisions()).toBe(revisionsAtAbort);
    expect(store.currentKnowledge(target).find(value => value.knowledge.id === changed!.knowledgeId)!.revision.text).toBe("Rule 1");
    expect(store.currentCommit(untouched!.knowledgeId, target)[0]!.id).toBe(untouched!.commit);
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM knowledge_processed WHERE pool=?").get(`project:${session.projectId}`)!.n).toBe(0);
    expect(store.getKnowledge(changed!.knowledgeId)!.score).toBeNull();
    expect(f.memory.pendingEntries(session.id, "main", turn.id).map(entry => entry.id)).toEqual(entries);
    expect(store.taskFailures(session.id).filter(item => item.phase === "dreaming")).toEqual([]);
    expect(store.listRuns(session.id).filter(run => run.kind === "dreaming").at(-1)?.outcome).toBe("cancelled");
    expect(f.notices.some(message => message.includes("off after three failures"))).toBe(true);
    const settled = f.requests.length;
    await f.emit("agent_settled"); await f.drain();
    expect(nCalls).toBe(3); expect(f.requests).toHaveLength(settled);
  } finally { ready?.(); await f.dispose(); }
});
