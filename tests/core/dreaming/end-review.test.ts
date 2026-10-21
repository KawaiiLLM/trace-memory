import { afterEach, expect, test } from "vitest";
import { hydrate, sourceSeededMemory, type DreamingAgentInput } from "../../source-fixture.ts";
import { archive, fact as seedFact, fixtureTitle, knowledgeBatch } from "../../support/seed.ts";
import { dreamerWrite } from "../../dreaming-skips.ts";

const memories: { close(): void }[] = [];
afterEach(() => { for (const memory of memories.splice(0)) memory.close(); });

const longBody = (head: string, tail: string) =>
  `${head}。这条规则的背景是：多个会话反复遇到同类问题，所以把处理方式固定下来，并且要求每次都先核对来源再动手，避免凭印象改写。${tail}`;
const invalidReason = "The rule no longer holds: the user corrected its basis; another rule replaces it.";

/** A pool of pending project knowledge, every item due, and a fake provider that plays the host's
 * pass protocol: first pass, then the end review once (`passEnd`) and, if it was sent, a second pass. */
function pool(bodies: (string | { text: string; scope: "global" | "project" | "session"; title?: string })[], pass: { first(task: DreamingAgentInput, tool: Tool, items: Item[]): void;
  second?(task: DreamingAgentInput, tool: Tool, items: Item[], review: string): void }, archived: number[] = []) {
  const reviews: (string | undefined)[] = [];
  let items!: Item[];
  const memory = sourceSeededMemory(":memory:", async raw => {
    const task = raw as DreamingAgentInput;
    task.reportRequest({ fixture: "end review" });
    const find = (name: string) => task.tools.find(t => t.name === name)! as { execute(input: unknown): string };
    // 127: a scripted write is one memory call per operation and per skip.
    const tool: Tool = (name, input) => JSON.parse(name === "memory" ? dreamerWrite(find(name), input as Parameters<typeof dreamerWrite>[1]) : find(name).execute(input));
    pass.first(task, tool, items);
    const review = task.passEnd(1);
    reviews.push(review);
    if (review !== undefined) pass.second?.(task, tool, items, review);
    reviews.push(task.passEnd(2));
    return { outcome: "success", output: "done", request: { fixture: "end review" } };
  }, { dreaming: { triggerTokens: 1 } });
  memories.push(memory);
  const store = memory.store;
  const project = store.createProject({ name: "end-review", declaredBy: "mark" });
  const session = store.createSession({ projectId: project.id, host: "pi:dream", startedAt: "now", firstReplyAt: "now", enrollmentChoice: true });
  const turn = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "Evidence", startedAt: "now" });
  const target = { sessionId: session.id, branch: "main", headTurnId: turn.id };
  const user = hydrate(store.listSourceEntries(session.id, turn.id), store).find(entry => entry.role === "user")!;
  const evidence = seedFact(memory, target, "Evidence", [{ entry: user, text: "User gave evidence" }]).id;
  const created = knowledgeBatch(store, target, bodies.map(body => ({ category: "constraint" as const,
    supports: [evidence], ...typeof body === "string" ? { text: body, scope: "project" as const } : body })), { kind: "manual", createdAt: "now" });
  // An item archived before the run is still pending for it, addressed by its archive version.
  for (const index of archived) { const { knowledgeId, commit } = created.committed[index]!;
    created.committed[index] = { op: "archive", knowledgeId, commit: archive(store, target, knowledgeId, commit, [evidence], "budget") }; }
  items = created.committed.map(({ knowledgeId, commit }) => ({ knowledgeId, tag: tagOf(knowledgeId, commit),
    skip: `K${knowledgeId}@v${store.versionOrdinal(knowledgeId, commit)}` }));
  function tagOf(knowledgeId: number, commit: number) { return `K${knowledgeId}#${store.versionTag(knowledgeId, commit)}`; }
  /** The run's latest version of an item, as the model would address it after the receipt. */
  const current = (item: Item) => {
    const revisions = store.listKnowledgeRevisions(item.knowledgeId);
    return tagOf(item.knowledgeId, revisions.at(-1)!.id);
  };
  return { memory, store, target, reviews, items: () => items, current, run: () => memory.dream(target) };
}
/** The two sections of a review by structure: the blockers and the change blocks, without the closing instruction. */
const sections = (review: string) => {
  const [head, rest] = review.split("\n\nKnowledge changes committed in this run:\n") as [string, string];
  return { blockers: head.split("\n\nBlockers:\n")[1]!, changes: rest.slice(0, rest.lastIndexOf("\n\n")) };
};
type Tool = (name: "memory" | "check", input: unknown) => any;
type Item = { knowledgeId: number; tag: string; skip: string };
const skipAll = (items: Item[]) => ({ operations: [], skipped: items.map(item => ({ knowledge: item.skip, because: "Reviewed unchanged" })) });
const update = (id: string, text: string, scope = "project") => ({ op: "update", id, text, category: "constraint", scope, topics: [], supports: [], reason: "rewrite" });
const ok = (receipt: { results: string[] }) => expect(receipt.results.join("; ")).not.toContain("rejected");

