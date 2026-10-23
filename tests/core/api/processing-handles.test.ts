import { afterEach, expect, test } from "vitest";
import { TraceMemory, memoryFiles } from "../../../src/core/api/index.ts";
import { seedSourceEntry } from "../../source-fixture.ts";
import { applyWorkspace, checkWorkspace } from "../../../src/core/workspace/index.ts";
import { block } from "../../support/workspace.ts";
import { pairOfText } from "../../support/dreamer.ts";

const all: ReturnType<typeof TraceMemory>[] = [];
afterEach(() => { for (const m of all.splice(0)) m.close(); });
function setup(second = false, initialText = "body A") {
  const m = TraceMemory(":memory:", async () => ({ outcome: "success", output: "unused", request: {} })); all.push(m);
  const p = m.store.createProject({ name: "A", declaredBy: "mark" });
  const s = m.store.createSession({ host: "pi:handles", projectId: p.id, enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
  const t = m.store.appendTurn({ sessionId: s.id, kind: "turn", userPrompt: "facts", startedAt: "now" });
  seedSourceEntry(m, t.id, "user", "facts");
  const rootEntry = m.store.listSourceEntries(s.id, t.id).at(-1)!;
  m.selectEntries(s.id, "main", [rootEntry.id]);
  const context = { kind: "manual" as const, sessionId: s.id, currentTurnId: t.id, branch: "main", triggerEntryId: rootEntry.id };
  const tools = m.tools(context);
  expect(tools.find(tool => tool.name === "note")!.execute({ title: "Handle evidence", sources: `[T${t.id}#E1] facts` })).not.toContain("rejected:");
  const content = { text: initialText, category: "constraint", scope: "project", topics: [], supports: ["F1"], reason: "test" };
  const write = (operations: unknown[], binding = tools) => {
    if (operations.length !== 1) throw new Error("manual memory writes one operation per call (ticket 116)");
    return binding.find(tool => tool.name === "memory")!.execute(operations[0]);
  };
  // The initial item may be oversized, as an item written before the caps (ticket 144) can be; the caps are lifted for the seed only.
  const limits = { ...m.config.writing };
  m.config.writing.bodyWords = 1_000_000;
  expect(write([{ files: null, op: "create", title: "Fixture title", ...content }])).not.toContain("rejected:");
  if (second) expect(write([{ files: null, op: "create", title: "Fixture title", ...content, text: "second" }])).not.toContain("rejected:");
  Object.assign(m.config.writing, limits);
  const tag = (id: number, ordinal = 1) => `K${id}#${m.store.versionTag(id, m.store.resolveVersionOrdinal(id, ordinal))}`;
  return { m, context, path: { sessionId: s.id, branch: "main", headTurnId: t.id, triggerEntryId: rootEntry.id }, content, tools, write, t, rootEntry, tag };
}

test("92: previews carry no tag; a valid tag works across bindings without a read ledger", () => {
  const a = setup(true);
  const preview = a.tools.find(tool => tool.name === "search")!.execute({ query: "body", layer: "knowledge" });
  expect(preview).toContain("K1@v1");
  expect(preview).not.toContain(a.tag(1));
  const archive = (id: string) => a.write([{ files: null, op: "archive", kind: "invalid", text: "Withdrawn: the user retired this and nothing replaces it, per the cited fact.", id, supports: ["F1"], reason: "Retire tagged item" }], a.m.tools(a.context));
  expect(archive("K1")).toContain("supply an exact K#tag");
  expect(archive("K1#unknown")).toContain("knowledge version does not exist");
  expect(a.m.store.currentCommit(1)[0]!.op).toBe("create");
  // No trace call: possessing the correct version metadata is enough, subject to authority.
  expect(archive(a.tag(1))).toContain("committed");
  expect(archive(a.tag(2))).toContain("committed");
});

test("manual writers freeze fact sources and knowledge supports at the exact trigger prefix", () => {
  const a = setup();
  seedSourceEntry(a.m, a.t.id, "assistant", "carrier");
  const carrier = a.m.store.listSourceEntries(1, a.t.id).at(-1)!;
  seedSourceEntry(a.m, a.t.id, "assistant", "later evidence");
  const later = a.m.store.listSourceEntries(1, a.t.id).at(-1)!;
  a.m.selectEntries(1, "main", [a.rootEntry.id, carrier.id, later.id]);
  const lateTools = a.m.tools({ ...a.context, triggerEntryId: later.id, entryIds: [a.rootEntry.id, carrier.id, later.id] });
  expect(lateTools.find(tool => tool.name === "note")!.execute({ title: "Later evidence", sources: `[T${a.t.id}#E${later.entryOrdinal}] later` })).not.toContain("rejected:");
  const earlyTools = a.m.tools({ ...a.context, triggerEntryId: carrier.id, entryIds: [a.rootEntry.id, carrier.id] });
  expect(earlyTools.find(tool => tool.name === "note")!.execute({ title: "Too late", sources: `[T${a.t.id}#E${later.entryOrdinal}] too late` })).toContain("invalid source");
  expect(earlyTools.find(tool => tool.name === "memory")!.execute({ files: null, op: "create", title: "Fixture title", ...a.content, supports: ["F2"] })).toContain("after the exact triggering source prefix");
});

test("92 supersedes named-read grants: copied Raw tags do not prove reading, but still identify the exact version", () => {
  const a = setup();
  const tagged = memoryFiles(a.m, a.path).read("trace://K1@v1").content;
  expect(tagged).toContain(a.tag(1));
  a.m.store.updateTurn(a.t.id, { assistantText: tagged });
  seedSourceEntry(a.m, a.t.id, "assistant", tagged);
  a.m.selectEntries(1, "main", a.m.store.listSourceEntries(1, a.t.id).map(entry => entry.id));
  const fresh = a.m.tools(a.context);
  expect(memoryFiles(a.m, a.path).read(`trace://raw/S${a.path.sessionId}/T${a.t.id}`).content).toContain(a.tag(1));
  const archive = (id: string) => a.write([{ files: null, op: "archive", kind: "invalid", text: "Withdrawn: the user retired this and nothing replaces it, per the cited fact.", id, supports: ["F1"], reason: "Retire exact tagged version" }], fresh);
  expect(archive("K1#unknown")).toContain("knowledge version does not exist");
  expect(a.m.store.currentCommit(1)[0]!.op).toBe("create");
  expect(archive(a.tag(1))).toContain("committed");
});

// The Dreamer names a base by its exact version address `K<id>@v<n>` in a curate file (ticket 144 Stage 4); each operation commits
// or is refused on its own, a base that is no longer current is refused as stale and left for the next run.
const curate = (a: ReturnType<typeof setup>, text: string) => applyWorkspace(a.m.store, { kind: "curate", pair: pairOfText(text), sessionId: a.path.sessionId, path: a.path, file: { name: "curate.md", text } });
const applied = (a: ReturnType<typeof setup>, text: string) => { const result = curate(a, text); if (!result.ok) throw new Error(result.problems.join("\n")); return result.blocks; };

test("99: Dreamer invalidation commits immediately and an ordinary update revives the identity", () => {
  const a = setup();
  const [archived] = applied(a, block("archive K1@v1", { kind: "invalid", reason: "Withdraw prior understanding" },
    "The old claim no longer holds because the user withdrew the evidence; nothing replaces it."));
  expect(archived).toMatchObject({ status: "applied", versions: ["K1@v2"] });
  expect(a.m.store.currentCommit(1, a.path)[0]).toMatchObject({ files: null, op: "archive", archiveKind: "invalid", supports: [1] });
  expect(a.m.store.currentKnowledge(a.path).some(item => item.knowledge.id === 1)).toBe(false);
  expect(applied(a, block("update K1@v2", { reason: "Revive" }, "A new user decision revives this identity"))[0]).toMatchObject({ status: "applied", versions: ["K1@v3"] });
  expect(a.m.store.currentCommit(1, a.path)[0]!.op).toBe("update");
  expect(a.m.store.currentKnowledge(a.path).some(item => item.knowledge.id === 1)).toBe(true);
});

test("92 supersedes 32: mutations require an exact version address, not a bare identity, a numeric commit or a manual tag", () => {
  const a = setup();
  const check = (text: string) => checkWorkspace(a.m.store, { kind: "curate", pair: pairOfText(text), sessionId: a.path.sessionId, file: { name: "curate.md", text } }).problems.join("\n");
  for (const id of ["K1", "K1@1", `K1#${a.m.store.versionTag(1, 1)}`]) {
    expect(check(block(`update ${id}`, { reason: "r" }, "body A, again"))).toContain("is not a version address");
    expect(check(block(`archive ${id}`, { kind: "invalid", reason: "r" }, "The user withdrew it the same day."))).toContain("is not a version address");
  }
  expect(check(block("update K1@v1", { reason: "r" }, "body A, again"))).toBe("");
  expect(a.m.store.currentCommit(1)[0]!.op).toBe("create");
});

test("92: ABA keeps different versions and archive invalidates old bases without substitution", () => {
  const a = setup();
  const stale = (text: string) => applied(a, text)[0]!;
  expect(applied(a, block("update K1@v1", { reason: "B" }, "body B"))[0]).toMatchObject({ status: "applied", versions: ["K1@v2"] });
  expect(applied(a, block("update K1@v2", { reason: "A again" }, "body A"))[0]).toMatchObject({ status: "applied", versions: ["K1@v3"] });
  expect(a.m.store.currentCommit(1)[0]!.text).toBe("body A"); // same content as v1, a different version
  const old = stale(block("update K1@v1", { reason: "from the original" }, "body C"));
  expect(old).toMatchObject({ status: "refused", stale: true });
  expect(old.reason).toContain("current: K1@v3");
  expect(applied(a, block("archive K1@v3", { kind: "invalid", reason: "retired" }, "The user withdrew it; nothing replaces it."))[0]).toMatchObject({ status: "applied", versions: ["K1@v4"] });
  const afterArchive = stale(block("update K1@v3", { reason: "from before the archive" }, "body D"));
  expect(afterArchive).toMatchObject({ status: "refused", stale: true });
  expect(afterArchive.reason).toContain("current: K1@v4");
  expect(a.m.store.currentCommit(1)[0]).toMatchObject({ op: "archive" });
});

test("92: every merge participant is an exact current version; one bad base refuses the whole merge", () => {
  const a = setup(true);
  expect(applied(a, block("update K2@v1", { reason: "later merge parent" }, "later merge parent"))[0]).toMatchObject({ status: "applied", versions: ["K2@v2"] });
  const merge = (absorbed: string) => applied(a, block("merge K1@v1", { absorb: absorbed, reason: "same rule" }, "merged rule"))[0]!;
  const refused = merge("K2@v1");
  expect(refused).toMatchObject({ status: "refused", stale: true });
  expect(refused.reason).toContain("current: K2@v2");
  expect(a.m.store.currentCommit(1)[0]!.op).toBe("create");
  expect(a.m.store.currentCommit(2)[0]!.op).toBe("update");
  expect(merge("K2@v2")).toMatchObject({ status: "applied", versions: ["K1@v2"] });
  expect(a.m.store.currentCommit(2)).toEqual([]);
});
