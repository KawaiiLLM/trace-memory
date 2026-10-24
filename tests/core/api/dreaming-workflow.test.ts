import { afterEach, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import type { KnowledgeCategory, KnowledgeScope } from "../../../src/core/model/index.ts";
import type { TraceMemory } from "../../source-fixture.ts";
import { dreamerFixture } from "../../support/dreamer.ts";
import { block } from "../../support/workspace.ts";

interface ParentExample { text: string; category: KnowledgeCategory; scope: KnowledgeScope; topics: string[] }
interface WorkflowExample {
  id: string; judgment: "faithful" | "avoid" | "honest-loss";
  archived?: ParentExample & { reason: string }; parents: ParentExample[]; result: Record<string, unknown>; review: string;
}
interface WorkflowFixture {
  provenance: string; semanticReview: { authority: string; limitations: string[] };
  promptOrder: string[]; examples: WorkflowExample[];
}
const fixture = JSON.parse(readFileSync(new URL("../../fixtures/dreaming-workflow.json", import.meta.url), "utf8")) as WorkflowFixture;
const active: TraceMemory[] = [];
afterEach(() => { for (const memory of active.splice(0)) memory.close(); });
const example = (id: string) => { const found = fixture.examples.find(value => value.id === id); if (!found) throw new Error(`Missing ${id}`); return found; };


test("35c faithful merge keeps authority, conditions, exception and rendered topics through a real Dreamer run", async () => {
  const reviewed = example("faithful-authority-merge"), body = reviewed.result as unknown as ParentExample;
  const f = dreamerFixture(active);
  const items = reviewed.parents.map(parent => f.item(parent.text, { category: parent.category as "constraint", scope: parent.scope }));
  f.dreamer.script.curate!.constraint = block(`merge ${items[0]!.ref}`, { absorb: items[1]!.ref, category: body.category, scope: body.scope,
    topics: body.topics.join(", "), reason: "Reviewed complete claims retain authority, condition, exception, and subjects" }, body.text);
  const outcome = await f.dream();
  expect(outcome.outcome, JSON.stringify(outcome)).toBe("success");
  const current = f.store.currentCommit(items[0]!.knowledgeId, f.path)[0]!;
  expect(current).toMatchObject({ files: null, op: "merge", text: body.text, category: body.category, scope: body.scope, topics: [...body.topics].sort() });
  const rendered = f.memory.trace(`K${items[0]!.knowledgeId}@v2`);
  expect(rendered).toContain("artifacts may be prepared before deployment");
  expect(rendered).toContain('topics: ["artifact-preparation","deployment","offline-runtime"]');
});

