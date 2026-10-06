import { expect, test } from "vitest";
import { sourceSeededMemory, memoryFiles } from "../../source-fixture.ts";
import { fact } from "../../support/seed.ts";

test("92/41b: reasons belong to history metadata, not current or exact bodies", () => {
  const memory = sourceSeededMemory(":memory:", async () => { throw new Error("no model expected"); });
  try {
    const project = memory.store.createProject({ name: "read-reasons", declaredBy: "mark" });
    const session = memory.store.createSession({ host: "pi:reasons", projectId: project.id, enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
    const turn = memory.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "Retain the rule", startedAt: "now" });
    const path = { sessionId: session.id, branch: "main", headTurnId: turn.id };
    const write = memory.tools({ kind: "manual", ...path, currentTurnId: turn.id }).find(tool => tool.name === "memory")!;
    const user = memory.store.getSourceEntry(memory.store.listSourceEntries(session.id, turn.id)[0]!.id)!;
    fact(memory, path, "Rule requested", [{ entry: user, text: "User requested the rule" }]);
    const content = { op: "create", text: "The durable rule", category: "constraint", scope: "project", supports: ["F1"], topics: [], reason: "REASON_INITIAL" };
    expect(write.execute(content)).toContain("committed");
    expect(write.execute({ ...content, text: "Another identity", reason: "OTHER_REASON" })).toContain("committed");
    const tag = `K1#${memory.store.versionTag(1, 1)}`;
    expect(write.execute({ op: "archive", kind: "budget", id: tag, supports: ["F1"], reason: "REASON_ARCHIVE" })).toContain("committed");
    const read = (address: string) => memoryFiles(memory, path).read(`trace://${address}`).content;
    for (const address of [tag, "K1@v1", "K1@v2", "K2"]) {
      expect(read(address)).not.toContain("REASON_");
      expect(read(address)).not.toContain("OTHER_REASON");
    }
    expect(() => read("K1..")).toThrow();
    const history = read("K1.history");
    expect(history).toMatch(/^  K1@v1 .*reason: REASON_INITIAL$/m);
    expect(history).toMatch(/^  K1@v2 .*reason: REASON_ARCHIVE$/m);
    expect(history).toContain(`[${tag}] [K1@v1]`);
    expect(history).not.toMatch(/K1@\d+\b|K1@v3\b/);
  } finally { memory.close(); }
});
