// Ticket 136: what `search` accepts and returns. Four parameters and a script over the hits; one line per
// hit by default; every knowledge version a candidate; each hit a structured item whose fields the tool
// description declares.
import { afterEach, beforeEach, expect, test } from "vitest";
import { sourceSeededMemory, memoryFiles } from "../../source-fixture.ts";
import { archive, facts, knowledge } from "../../support/seed.ts";
import { SEARCH_HIT_TYPES, toolDefinitions } from "../../../src/core/api/index.ts";

let memory: ReturnType<typeof sourceSeededMemory>;
beforeEach(() => { memory = sourceSeededMemory(":memory:", async () => { throw new Error("no model calls"); }); });
afterEach(() => memory.close());

/** The T8727 shape: the match sits deep inside E1, and the only fact citing E1 never mentions it. */
const NUMBER = "6.62265625";
const deepPrompt = Array.from({ length: 40 }, (_, i) => i === 33
  ? `  - 11px digits, M and $ are all ${NUMBER}px wide, so no per-character width is needed.` : `line ${i + 1} of the note`).join("\n");

function corpus() {
  const store = memory.store;
  const project = store.createProject({ name: "search", declaredBy: "mark" });
  const session = store.createSession({ enrollmentChoice: true, host: "fake", projectId: project.id, startedAt: "2026-10-01T00:00:00Z", firstReplyAt: "2026-10-01T00:00:01Z" });
  const turns: ReturnType<typeof store.appendTurn>[] = [];
  for (const [i, prompt] of [deepPrompt, "second prompt about widgets", "third prompt about widgets"].entries())
    turns.push(store.appendTurn({ sessionId: session.id, parentTurnId: turns.at(-1)?.id ?? null, kind: "turn", userPrompt: prompt,
      assistantText: `reply ${i + 1} widgets`, startedAt: `2026-10-01T00:0${i + 1}:00Z` }));
  const all = store.hydrateSourceEntries(store.listSourceEntries(session.id).map(entry => entry.id));
  const path = { sessionId: session.id, branch: "main", headTurnId: turns.at(-1)!.id, triggerEntryId: all.at(-1)!.id };
  const first = all.find(entry => entry.turnId === turns[0]!.id && entry.role === "user")!;
  const second = all.find(entry => entry.turnId === turns[1]!.id && entry.role === "user")!;
  const [deepFact, widgetFact] = facts(memory, path, [
    { title: "Font width settled", sources: [{ entry: first, text: "The mono font has one fixed advance width." }] },
    { title: "Widgets discussed", sources: [{ entry: second, text: "The widget rule came up." }] },
  ]);
  return { project, session, turns, path, first, deepFact: deepFact!, widgetFact: widgetFact! };
}
const lines = (text: unknown) => String(text).split("\n");

test("defaults: layer all, topk 10 with a query, knowledge then facts then Raw, one line each", () => {
  const f = corpus();
  const rule = knowledge(memory.store, f.path, "project", "constraint", [f.widgetFact.id], "The widget rule is final");
  const out = lines(memory.search("widget"));
  expect(out[0]).toMatch(/^\[K\d+@v1\] \[constraint\/project\] The widget rule is final$/);
  expect(out.findIndex(l => l.startsWith("[F"))).toBeGreaterThan(0);
  expect(out.findIndex(l => l.startsWith("[S"))).toBeGreaterThan(out.findIndex(l => l.startsWith("[F")));
  expect(rule.knowledgeId).toBe(1);
  // topk counts hits across the layers together.
  const two = lines(memory.search("widget", "all", { topk: 2 }));
  expect(two.filter(l => l.startsWith("["))).toHaveLength(2);
  expect(two.at(-1)).toContain("topk 2 reached");
  // Ten is the default cap; a miss says so without claiming absence.
  for (let i = 0; i < 12; i++) memory.store.appendTurn({ sessionId: f.session.id, kind: "turn", userPrompt: `gizmo ${i}`, startedAt: "2026-10-02T00:00:00Z" });
  expect(lines(memory.search("gizmo", "raw")).filter(l => l.startsWith("[S"))).toHaveLength(10);
  expect(memory.search("no such word")).toBe("No hit. Search matches a literal substring. No hit does not mean absent.");
});

