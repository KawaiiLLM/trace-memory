import { afterEach, expect, test } from "vitest";
import { TraceMemory, memoryFiles } from "../../../src/core/api/index.ts";
import { curateNow } from "../../support/dreamer.ts";
import { block } from "../../support/workspace.ts";
import type { Store } from "../../../src/core/store/index.ts";
import { receiptCommit } from "../../support/seed.ts";

const tagged = (store: Store, id: number, commit: number) => `K${id}#${store.versionTag(id, commit)}`;
const history = (store: Store, id: number, commit: number) => `K${id}@v${store.versionOrdinal(id, commit)}`;

const memories: ReturnType<typeof TraceMemory>[] = [];
afterEach(() => { for (const memory of memories.splice(0)) memory.close(); });
const at = "2026-09-12T00:00:00.000Z";
const success = { outcome: "success", output: "reviewed", request: { exact: "offline" } } as const;
type Branch = "root" | "left" | "right";
type Operation = "archive" | "split" | "merge-into" | "merge-absorb";

function pathFixture(seedOlderSurvivor = false) {
  const memory = TraceMemory(":memory:", async () => success); memories.push(memory);
  const store = memory.store;
  const project = store.createProject({ name: "shared", declaredBy: "mark" });
  const session = store.createSession({ host: "test", projectId: project.id, enrollmentChoice: true, startedAt: at, firstReplyAt: at });
  const turn = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "root", startedAt: at });
  const append = (nativeId: string) => memory.appendEntry({ sessionId: session.id, turnId: turn.id,
    nativeLineage: "native", nativeId, role: "user", text: nativeId, raw: nativeId, calls: [] });
  const root = append("root"), left = append("left"), right = append("right");
  memory.selectEntries(session.id, "root", [root.id]);
  memory.selectEntries(session.id, "left", [root.id, left.id]);
  memory.selectEntries(session.id, "right", [root.id, right.id]);
  const noted = store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, branch: "root", createdAt: at }, facts: [{
    turnId: turn.id, entryIds: [root.id], category: "decision", actor: "user", text: "shared evidence",
    source: [`T${turn.id}#E${root.entryOrdinal}`], createdAt: at,
  }] });
  if (!noted.ok) throw new Error(noted.problems.join("; "));
  const fact = noted.facts[0]!.id;
  const branchFacts = { root: fact } as Record<Branch, number>;
  for (const branch of ["left", "right"] as const) {
    const entry = { left, right }[branch];
    const result = store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, branch, createdAt: at }, facts: [{
      turnId: turn.id, entryIds: [entry.id], category: "decision", actor: "user", text: `${branch} evidence`,
      source: [`T${turn.id}#E${entry.entryOrdinal}`], createdAt: at,
    }] });
    if (!result.ok) throw new Error(result.problems.join("; "));
    branchFacts[branch] = result.facts[0]!.id;
  }
  const manual = memory.tools({ kind: "manual", sessionId: session.id, branch: "root", currentTurnId: turn.id, triggerEntryId: root.id });
  const create = (text: string) => {
    const receipt = JSON.parse(manual.find(tool => tool.name === "memory")!.execute({ files: null, op: "create", title: "Fixture title", text,
      category: "constraint", scope: "project", supports: [`F${fact}`], topics: [], reason: `Create ${text}.` }));
    expect(receipt.committed).toHaveLength(1);
    const item = receipt.committed[0] as { knowledgeId: number; version: string };
    return { knowledgeId: item.knowledgeId, commit: receiptCommit(store, item) };
  };
  const older = seedOlderSurvivor ? create("older survivor") : undefined;
  const base = create("base");
  const entries = { root, left, right };
  const path = (branch: Branch) => ({ sessionId: session.id, branch, headTurnId: turn.id, triggerEntryId: entries[branch].id });
  return { memory, store, project, session, turn, entries, fact, branchFacts, older, base, path, create };
}

/** The operation as one curate block on the branch's path (the Dreamer's pass); the base is named by its exact version address. */
function runOperation(f: ReturnType<typeof pathFixture>, branch: Branch, _sequence: number,
  operation: Operation | "update", text: string) {
  const path = f.path(branch);
  f.store.setCurrentPath(f.session.id, branch, f.turn.id, "test-lineage");
  const mergeOther = operation === "merge-into" ? f.create("merge peer") : f.older;
  const ref = (item: { knowledgeId: number; commit: number }) => history(f.store, item.knowledgeId, item.commit);
  const common = { supports: `F${f.branchFacts[branch]}`, reason: `${operation} on ${branch}.` };
  const child = (title: string, body: string) => `\n### child\ntitle: ${title}\ncategory: constraint\nscope: project\ntopics:\nsupports: ${common.supports}\nreason: ${common.reason}\n\n${body}\n`;
  let file: string;
  if (operation === "archive") file = block(`archive ${ref(f.base)}`, { kind: "invalid", reason: common.reason }, "The user withdrew this the same day; nothing replaces it.");
  else if (operation === "split") file = block(`split ${ref(f.base)}`, common, "Primary part.") + child("Fixture child", `${text} one`) + child("Fixture child", `${text} two`);
  else if (operation === "merge-into") file = block(`merge ${ref(f.base)}`, { absorb: ref(mergeOther ?? (() => { throw new Error("missing merge identity"); })()), ...common }, text);
  else if (operation === "merge-absorb") file = block(`merge ${ref(f.older ?? (() => { throw new Error("missing older survivor"); })())}`, { absorb: ref(f.base), ...common }, text);
  else file = block(`update ${ref(f.base)}`, common, text);
  const result = curateNow(f.memory, path, file);
  expect(result.blocks.map(entry => entry.status), JSON.stringify(result.blocks)).toEqual(["applied"]);
  return result;
}

