import { expect, test } from "vitest";
import { sourceSeededMemory } from "../../source-fixture.ts";

// 03 changes addresses, not 41b's reason-on-history-lines contract.
test("92/41b: reasons belong to explicit history, not exact/current/collection bodies", () => {
  const memory = sourceSeededMemory(":memory:", async () => { throw new Error("no model expected"); });
  try {
    const project = memory.store.createProject({ name: "read-reasons", declaredBy: "mark" });
    const session = memory.store.createSession({ host: "pi:reasons", projectId: project.id, enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
    const turn = memory.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "Retain the rule", startedAt: "now" });
    const tools = memory.tools({ kind: "manual", sessionId: session.id, branch: "main", currentTurnId: turn.id });
    expect(tools[2]!.execute({ facts: [{ text: "User requested the rule", source: [`T${turn.id}#E1`] }] })).toContain("ok: F1");
    const content = { op: "create", text: "The durable rule", category: "constraint", scope: "project", supports: ["F1"], topics: [], reason: "REASON_INITIAL" };
    expect(tools[3]!.execute({ operations: [content, { ...content, text: "Another identity", reason: "OTHER_REASON" }], skipped: [] })).toContain("committed");
    const tag = `K1#${memory.store.versionTag(1, 1)}`;
    expect(tools[3]!.execute({ operations: [{ op: "archive", id: tag, supports: ["F1"], reason: "REASON_ARCHIVE" }], skipped: [] })).toContain("committed");
    const trace = (address: string, options: Record<string, unknown> = {}) => tools[0]!.execute({ address, ...options });
    for (const address of [tag, "K1@v1", "K1@v2", "K2", "read-reasons"]) {
      for (const fields of [["supports", "reason"], ["text", "reason"]]) {
        const page = trace(address, { fields, pageBudget: 8000 });
        expect(page).not.toContain("rejected:");
        expect(page).not.toContain("REASON_");
        expect(page).not.toContain("OTHER_REASON");
      }
    }
    for (const [address, options] of [["K1", { versions: "history" }], ["K1", { versions: "all" }], ["K1..", {}]] as const) {
      let page = trace(address, { ...options, fields: ["reason"], cap: 1 });
      const pages = [page];
      for (let cursor = /cursor=(\S+)/.exec(page)?.[1]; cursor; cursor = /cursor=(\S+)/.exec(page)?.[1]) {
        page = trace(`cursor=${cursor}`); pages.push(page);
        expect(pages.length).toBeLessThan(30);
      }
      expect(pages.length).toBeGreaterThan(1);
      const all = pages.join("\n");
      expect(all).not.toContain("rejected:");
      expect(all).toMatch(/^  K1@v1 .*reason: REASON_INITIAL$/m);
      expect(all).toMatch(/^  K1@v2 .*reason: REASON_ARCHIVE$/m);
      expect(all).not.toMatch(/K1#[a-z]+|K1@3\b/); // metadata has neither a tag nor a global commit
      const defaults = trace(address, { ...options, pageBudget: 8000 });
      expect(defaults).toContain("REASON_INITIAL");
      expect(defaults).toContain("REASON_ARCHIVE");
      expect(trace(address, { ...options, fields: ["text"], pageBudget: 8000 })).not.toContain("REASON_");
    }
  } finally { memory.close(); }
});