test("with no query: every entry, or the newest topk across the layers", () => {
  const f = corpus();
  const rule = knowledge(memory.store, f.path, "project", "constraint", [f.widgetFact.id], "A rule", { run: { kind: "noting", createdAt: "2026-10-03T00:00:00Z" } });
  const ancient = knowledge(memory.store, f.path, "project", "constraint", [f.widgetFact.id], "An old rule", { run: { kind: "noting", createdAt: "2026-09-01T00:00:00Z" } });
  const everything = lines(memory.search(undefined, "all"));
  expect(everything.at(-1)).toContain(`[K${ancient.knowledgeId}@v1]`); // oldest of all, so last, though knowledge usually lists first
  const rawEntries = memory.store.listSourceEntries(f.session.id).length;
  expect(everything.filter(l => l.startsWith("[S"))).toHaveLength(rawEntries);
  expect(everything.filter(l => l.startsWith("[F"))).toHaveLength(2);
  expect(everything.filter(l => l.startsWith("[K"))).toHaveLength(2);
  expect(everything.some(l => l.includes("topk"))).toBe(false);
  // The newest first, whichever layer: the knowledge written last, then the Raw of the last Turn.
  const newest = lines(memory.search(undefined, "all", { topk: 3 }));
  expect(newest[0]).toContain(`[K${rule.knowledgeId}@v1]`);
  expect(newest.slice(1, 3).every(l => l.startsWith("[F") || l.startsWith("[S"))).toBe(true);
  expect(lines(memory.search(undefined, "raw", { topk: 2 })).filter(l => l.startsWith("[S"))
    .every(l => l.startsWith(`[S${f.session.id}/T${f.turns[2]!.id}#`))).toBe(true);
});

test("every knowledge version is a candidate, labelled with its status; the current one is unmarked", () => {
  const f = corpus();
  const old = knowledge(memory.store, f.path, "project", "constraint", [f.widgetFact.id], "gadget rule one");
  const kept = knowledge(memory.store, f.path, "project", "constraint", [f.widgetFact.id], "gadget rule two");
  archive(memory.store, f.path, old.knowledgeId, old.commit, [f.widgetFact.id], "invalid", "The gadget rule no longer holds: the user withdrew it for good reasons.");
  const found = lines(memory.search("gadget", "knowledge", f.path));
  expect(found.find(l => l.includes("rule two"))).toMatch(/^\[K2@v1\] \[constraint\/project\] gadget rule two$/);
  expect(found.find(l => l.includes("rule one"))).toMatch(/^\[K1@v1\] \(superseded\) \[constraint\/project\]/);
  expect(found.find(l => l.includes("no longer holds"))).toMatch(/^\[K1@v2\] \(archived\) \[constraint\/project\]/);
  expect(kept.knowledgeId).toBe(2);
  // Closest lexical match first, then current, then newer.
  expect(lines(memory.search("gadget rule two", "knowledge", f.path))[0]).toContain("[K2@v1]");
});