// The old update-origin test is retired: ticket-64b.test.ts proves divergent updates and their multi-parent join.
test.each(["archive", "split", "merge-into", "merge-absorb"] as const)(
  "64b: %s uses the owner foreground for current-base and divergent behavior", operation => {
    const f = pathFixture(operation === "merge-absorb");
    runOperation(f, "left", 1, operation, `${operation} result`);
    expect(memoryFiles(f.memory, { sessionId: f.session.id, branch: "left", headTurnId: f.turn.id }).read(`trace://${tagged(f.store, f.base.knowledgeId, f.base.commit)}`).content).toContain("base");
    const probe = curateNow(f.memory, f.path("left"), block(`archive ${history(f.store, f.base.knowledgeId, f.base.commit)}`, { kind: "invalid", reason: "Probe the stale base." }, "The user withdrew this the same day; nothing replaces it."));
    expect(probe.blocks[0]).toMatchObject({ status: "refused", stale: true });
    expect(probe.blocks[0]!.reason).toContain("base is not the latest effective applicable revision");
    if (operation === "archive") {
      // A curate archive carries the base's own supports (the root evidence, shared by every branch), so unlike the other operations
      // it is not left-only: the right branch sees the archive too and its update from the old base is stale.
      const right = curateNow(f.memory, f.path("right"), block(`update ${history(f.store, f.base.knowledgeId, f.base.commit)}`, { supports: `F${f.branchFacts.right}`, reason: "right" }, "divergent result")).blocks[0]!;
      expect(right).toMatchObject({ status: "refused", stale: true });
      return;
    }
    runOperation(f, "right", 2, "update", `${operation} divergent result`);
    expect(f.store.currentCommit(f.base.knowledgeId, f.path("right"))[0]!.text).toBe(`${operation} divergent result`);
  },
);

test("64b: publishing the owner foreground restores an off-path base for every reader", () => {
  const f = pathFixture();
  runOperation(f, "left", 1, "update", "left-only successor");
  expect(f.store.currentCommit(f.base.knowledgeId, f.path("left"))[0]!.text).toBe("left-only successor");

  f.store.setCurrentPath(f.session.id, "root", f.turn.id, "test-lineage");
  expect(f.store.currentCommit(f.base.knowledgeId, f.path("left")).map(revision => revision.id)).toEqual([f.base.commit]);
  expect(f.store.currentCommit(f.base.knowledgeId, f.path("right")).map(revision => revision.id)).toEqual([f.base.commit]);
  runOperation(f, "root", 2, "update", "restored base correction");
  expect(f.store.currentCommit(f.base.knowledgeId, f.path("right"))[0]!.text).toBe("restored base correction");
});

test("64b: a stale second submission is refused naming the current history address, never a tag; the first stays", () => {
  const f = pathFixture();
  const path = f.path("left");
  f.store.setCurrentPath(f.session.id, "left", f.turn.id, "test-lineage");
  const base = history(f.store, f.base.knowledgeId, f.base.commit);
  curateNow(f.memory, path, block(`update ${base}`, { reason: "First maintenance." }, "first successor"));
  const stale = curateNow(f.memory, path, block(`update ${base}`, { reason: "Must fail." }, "unresolved stale submission")).blocks[0]!;
  const current = f.store.currentCommit(f.base.knowledgeId, path)[0]!.id;
  expect(stale).toMatchObject({ status: "refused", stale: true });
  expect(stale.reason).toContain(`base is not the latest effective applicable revision; current: ${history(f.store, f.base.knowledgeId, current)}`);
  expect(stale.reason).not.toContain(tagged(f.store, f.base.knowledgeId, current));
  expect(f.store.currentCommit(f.base.knowledgeId, path)[0]!.text).toBe("first successor");
  // Re-reading and correcting from the current version is a new operation that applies.
  curateNow(f.memory, path, block(`update ${history(f.store, f.base.knowledgeId, current)}`, { reason: "Reread and correct." }, "corrected successor"));
  expect(f.store.currentCommit(f.base.knowledgeId, path)[0]!.text).toBe("corrected successor");
});

// 64c removes settlement/certification and replaces it with one-time pool-event consumption.
test.skip("34b: a consumed supplied event succeeds with exact settlement and no adopted certificate", () => {});
// 64c removes retained peer components and oversized-group settlement.
test.skip("34b: shared-result peer propagation blocks the whole oversized group while an independent event completes", () => {});
// 64c removes exact-version pending obligations and the processed partition.
test.skip("34b/35b: a restored exact version is reported honestly as pending work by the bound check", () => {});
// 64c deletes certification-time successor classification.
test.skip.each([
  "divergent inapplicable",
  "divergent applicable",
  "descendant inapplicable",
])("47 certification: '%s' successor follows lineage-or-applicable", () => {});
// 64c deletes certification and its provenance failure mode.
test.skip("47 certification: unknown required same-session successor provenance fails explicitly", () => {});