test("the review is sent once after the first pass and no later pass end sends another", async () => {
  const p = pool(["Rule A body."], { first: (_task, tool, items) => ok(tool("memory", skipAll(items))) });
  const result = await p.run();
  expect(result.outcome).toBe("success");
  expect(p.reviews).toHaveLength(2);
  expect(p.reviews[0]).toMatch(/^Before this run ends, review it once\./);
  expect(p.reviews[1]).toBeUndefined();
});

test("both parts render, with None. for a run that changed nothing and has no blocker", async () => {
  const p = pool(["Rule A body."], { first: (_task, tool, items) => ok(tool("memory", skipAll(items))) });
  await p.run();
  expect(sections(p.reviews[0]!)).toEqual({ blockers: "None.", changes: "None." });
});

test("the blockers are the run's check blockers, one per line", async () => {
  const p = pool(["Rule A body.", "Rule B body."], { first: () => {} });
  await p.run();
  const { blockers, changes } = sections(p.reviews[0]!);
  expect(blockers).toMatch(/^frozen versions not deliberated: K\d+@v1, K\d+@v1$/);
  expect(changes).toBe("None.");
});

test("126: the review lists the run's changes in every pool, and a pool left over budget is a blocker", async () => {
  const p = pool([{ text: "Global rule body.", scope: "global" }, { text: "Project rule body.", scope: "project" }], {
    first(_task, tool, [global, project]) {
      ok(tool("memory", { operations: [update(global!.tag, "Global rule body, extended well past its budget.", "global"),
        update(project!.tag, "Project rule body, clarified.")], skipped: [] }));
    } });
  p.memory.setKnowledgeBudget("global", 5);
  const result = await p.run();
  expect(result.outcome).toBe("failure");
  const [global, project] = p.items(), { blockers, changes } = sections(p.reviews[0]!);
  expect(blockers).toMatch(/^pool global over budget: \d+\/5 tokens$/);
  for (const item of [global!, project!]) expect(changes).toContain(p.current(item));
});