test("the default print is one line per hit, centred on the first match, with the T8727 Raw shape", () => {
  const f = corpus();
  const raw = lines(memory.search(NUMBER, "all", f.path));
  expect(raw).toHaveLength(1); // the citing fact never mentions the number, so only the entry matches
  expect(raw[0]).toMatch(new RegExp(`^\\[S${f.session.id}/T${f.turns[0]!.id}#E1@user\\] …`));
  expect(raw[0]).toContain(NUMBER);
  expect(raw[0]).not.toContain("\n");
  expect(raw[0]!.length).toBeLessThan(260);
  // Several matches in one entry still give one line; a long first line is cut around the match.
  expect(lines(memory.search("line", "raw", f.path)).filter(l => l.includes(`T${f.turns[0]!.id}#E1`))).toHaveLength(1);
  expect(memory.search("widgets", "raw", f.path)).toMatch(/\[S\d+\/T\d+#E\d@assistant\] .*reply 3 widgets/);
  // Without a query a Raw hit shows the start of its body; a fact shows its title alone.
  expect(lines(memory.search(undefined, "raw", { ...f.path, topk: 1 }))[0]).toMatch(/^\[S\d+\/T\d+#E\d@(user|assistant)\] .*(reply 3 widgets|third prompt)/);
  expect(lines(memory.search(undefined, "facts", f.path))).toEqual([`[F${f.widgetFact.id}] Widgets discussed`, `[F${f.deepFact.id}] Font width settled`]);
  // One snapshot per layer (ids and times are fixed by the fixture).
  expect(memory.search("advance width", "facts", f.path)).toMatchInlineSnapshot(`"[F1] Font width settled — …The mono font has one fixed advance width.…"`);
});

test("a Raw hit carries its line numbers as a Read of its address numbers them, and the facts that cite it", () => {
  const f = corpus();
  const tool = memory.tools({ kind: "manual", sessionId: f.session.id, branch: "main", currentTurnId: f.turns.at(-1)!.id }).find(t => t.name === "search")!;
  return Promise.resolve(tool.execute({ query: NUMBER, layer: "raw", code: "const h = hits[0]; return JSON.stringify({ address: h.address, matchLines: h.matchLines, citedBy: h.citedBy, role: h.role, entry: h.entry, turn: h.turn })" })).then(result => {
    const hit = JSON.parse(/\{.*\}/.exec(result)![0].replaceAll("\\\"", "\""));
    expect(hit).toMatchObject({ address: `trace://raw/S${f.session.id}/T${f.turns[0]!.id}#E1`, role: "user", entry: 1, turn: f.turns[0]!.id, citedBy: [f.deepFact.id] });
    const read = memoryFiles(memory, f.path).read(hit.address).content.split("\n");
    expect(hit.matchLines).toHaveLength(1);
    expect(read[hit.matchLines[0] - 1]).toContain(NUMBER);
    // The fact that cites this entry does not hold the number: only the Raw entry can answer.
    expect(memory.store.getFact(f.deepFact.id)!.text).not.toContain(NUMBER);
    expect(memory.search(NUMBER, "facts", f.path)).toContain("No hit");
  });
});

test("unknown or removed parameters and bad values are refused", () => {
  const f = corpus();
  const search = memory.tools({ kind: "manual", sessionId: f.session.id, branch: "main", currentTurnId: f.turns.at(-1)!.id }).find(t => t.name === "search")!;
  for (const bad of [{ topk: 0 }, { topk: 1.5 }, { layer: "everything" }, { scope: "branch" }, { code: 3 }, { query: 3 }, { cap: 5 }, { maxTokens: 100 }, { versions: "all" }])
    expect(search.execute(bad)).toMatch(/^rejected: /);
  expect(Object.keys(toolDefinitions.find(t => t.name === "search")!.parameters.properties as object)).toEqual(["query", "scope", "layer", "topk", "code"]);
});

/** The fields a TypeScript declaration gives each interface, with the shared `Base` fields merged in. */
function declaredFields(declaration: string): Record<string, string[]> {
  const interfaces = Object.fromEntries([...declaration.matchAll(/interface (\w+)(?: extends (\w+))? \{(.*)\}$/gm)].map(([, name, base, body]) => {
    const fields = [...body!.replace(/\{[^{}]*\}/g, "{}").matchAll(/(?:^\s*|[;{]\s*)(\w+)\??:/g)].map(m => m[1]!);
    return [name!, { base, fields }];
  }));
  const own = (name: string): string[] => [...(interfaces[name]!.base ? own(interfaces[name]!.base) : []), ...interfaces[name]!.fields];
  return Object.fromEntries(["Knowledge", "Fact", "Raw"].map(name => [name, own(name)]));
}

test("the declared hit types match the fields real hits carry, layer by layer", async () => {
  const f = corpus();
  const old = knowledge(memory.store, f.path, "project", "constraint", [f.widgetFact.id], "declared widget");
  archive(memory.store, f.path, old.knowledgeId, old.commit, [f.widgetFact.id], "budget");
  const declared = declaredFields(SEARCH_HIT_TYPES);
  expect(Object.keys(declared)).toEqual(["Knowledge", "Fact", "Raw"]);
  const description = toolDefinitions.find(t => t.name === "search")!.description;
  expect(description).toContain(SEARCH_HIT_TYPES);
  const tool = memory.tools({ kind: "manual", sessionId: f.session.id, branch: "main", currentTurnId: f.turns.at(-1)!.id }).find(t => t.name === "search")!;
  const seen = await tool.execute({ query: "widget", topk: 50,
    code: "return JSON.stringify(['knowledge', 'facts', 'raw'].map(layer => { const h = hits.find(x => x.layer === layer); return h && { layer, keys: Object.keys(h), archived: layer === 'knowledge' ? hits.some(x => x.status === 'archived' && x.archiveKind === 'budget') : null }; }))" });
  const items = JSON.parse(/\[.*\]/.exec(seen as string)![0].replaceAll("\\\"", "\""));
  expect(items.every(Boolean)).toBe(true);
  for (const item of items) {
    const name = { knowledge: "Knowledge", facts: "Fact", raw: "Raw" }[item.layer as string]!;
    expect([...item.keys].sort(), `${name} item fields`).toEqual([...declared[name]!].sort());
  }
  expect(items[0].archived).toBe(true);
});
