// The `/tm` read-only files (101): what a path shows, how reads page, what Grep and Glob cover, the
// inheritance view, and that no read writes. Views themselves are trace's (93), pinned elsewhere.
import { afterEach, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryFiles, memoryGlob, memoryPath, recorded, sourceSeededMemory, tokens, type MemoryReader } from "../../source-fixture.ts";
import { archive, entry, fact, knowledge, legacyArchive, session } from "../../support/seed.ts";

const at = "2026-09-21T00:00:00.000Z";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** Two projects. The reader's T1 is noted into F1; its tool result holds a needle past the compressed
 * view. Knowledge: K1 current, K2 invalidated, K3 budget-archived, K4 archived before 99, K5 in the other
 * project. T2 stays pending. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tm-memory-files-")); dirs.push(dir);
  const memory = sourceSeededMemory(join(dir, "memory.sqlite"), async () => { throw new Error("no model work"); });
  const store = memory.store;
  const alpha = store.createProject({ name: "alpha", declaredBy: "mark" }), beta = store.createProject({ name: "beta", declaredBy: "mark" });
  const reader = session(store, alpha.id, "pi:reader"), other = session(store, beta.id, "pi:other");
  const t1 = store.appendTurn({ sessionId: reader.id, kind: "turn", startedAt: at });
  const ask = entry(store, reader.id, t1.id, "r1", "user", "Which cache policy does hashline use?");
  const result = store.appendSourceEntry({ sessionId: reader.id, turnId: t1.id, nativeLineage: `lineage-${reader.id}`, nativeId: "r2",
    role: "toolResult", text: "", raw: "{}", calls: [{ ordinal: 1, name: "read", callId: "c1", status: "success",
      result: `${"filler ".repeat(3_000)}NEEDLE-deep-in-raw${" tail".repeat(50)}` }] });
  const answer = entry(store, reader.id, t1.id, "r3", "assistant", "Hashline uses LRU with 1000 entries.");
  const t2 = store.appendTurn({ sessionId: reader.id, kind: "turn", startedAt: at, parentTurnId: t1.id });
  const pending = entry(store, reader.id, t2.id, "r4", "user", "A pending question about zebras.");
  memory.selectEntries(reader.id, "main", [ask.id, result.id, answer.id, pending.id]);
  store.setCurrentPath(reader.id, "main", t2.id, "fixture");
  const path = { sessionId: reader.id, branch: "main", headTurnId: t1.id };
  const f1 = fact(memory, path, "Hashline cache policy", [{ entry: ask, text: "The user asks which cache policy hashline uses." },
    { entry: answer, text: "The agent answers LRU with 1000 entries." }]);
  recorded(memory, reader.id, "main", t1.id);
  const k1 = knowledge(store, path, "project", "constraint", [f1.id], "Hashline uses LRU with 1000 entries.");
  const k2 = knowledge(store, path, "project", "understanding", [f1.id], "Zebra guidance, since withdrawn.");
  const k3 = knowledge(store, path, "project", "understanding", [f1.id], "Giraffe note kept whole.");
  const k4 = knowledge(store, path, "project", "understanding", [f1.id], "Okapi rule from before 99.");
  archive(store, path, k2.knowledgeId, k2.commit, [f1.id], "invalid", "The zebra rule no longer holds: the user withdrew it; nothing replaces it.");
  archive(store, path, k3.knowledgeId, k3.commit, [f1.id], "budget");
  legacyArchive(store, path, k4.knowledgeId, k4.commit, [f1.id]);
  const t3 = store.appendTurn({ sessionId: other.id, kind: "turn", startedAt: at });
  const bloom = entry(store, other.id, t3.id, "o1", "user", "Beta adds a bloom filter to hashline.");
  memory.selectEntries(other.id, "main", [bloom.id]);
  const otherPath = { sessionId: other.id, branch: "main", headTurnId: t3.id };
  const f2 = fact(memory, otherPath, "Beta bloom filter", [{ entry: bloom, text: "The user adds a bloom filter." }]);
  const k5 = knowledge(store, otherPath, "project", "understanding", [f2.id], "Beta's hashline adds a bloom filter.");
  const view: MemoryReader = { sessionId: reader.id, branch: "main", headTurnId: t2.id, projectId: alpha.id };
  const files = memoryFiles(memory, view);
  const trace = (address: string, extra = {}) => memory.trace(address, { modelFacing: true, pageBudget: null, sessionId: reader.id,
    headTurnId: t2.id, branch: "main", ...extra });
  const text = (path: string) => files.read(path).lines.join("\n");
  return { memory, store, files, trace, text, reader, other, t1, t2, t3, f1, f2, k: [k1, k2, k3, k4, k5].map(k => k.knowledgeId) };
}