test("134: two changes show one net full-body diff, and unchanged or reverted items are absent", async () => {
  const bodies = [longBody("规则甲", "结尾甲"), longBody("规则乙", "结尾乙"), longBody("规则丙", "结尾丙")];
  const p = pool(bodies, { first(_task, tool, [a, b, c]) {
    const first = tool("memory", { operations: [update(a!.tag, longBody("规则甲", "结尾甲，新增一条边界：不 stash"))], skipped: [] });
    ok(first);
    const next = p.current(a!);
    ok(tool("memory", { operations: [update(next, longBody("规则甲", "结尾甲，新增一条边界：不 stash／reset"))], skipped: [] }));
    // B is rewritten and then restored to the version it started from: net unchanged.
    ok(tool("memory", { operations: [update(b!.tag, "temporary")], skipped: [] }));
    ok(tool("memory", { operations: [update(p.current(b!), bodies[1]!)], skipped: [] }));
    ok(tool("memory", { operations: [], skipped: [{ knowledge: c!.skip, because: "Reviewed unchanged" }] }));
  } });
  const result = await p.run();
  expect(result.outcome).toBe("success");
  const [a, b, c] = p.items();
  const message = p.reviews[0]!;
  expect(message.match(/^\[K\d+#[a-z]+\]/gm)).toEqual([`[${p.current(a!)}]`]);
  expect(message).toContain(bodies[0]!.split("。")[1]! + "。");
  expect(message).toContain("结尾甲，新增一条边界：不 stash／reset");
  expect(message.match(/新增一条边界/g)).toHaveLength(1);
  expect(message).not.toContain("[...]");
  expect(message).not.toContain(`K${b!.knowledgeId}#`);
  expect(message).not.toContain(`K${c!.knowledgeId}#`);
  expect(message).not.toContain("Commits: none");
});

test("each operation kind renders as specified: merge, split, invalid and budget archive, category change", async () => {
  const bodies = ["Survivor body " + "x".repeat(60) + " end.", "Absorbed body to disappear.", "Parent body to split.",
    "Obsolete body.", "Budget body leaving the pool.", "Category body."];
  const p = pool(bodies, { first(_task, tool, [survivor, absorbed, parent, obsolete, budget, category]) {
    ok(tool("memory", { operations: [
      { op: "merge", id: survivor!.tag, absorb: [absorbed!.tag], text: "Survivor body " + "x".repeat(60) + " end, with the absorbed rule.",
        category: "constraint", scope: "project", topics: [], supports: [], reason: "same rule" },
      { op: "split", id: parent!.tag, children: [{ title: "Fixture child", text: "Child one.", category: "constraint", topics: [] },
        { title: "Fixture child", text: "Child two.", category: "reference", topics: [] }], supports: [], reason: "two rules" },
      { op: "archive", kind: "invalid", id: obsolete!.tag, text: invalidReason, supports: [], reason: "contradicted" },
      { op: "archive", kind: "budget", id: budget!.tag, supports: [], reason: "over budget" },
      { ...update(category!.tag, "Category body."), category: "reference" }], skipped: [] }));
  } });
  const result = await p.run();
  expect(result.outcome, JSON.stringify(result)).toBe("success");
  const [survivor, absorbed, parent, obsolete, budget, category] = p.items();
  const store = p.store, tag = (item: Item) => `K${item.knowledgeId}#${store.versionTag(item.knowledgeId, store.listKnowledgeRevisions(item.knowledgeId).at(-1)!.id)}`;
  const blocks = sections(p.reviews[0]!).changes.split("\n\n");
  const byHead = (item: Item) => blocks.find(block => block.includes(`K${item.knowledgeId}#`))!;
  expect(blocks).toHaveLength(8);
  const survivorBlock = blocks.find(block => block.startsWith(`[${tag(survivor!)}]`))!;
  expect(survivorBlock).toContain("{+, with the absorbed rule+}");
  expect(byHead(absorbed!)).toBe(`${absorbed!.tag} (merged into ${tag(survivor!)}):\n${fixtureTitle(bodies[1]!)}\n[-${bodies[1]}-]`);
  expect(byHead(parent!)).toMatch(new RegExp(`^${parent!.tag} \\(split into K\\d+#[a-z]+, K\\d+#[a-z]+\\):\\n${fixtureTitle(bodies[2]!)}\\n\\[-${bodies[2]}-\\]$`));
  expect(blocks.filter(block => /\(split from K\d+\)/.test(block)).map(block => block.split("\n").slice(1))).toEqual([["Fixture child", "{+Child one.+}"], ["Fixture child", "{+Child two.+}"]]); // a whole body carries its title
  expect(byHead(obsolete!)).toBe(`${tag(obsolete!)} (archive: invalid; reason: contradicted):\n${fixtureTitle(bodies[3]!)}\n[-${bodies[3]}-]\narchive text: ${invalidReason}`);
  expect(byHead(budget!)).toBe(`${tag(budget!)} (archive: budget; reason: over budget):\n${fixtureTitle(bodies[4]!)}\n[-${bodies[4]}-]`);
  expect(byHead(category!)).toBe(`[${tag(category!)}]\n  category: constraint -> reference`);
});

test("the second pass is a further operation on the run's own latest version and success is evaluated after it", async () => {
  const bodies = ["Rule A body.", "Rule B body."];
  const corrected = pool(bodies, {
    first: (_task, tool, [a]) => ok(tool("memory", { operations: [update(a!.tag, "Rule A rewritten.")], skipped: [] })),
    second(_task, tool, [a, b], review) {
      expect(review).toContain(`frozen versions not deliberated: ${b!.skip}`);
      expect(review).toContain("{+rewritten+}");
      ok(tool("memory", { operations: [update(corrected.current(a!), "Rule A restored.")], skipped: [{ knowledge: b!.skip, because: "Reviewed unchanged" }] }));
    } });
  const result = await corrected.run();
  expect(result.outcome, JSON.stringify(result)).toBe("success");
  const [a] = corrected.items();
  expect(corrected.store.listKnowledgeRevisions(a!.knowledgeId).map(revision => revision.text)).toEqual(["Rule A body.", "Rule A rewritten.", "Rule A restored."]);

  const unresolved = pool(bodies, { first: (_task, tool, [a]) => ok(tool("memory", { operations: [update(a!.tag, "Rule A rewritten.")], skipped: [] })) });
  const failed = await unresolved.run();
  expect(unresolved.reviews).toHaveLength(2); // both pass ends were reached, so the expected failure hides no assertion error
  expect(failed.outcome).toBe("failure");
  expect("problems" in failed && failed.problems.join(" ")).toContain("frozen versions not deliberated");
});

test("an item rewritten and then archived, split or absorbed shows the body the run started from as removed", async () => {
  const boundary = "Keep the routine. Never stash or reset the user's work.", kept = "Keep the routine.";
  const bodies = ["Survivor body.", boundary + " (absorbed)", boundary + " (budget)", boundary + " (split)", boundary + " (invalid)"];
  const p = pool(bodies, { first(_task, tool, [survivor, absorbed, budget, parent, invalid]) {
    const rewrite = (item: Item, text: string) => ok(tool("memory", { operations: [update(p.current(item), text)], skipped: [] }));
    for (const [item, text] of [[absorbed, kept + " (absorbed)"], [budget, kept + " (budget)"], [parent, kept + " (split)"], [invalid, kept + " (invalid)"]] as const) rewrite(item!, text);
    ok(tool("memory", { operations: [
      { op: "merge", id: survivor!.tag, absorb: [p.current(absorbed!)], text: "Survivor body.", category: "constraint", scope: "project", topics: [], supports: [], reason: "same rule" },
      { op: "archive", kind: "budget", id: p.current(budget!), supports: [], reason: "over budget" },
      { op: "split", id: p.current(parent!), children: [{ title: "Fixture child", text: "One.", category: "constraint", topics: [] }, { title: "Fixture child", text: "Two.", category: "constraint", topics: [] }], supports: [], reason: "two rules" },
      { op: "archive", kind: "invalid", id: p.current(invalid!), text: invalidReason, supports: [], reason: "contradicted" }], skipped: [] }));
  } });
  const result = await p.run();
  expect(result.outcome, JSON.stringify(result)).toBe("success");
  const [, absorbed, budget, parent, invalid] = p.items();
  const blocks = sections(p.reviews[0]!).changes.split("\n\n");
  const block = (item: Item) => blocks.find(value => value.startsWith(`K${item.knowledgeId}#`))!;
  expect(block(absorbed!)).toContain(`\n[-${bodies[1]}-]`);
  expect(block(budget!)).toContain(`\n[-${bodies[2]}-]`);
  expect(block(parent!)).toContain(`\n[-${bodies[3]}-]`);
  expect(block(invalid!)).toContain(`\n[-${bodies[4]}-]\narchive text: ${invalidReason}`);
  for (const value of blocks) expect(value).not.toContain(`[-${kept} (`); // never the intermediate rewrite
});

test("an archived item revived with the same body is reported as restored, with its full body", async () => {
  const p = pool([{ text: "Rule A body.", scope: "project", title: "Rule A title" }, "Rule B body."], { first(_task, tool, [a, b]) {
    ok(tool("memory", { operations: [update(a!.tag, "Rule A body.")], skipped: [{ knowledge: b!.skip, because: "Reviewed unchanged" }] }));
  } }, [0]);
  const result = await p.run();
  expect(result.outcome, JSON.stringify(result)).toBe("success");
  const { changes } = sections(p.reviews[0]!), [a] = p.items();
  expect(changes).toBe(`${p.current(a!)} (restored from archive):\nRule A title\n{+Rule A body.+}`);
});
