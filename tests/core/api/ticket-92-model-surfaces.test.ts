import { expect, test } from "vitest";
import { sourceSeededMemory } from "../../source-fixture.ts";
import { noVisibility } from "../../../src/core/api/visible.ts";
import { sliceCcInjection, CC_KNOWLEDGE_RECENCY_NOTICE } from "../../../src/hosts/cc/slices.ts";
import { decodeCcInjection } from "../../../src/hosts/cc/injection.ts";

test("92/03: model lists and compact carriers use chronological tags; human reads keep commits; omissions carry only history addresses", () => {
  const memory = sourceSeededMemory(":memory:", async () => ({ outcome: "failure" as const, output: "unused" }));
  const store = memory.store;
  try {
    const project = store.createProject({ name: "surfaces", declaredBy: "mark" });
    const session = store.createSession({ projectId: project.id, host: "pi:surfaces", startedAt: "now", firstReplyAt: "now", enrollmentChoice: true });
    const turn = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "shared evidence", startedAt: "now" });
    const target = { sessionId: session.id, branch: "main", headTurnId: turn.id };
    const tools = memory.tools({ kind: "manual", ...target, currentTurnId: turn.id });
    const fact = JSON.parse(tools.find(t => t.name === "note")!.execute({ facts: [{ text: "Shared evidence", source: [`T${turn.id}#E1`] }] })).factIds[0];
    const content = { scope: "project" as const, topics: [], supports: [fact], reason: "fixture", createdAt: "now" };
    const created = store.commitConsolidationRun({ path: target, run: { kind: "manual", sessionId: session.id, createdAt: "now" }, operations: [
      { op: "create", handle: "$1", author: "test", ...content, category: "constraint", text: "Needle original" },
      { op: "create", handle: "$2", author: "test", ...content, category: "open", text: "Needle second" },
    ] });
    if (!created.ok) throw new Error(created.problems.join("; "));
    const first = created.committed[0]!, second = created.committed[1]!;
    const updated = store.commitConsolidationRun({ path: target, run: { kind: "consolidation", sessionId: session.id, createdAt: "now" }, operations: [{
      op: "update", knowledgeId: first.knowledgeId, baseCommit: first.commit, ...content, category: "constraint", text: "Needle latest",
    }] });
    if (!updated.ok) throw new Error(updated.problems.join("; "));
    const latest = updated.committed[0]!;
    const firstTag = `K${first.knowledgeId}#${store.versionTag(first.knowledgeId, latest.commit)}`;
    const secondTag = `K${second.knowledgeId}#${store.versionTag(second.knowledgeId, second.commit)}`;
    const injected = memory.injection(target, noVisibility(), true);
    const compacted = memory.compact(session.id, "main", turn.id, [], true);
    if ("native" in compacted) throw new Error("unexpected native delegation");
    for (const body of [injected.text, compacted.text, tools.find(t => t.name === "trace")!.execute({ address: project.name, pageBudget: 8000 })]) {
      expect(body).not.toMatch(/K\d+@\d+/);
      expect(body.indexOf(secondTag)).toBeLessThan(body.indexOf(firstTag));
      expect(body).not.toMatch(/<(constraint|open)>/);
    }
    const search = tools.find(t => t.name === "search")!.execute({ query: "Needle", layer: "knowledge", maxTokens: 8000 });
    expect(search.indexOf(`K${second.knowledgeId}@v1`)).toBeLessThan(search.indexOf(`K${first.knowledgeId}@v2`));
    expect(search).not.toContain(firstTag);
    expect(memory.trace(`K${first.knowledgeId}@${latest.commit}`)).toContain(`[K${first.knowledgeId}@${latest.commit}]`);
    const binding = { db: "92-surface", nativeSession: "native", coreSession: session.id };
    const slices = sliceCcInjection(binding, injected.transportItems!);
    const text = slices.filter(Boolean).map(slice => slice!.hookSpecificOutput.additionalContext).join("\n");
    expect(text).not.toMatch(/K\d+@\d+/);
    expect(text.split(CC_KNOWLEDGE_RECENCY_NOTICE)).toHaveLength(2); // one carrier, one knowledge list
    expect(text.indexOf(secondTag)).toBeLessThan(text.indexOf(firstTag));
    expect(slices.flatMap(slice => slice ? decodeCcInjection(slice.hookSpecificOutput.additionalContext, binding)!.commits : []).sort((a, b) => a - b))
      .toEqual([second.commit, latest.commit]);
    const omitted = sliceCcInjection(binding, [
      { kind: "knowledge", category: "constraint", commitId: latest.commit, address: `K${first.knowledgeId}@v2`, text: `[${firstTag}] ${"x".repeat(20_000)}` },
      { kind: "state", address: `K${first.knowledgeId}@v1`, receipt: { fromCommit: first.commit, toCommits: [latest.commit] }, text: "state ".repeat(4_000) },
    ]);
    const omissions = omitted.filter(Boolean).map(slice => slice!.hookSpecificOutput.additionalContext).join("\n");
    expect(omissions).toContain(`K${first.knowledgeId}@v2`);
    expect(omissions).toContain(`K${first.knowledgeId}@v1`);
    expect(omissions).not.toContain(firstTag);
    expect(omissions).not.toMatch(/K\d*@\d+/);
    expect(omitted.flatMap(slice => slice ? decodeCcInjection(slice.hookSpecificOutput.additionalContext, binding)!.commits : [])).toEqual([]);
  } finally { memory.close(); }
});