test("/tm generated hints use the bound host tools without changing evidence", () => {
  const f = fixture();
  const names = { trace: "mcp__plugin_trace-memory_traceMemory__trace", search: "mcp__plugin_trace-memory_traceMemory__search",
    note: "mcp__plugin_trace-memory_traceMemory__note", memory: "mcp__plugin_trace-memory_traceMemory__memory", check: "mcp__plugin_trace-memory_traceMemory__check" };
  const files = memoryFiles(f.memory, { sessionId: f.reader.id, branch: "main", headTurnId: f.t2.id, toolNames: names });
  const root = files.read("/tm").lines.join("\n");
  expect(root).toContain(`with the ${names.note} and ${names.memory} tools`);
  expect(root).toContain(`${names.trace}(<address>)`);
  expect(files.read("/tm/alpha").lines.join("\n")).toContain(names.trace);
  expect(files.read(`/tm/F${f.f1.id}`).lines.join("\n")).toBe(f.trace(`F${f.f1.id}`));
});

test("a /tm path shows what trace shows the reader at that address", () => {
  const f = fixture(), S = `/tm/S${f.reader.id}`;
  expect(f.text(`${S}/T${f.t1.id}`)).toBe(f.trace(`S${f.reader.id}/T${f.t1.id}`));
  expect(f.text(`${S}/T${f.t1.id}/E2`)).toBe(f.trace(`S${f.reader.id}/T${f.t1.id}#E2`));
  const tag = /\[(K\d+#[a-z]+)\]/.exec(f.trace(`K${f.k[0]}`))![1]!;
  for (const address of [`K${f.k[0]}`, `K${f.k[1]}@v1`, tag, `F${f.f1.id}`, `T${f.t1.id}#E1..E2`, `F${f.f1.id},K${f.k[0]}`])
    expect(f.text(`/tm/${address}`)).toBe(f.trace(address));
  expect(f.text(`/tm/K${f.k[1]}.history`)).toBe(f.trace(`K${f.k[1]}`, { versions: "history" }));
  expect(() => f.files.read(`/tm/S${f.other.id}/T${f.t1.id}`)).toThrow(/does not exist/);
  expect(() => f.files.read("/tm/K999")).toThrow(/does not exist/);
});

test("a read pages like a file: offset and limit, the 8,000-token cap and where to continue", () => {
  const f = fixture();
  const long = f.store.appendTurn({ sessionId: f.other.id, kind: "turn", startedAt: at, parentTurnId: f.t3.id });
  const entries = Array.from({ length: 40 }, (_, i) => entry(f.store, f.other.id, long.id, `long-${i}`, "user", `entry ${i} ${"lorem ipsum ".repeat(150)}`));
  f.memory.selectEntries(f.other.id, "main", [...f.store.sourcePath(f.other.id, "main", f.t3.id).map(e => e.id), ...entries.map(e => e.id)]);
  const path = `/tm/S${f.other.id}/T${long.id}`, whole = f.trace(`S${f.other.id}/T${long.id}`).split("\n");
  expect(tokens(whole.join("\n"))).toBeGreaterThan(8_000);
  const first = f.files.read(path);
  expect(tokens(first.lines.map((line, i) => `${i + 1}\t${line}`).join("\n"))).toBeLessThanOrEqual(8_000);
  const next = first.lines.length + 1;
  expect(first.cut).toMatch(new RegExp(`^\\[cut at the 8,000-token cap .*lines ${next}-${whole.length} of ${whole.length} not shown; continue with offset=${next}\\]$`));
  const rest = f.files.read(path, next);
  expect([...first.lines, ...rest.lines]).toEqual(whole);
  expect(rest).toMatchObject({ startLine: next, totalLines: whole.length });
  expect(rest.cut).toBeUndefined();
  expect(f.files.read(path, 2, 3)).toMatchObject({ lines: whole.slice(1, 4), startLine: 2, cut: expect.stringContaining("continue with offset=5") });
});

test("listings: the root, visible knowledge, every identity, a session's Turns and a Turn's entries", () => {
  const f = fixture(), S = `/tm/S${f.reader.id}`;
  const paths = (path: string) => f.files.read(path).lines.filter(line => line.includes("  ") || /^\/tm\/\S+$/.test(line)).map(line => line.split("  ")[0]);
  // The root opens with its layout, a blank line, then its children.
  expect(f.files.read("/tm").lines[0]).toMatch(/^Trace Memory, read-only/);
  expect(paths("/tm")).toEqual(["/tm/knowledge", "/tm/knowledge-all", S, `/tm/S${f.other.id}`, `/tm/F${f.f1.id}`, `/tm/F${f.f2.id}`]);
  expect(paths("/tm/knowledge")).toEqual([`/tm/K${f.k[0]}`]);
  const all = f.files.read("/tm/knowledge-all").lines;
  expect(all.map(line => line.split("  ")[0])).toEqual([`/tm/K${f.k[0]}@v1`, `/tm/K${f.k[1]}@v2`, `/tm/K${f.k[2]}@v2`, `/tm/K${f.k[3]}@v2`, `/tm/K${f.k[4]}@v1`]);
  expect(all[1]).toContain("(archived at v2, invalid)");
  expect(all[4]).toContain("[understanding/project beta]");
  // S<n>/knowledge is readable but not listed: a recursive search would render every session's injection.
  expect(paths(S)).toEqual([`${S}/T${f.t1.id}`, `${S}/T${f.t2.id}`]);
  // A Turn reads as its file and lists as the directory of its entries.
  expect(f.files.glob(`${S}/T${f.t1.id}/*`).lines).toEqual([1, 2, 3].map(n => `${S}/T${f.t1.id}/E${n}`));
});

test("grep lists matching files by default, and shows lines, counts, case-insensitive, literal and context matches on request", () => {
  const f = fixture(), S = `/tm/S${f.reader.id}`, T1 = `${S}/T${f.t1.id}`;
  expect(f.files.grep("hashline", S).lines).toEqual([T1, `${T1}/E1`]);
  expect(f.files.grep("hashline", S, { ignoreCase: true }).lines).toEqual([T1, `${T1}/E1`, `${T1}/E3`]);
  expect(f.files.grep("Hashline", S).lines).toEqual([T1, `${T1}/E3`]);
  expect(f.files.grep("zebra", S, { mode: "content" }).lines).toEqual([
    `${S}/T${f.t2.id}:2:[T${f.t2.id}#E1@user] user: A pending question about zebras.`,
    `${S}/T${f.t2.id}/E1:1:[T${f.t2.id}#E1@user] user: A pending question about zebras.`]);
  expect(f.files.grep("LRU", T1, { mode: "count" }).lines).toEqual([`${T1}:1`, `${T1}/E3:1`]);
  expect(f.files.grep("LRU with 1000 entries.", `/tm/K${f.k[0]}`, { literal: true }).lines).toEqual([`/tm/K${f.k[0]}`]);
  expect(f.files.grep("bloom", S).lines).toEqual([]);
  const context = f.files.grep("agent answers", T1, { mode: "content", before: 1 }).lines;
  expect(context.map(line => /^(.*?)([:-])(\d+)\2/.exec(line)!.slice(2, 4))).toEqual([["-", "3"], [":", "4"]]);
  expect(() => f.files.grep("(", S)).toThrow(/invalid pattern/);
});

test("grep pages its output under the same cap and says where to continue", () => {
  const f = fixture();
  const all = f.files.grep(".", "/tm", { mode: "count" }).lines;
  const first = f.files.grep(".", "/tm", { mode: "count", limit: 2 });
  expect(first.lines).toEqual(all.slice(0, 2));
  expect(first.cut).toBe(`[counts 3-${all.length} of ${all.length} not shown; continue with offset=2]`);
  expect(f.files.grep(".", "/tm", { mode: "count", offset: 2 }).lines).toEqual(all.slice(2));
});

test("grep over every knowledge version marks the versions that are not their identity's latest", () => {
  const f = fixture();
  // K4/f.k[3]'s v2 is a legacy archive from before 99 (empty body, no kind): the ruling that its
  // listing shows its parent's body ("Okapi rule from before 99.") applies to search too, so v2
  // matches here exactly as v1 (its parent) does.
  expect(f.files.grep("zebra|Zebra|Giraffe|Okapi|bloom", "/tm/knowledge-all").lines).toEqual([
    `/tm/K${f.k[1]}@v1 (historical; latest v2, archived)`, `/tm/K${f.k[1]}@v2 (archived)`,
    `/tm/K${f.k[2]}@v1 (historical; latest v2, archived)`, `/tm/K${f.k[2]}@v2 (archived)`,
    `/tm/K${f.k[3]}@v1 (historical; latest v2, archived)`, `/tm/K${f.k[3]}@v2 (archived)`, `/tm/K${f.k[4]}@v1`]);
  expect(f.files.grep("Zebra|bloom", "/tm/knowledge").lines).toEqual([]);
});

test("grep of a long Raw line shows the match and a continuation that actually continues, within the cap", () => {
  const f = fixture(), S = `/tm/S${f.other.id}`;
  const long = f.store.appendTurn({ sessionId: f.other.id, kind: "turn", startedAt: at, parentTurnId: f.t3.id });
  const bigLine = `${"ordinary ".repeat(9000)}MATCH_AT_END`;
  const raw = entry(f.store, f.other.id, long.id, "long-line", "user", bigLine);
  f.memory.selectEntries(f.other.id, "main", [...f.store.sourcePath(f.other.id, "main", f.t3.id).map(e => e.id), raw.id]);
  const entryPath = `${S}/T${long.id}/E${raw.entryOrdinal}`;
  // files-mode already finds it (unaffected by content-mode's own line length).
  expect(f.files.grep("MATCH_AT_END", entryPath).lines).toEqual([entryPath]);
  const first = f.files.grep("MATCH_AT_END", entryPath, { mode: "content" });
  expect(first.lines.some(line => line.includes("MATCH_AT_END"))).toBe(true);
  expect(tokens([...first.lines, first.cut].filter((line): line is string => line !== undefined).join("\n"))).toBeLessThanOrEqual(8_000);
  // A one-hit file fits whole (the window keeps it far under the cap): no continuation is printed,
  // so there is nothing stranded past an unreachable offset.
  expect(first.cut).toBeUndefined();
});

test("grep searches complete fact segments and knowledge bodies, not their bounded per-item rendering", () => {
  const f = fixture();
  const turn = f.store.appendTurn({ sessionId: f.other.id, kind: "turn", startedAt: at, parentTurnId: f.t3.id });
  const source = entry(f.store, f.other.id, turn.id, "long-source", "user", "A detailed design discussion.");
  f.memory.selectEntries(f.other.id, "main", [...f.store.sourcePath(f.other.id, "main", f.t3.id).map(e => e.id), source.id]);
  const path = { sessionId: f.other.id, branch: "main", headTurnId: turn.id };
  const longFact = fact(f.memory, path, "Long design fact",
    [{ entry: source, text: `${"before ".repeat(1500)}FACT_MIDDLE_NEEDLE ${"after ".repeat(1500)}` }]);
  const longKnowledge = knowledge(f.store, path, "project", "understanding", [longFact.id],
    `${"before ".repeat(1500)}KNOWLEDGE_MIDDLE_NEEDLE ${"after ".repeat(1500)}`, { run: { kind: "manual", createdAt: at } });
  // Both bodies exceed the ordinary per-item render cap (2,000 tokens); trace() alone would truncate
  // each around its head and never reach the middle needle.
  expect(f.files.grep("FACT_MIDDLE_NEEDLE", `/tm/F${longFact.id}`).lines).toEqual([`/tm/F${longFact.id}`]);
  expect(f.files.grep("KNOWLEDGE_MIDDLE_NEEDLE", "/tm/knowledge-all").lines).toEqual([`/tm/K${longKnowledge.knowledgeId}@v1`]);
  // A plain Read keeps trace's own (bounded) rendering: unaffected by Grep's fuller search material.
  expect(f.text(`/tm/F${longFact.id}`)).toBe(f.trace(`F${longFact.id}`));
});

test("a directory search never renders an inheritance view", () => {
  const f = fixture();
  const injection = vi.spyOn(f.memory, "injection");
  f.files.grep("anything", "/tm");
  f.files.glob("/tm/**");
  expect(injection).not.toHaveBeenCalled();
  f.files.read(`/tm/S${f.reader.id}/knowledge`);
  expect(injection).toHaveBeenCalledOnce();
});

test("glob matches listed paths segment by segment", () => {
  const f = fixture(), S = `/tm/S${f.reader.id}`;
  expect(f.files.glob(`${S}/T*/E{1,3}`).lines).toEqual([`${S}/T${f.t1.id}/E1`, `${S}/T${f.t1.id}/E3`, `${S}/T${f.t2.id}/E1`]);
  expect(f.files.glob("/tm/knowledge-all/K*").lines).toHaveLength(5);
  expect(f.files.glob("/tm/**/E2").lines).toEqual([`${S}/T${f.t1.id}/E2`]);
  expect(f.files.glob("/tm/nothing*").lines).toEqual([]);
});

test("the inheritance view is the injection selection at the session's current head, with nothing delivered", () => {
  const f = fixture(), current = f.store.currentPath(f.reader.id);
  expect(current).toEqual({ sessionId: f.reader.id, branch: "main", headTurnId: f.t2.id });
  const selection = f.memory.injection(current);
  expect(selection.knowledgeCommitIds).toHaveLength(1);
  // A foreground delivery on the path changes what the reader is sent next, never the inherited view.
  f.store.recordKnowledgeDelivery({ owner: "pi:reader", turnId: f.t2.id }, [{ knowledgeCommitIds: selection.knowledgeCommitIds,
    knowledgeStates: [], knowledgeTokens: selection.knowledgeTokens! }]);
  expect(f.text(`/tm/S${f.reader.id}/knowledge`)).toBe(selection.text);
  expect(f.text(`/tm/S${f.other.id}/knowledge`)).toBe(f.memory.injection(f.store.currentPath(f.other.id)).text);
  expect(f.text(`/tm/S${f.other.id}/knowledge`)).toContain("Beta's hashline adds a bloom filter.");
});

test("reading, listing and searching leave the database unchanged", () => {
  const f = fixture();
  const digest = () => {
    const hash = createHash("sha256");
    for (const { name } of f.store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[])
      hash.update(name + JSON.stringify(f.store.db.prepare(`SELECT * FROM "${name}"`).all()));
    return hash.digest("hex");
  };
  const before = digest();
  for (const path of ["/tm", "/tm/knowledge", "/tm/knowledge-all", `/tm/S${f.reader.id}`, `/tm/S${f.reader.id}/knowledge`,
    `/tm/S${f.reader.id}/T${f.t1.id}`, `/tm/K${f.k[0]}.history`, `/tm/F${f.f1.id}`]) f.files.read(path);
  f.files.grep("hashline", "/tm", { mode: "content", ignoreCase: true });
  f.files.glob("/tm/**");
  expect(digest()).toBe(before);
});

test("only /tm and paths under it, normalised, are memory paths", () => {
  for (const [path, expected] of [["/tm", "/tm"], ["/tm/", "/tm"], ["/tm/K1", "/tm/K1"], ["//tm//K1", "/tm/K1"], ["/tm/./S1/../K1", "/tm/K1"],
    ["/tm/K12#qfzt", "/tm/K12#qfzt"]] as const) expect(memoryPath(path)).toBe(expected);
  for (const path of ["/tmp/K1", "/tm-foo/K1", "/tmx", "/TM/K1", "/tm/../etc/passwd", "/tm/S1/../../etc", "tm/K1", "./tm/K1", "~/tm/K1",
    "", "/", "/private/tm/K1", "/Users/me/tm/K1", undefined, null, 42]) expect(memoryPath(path)).toBeNull();
  expect(memoryGlob("/tm/S*")).toBe("/tm/S*");
  expect(memoryGlob("S1/T*", "/tm")).toBe("/tm/S1/T*");
  expect(memoryGlob("**/E2", "/tm/")).toBe("/tm/**/E2");
  for (const [pattern, path] of [["/t*/K1", undefined], ["/tm*", undefined], ["/tmp/*", undefined], ["tm/*", undefined], ["*", "tm"],
    ["../etc/*", "/tm"], ["*", "/tmp"], ["/tm/../etc/*", undefined]] as const) expect(memoryGlob(pattern, path)).toBeNull();
});
