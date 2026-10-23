// Ticket 136: what `search` accepts and returns. Four parameters and a script over the hits; one line per
// hit by default; every knowledge version a candidate; each hit a structured item whose fields the tool
// description declares.
import { afterEach, beforeEach, expect, test } from "vitest";
import { sourceSeededMemory, memoryFiles, seedSourceEntry } from "../../source-fixture.ts";
import { archive, facts, knowledge } from "../../support/seed.ts";
import { SEARCH_HIT_TYPES, toolDefinitions } from "../../../src/core/api/index.ts";
import { countHydratedRows } from "../../perf/fixture.ts";

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
  const rule = knowledge(memory.store, f.path, "project", "constraint", [f.widgetFact.id], "The widget rule is final",
    { operation: { title: "Widget rule" } });
  const out = lines(memory.search("widget"));
  expect(out[0]).toMatch(/^\[K\d+@v1\] \[constraint\/project\] Widget rule — The widget rule is final$/);
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
  expect(memory.search("no such word")).toContain("No hit");
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
  const kept = knowledge(memory.store, f.path, "project", "constraint", [f.widgetFact.id], "gadget rule two", { operation: { title: "Gadget rule two" } });
  archive(memory.store, f.path, old.knowledgeId, old.commit, [f.widgetFact.id], "invalid", "The gadget rule no longer holds: the user withdrew it for good reasons.");
  const found = lines(memory.search("gadget", "knowledge", f.path));
  expect(found.find(l => l.includes("rule two"))).toMatch(/^\[K2@v1\] \[constraint\/project\] Gadget rule two — gadget rule two$/);
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
  expect(memory.search("advance width", "facts", f.path)).toMatchInlineSnapshot(`"[F1] Font width settled — The mono font has one fixed advance width."`);
});

test("a Raw line opens with its address once: the entry's own label and role word are not repeated", () => {
  const f = corpus();
  const id = `S${f.session.id}/T${f.turns[1]!.id}`;
  expect(lines(memory.search("second prompt", "raw", f.path))).toEqual([`[${id}#E1@user] second prompt about widgets`]);
  expect(lines(memory.search('"reply 2"', "raw", f.path))).toEqual([`[${id}#E2@assistant] reply 2 widgets`]);
  // A match only in the stripped label does not centre the snippet there.
  expect(lines(memory.search("user", "raw", { ...f.path, topk: 100 })).every(l => !/^\[S\d+\/T\d+#E\d+@user\] (\[T|user:)/.test(l))).toBe(true);
});

test("a fact line is the shared centred snippet of about 200 characters, as knowledge and Raw lines are", () => {
  const f = corpus();
  const long = `${"before ".repeat(60)}NEEDLE-136${" after".repeat(60)}`;
  const [fact] = facts(memory, f.path, [{ title: "Long fact", sources: [{ entry: f.first, text: long }] }]);
  const line = memory.search("NEEDLE-136", "facts", f.path) as string;
  expect(line).toMatch(new RegExp(`^\\[F${fact!.id}\\] Long fact — ….*NEEDLE-136.*…$`));
  expect(line.length).toBeLessThan(260);
  expect(lines(line)).toHaveLength(1);
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

test.each(["knowledge", "facts", "raw"] as const)("every term must occur in one %s item, with quoted phrases kept exact", layer => {
  const f = corpus();
  const body = "预览在 3090 端口重启\n预览实例 3090 仍开\nALPHA is separate from beta\nexact  phrase\n100% snake_case core\\api * : NEAR AND";
  const turn = memory.store.appendTurn({ sessionId: f.session.id, parentTurnId: f.turns.at(-1)!.id, kind: "turn",
    userPrompt: body, assistantText: "Only missingword appears here", startedAt: "2026-10-02T00:00:00Z" });
  const path = { ...f.path, headTurnId: turn.id };
  const source = memory.store.hydrateSourceEntries(memory.store.listSourceEntries(f.session.id).filter(e => e.turnId === turn.id).map(e => e.id))[0]!;
  const [fact] = facts(memory, path, [{ title: "Preview notes", sources: [{ entry: source, text: body }] }]);
  const rule = knowledge(memory.store, path, "project", "constraint", [fact!.id], body, { operation: { title: "Preview notes" } });
  const label = layer === "facts" ? `[F${fact!.id}]` : layer === "knowledge" ? `[K${rule.knowledgeId}@v1]` : `[S${f.session.id}/T${turn.id}#E1@user]`;
  for (const query of ["预览 3090 重启 预览实例", "预览 3090", "预览 重启", "预览　重启", "alpha\tBETA", '"exact  phrase"', '"exact  phrase', '"" 预览', "100% snake_case core\\api * : NEAR AND"])
    expect(memory.search(query, layer, path), query).toContain(label);
  for (const query of ['"预览 3090"', '"exact phrase"', "预览 missingword"])
    expect(memory.search(query, layer, path), query).toContain("No hit");
});

test("terms may match different searched fields without matching JSON punctuation or other items", () => {
  const f = corpus();
  const [fact] = facts(memory, f.path, [{ title: "ALPHA title", sources: [{ entry: f.first, text: "beta body" }] }]);
  const rule = knowledge(memory.store, f.path, "project", "constraint", [fact!.id], "beta body",
    { operation: { title: "ALPHA title", topics: ["gamma", "delta"] } });
  expect(memory.search("alpha beta", "facts", f.path)).toContain(`[F${fact!.id}] ALPHA title — beta body`);
  expect(memory.search("alpha beta gamma delta", "knowledge", f.path)).toContain(`[K${rule.knowledgeId}@v1]`);
  expect(memory.search('gamma ","', "knowledge", f.path)).toContain("No hit");
  memory.store.appendToolCall({ turnId: f.turns.at(-1)!.id, name: "AlphaTool", input: "预览 重启 gamma", result: "beta delta", status: "success" });
  expect(memory.search("AlphaTool beta delta", "raw", f.path)).toMatch(/@observation\]/);
  expect(memory.search("AlphaTool gamma", "raw", f.path)).toMatch(/@assistant\]/);
  expect(memory.search("预览 重启", "raw", f.path)).toMatch(/@assistant\]/);
  expect(memory.search("gamma beta", "raw", f.path)).toContain("No hit");
});

test("one Raw entry can satisfy terms in its text and in different tool calls", () => {
  const f = corpus();
  const turn = memory.store.appendTurn({ sessionId: f.session.id, kind: "turn", assistantText: "ALPHA preview", startedAt: "2026-10-02T00:00:00Z" });
  const calls = ["beta", "gamma"].map(input => {
    const call = memory.store.appendToolCall({ turnId: turn.id, name: "Read", input, status: "attempted" });
    return { ordinal: call.ordinal, callId: `call-${call.id}`, name: call.name, input, status: call.status };
  });
  seedSourceEntry(memory, turn.id, "assistant", "ALPHA preview", calls);
  const last = memory.store.listSourceEntries(f.session.id).at(-1)!;
  const out = lines(memory.search("alpha beta gamma", "raw"));
  expect(out).toHaveLength(1);
  expect(out[0]).toContain(`[S${f.session.id}/T${turn.id}#E${last.entryOrdinal}@assistant]`);
});

test("snippets use the earliest term regardless of query order and matchLines includes any term", async () => {
  const f = corpus();
  const body = `${"before ".repeat(60)}EARLY\n${"middle ".repeat(60)}LATER\nno matching word`;
  const turn = memory.store.appendTurn({ sessionId: f.session.id, parentTurnId: f.turns.at(-1)!.id, kind: "turn", userPrompt: body, startedAt: "2026-10-02T00:00:00Z" });
  const path = { ...f.path, headTurnId: turn.id };
  const source = memory.store.hydrateSourceEntries(memory.store.listSourceEntries(f.session.id).filter(e => e.turnId === turn.id).map(e => e.id))[0]!;
  const [fact] = facts(memory, path, [{ title: "Long notes", sources: [{ entry: source, text: body }] }]);
  knowledge(memory.store, path, "project", "constraint", [fact!.id], body, { operation: { title: "Long notes" } });
  for (const layer of ["knowledge", "facts", "raw"] as const) {
    const out = memory.search("later early", layer);
    expect(out).toContain("EARLY");
    expect(out).not.toContain("LATER");
  }
  const out = await memory.search("later early", "raw", { code: "return JSON.stringify(hits.map(h => ({ address: h.address, matchLines: h.matchLines })))" });
  const hits = JSON.parse(/Output:\n(.*)$/s.exec(out)![1]!) as { address: string; matchLines: number[] }[];
  expect(hits).toEqual([{ address: `trace://raw/S${f.session.id}/T${turn.id}#E1`, matchLines: [1, 2] }]);
});

test("queries without terms are refused by the tool and direct API", () => {
  const f = corpus();
  const tool = memory.tools({ kind: "manual", sessionId: f.session.id, branch: "main", currentTurnId: f.turns.at(-1)!.id }).find(t => t.name === "search")!;
  for (const query of ["", " \t\n　", '""', ' "" "" ']) {
    expect(() => memory.search(query)).toThrow(/no search terms/);
    expect(tool.execute({ query })).toMatch(/^rejected: .*query/);
  }
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

test("the declared hit types match the fields real hits carry, layer by layer: none missing, none undeclared", async () => {
  const f = corpus();
  const old = knowledge(memory.store, f.path, "project", "constraint", [f.widgetFact.id], "declared widget");
  knowledge(memory.store, f.path, "project", "constraint", [f.widgetFact.id], "declared widget too");
  archive(memory.store, f.path, old.knowledgeId, old.commit, [f.widgetFact.id], "invalid");
  const declared = declaredFields(SEARCH_HIT_TYPES);
  expect(Object.keys(declared)).toEqual(["Knowledge", "Fact", "Raw"]);
  // 136 ruling (SPEC3): a knowledge version belongs to no single Turn, so only facts and Raw carry session and turn.
  expect(declared.Knowledge).not.toEqual(expect.arrayContaining(["session"]));
  expect(declared.Knowledge).not.toEqual(expect.arrayContaining(["turn"]));
  expect(declared.Fact).toEqual(expect.arrayContaining(["session", "turn"]));
  expect(declared.Raw).toEqual(expect.arrayContaining(["session", "turn"]));
  const description = toolDefinitions.find(t => t.name === "search")!.description;
  expect(description).toContain(SEARCH_HIT_TYPES);
  const tool = memory.tools({ kind: "manual", sessionId: f.session.id, branch: "main", currentTurnId: f.turns.at(-1)!.id }).find(t => t.name === "search")!;
  // Every real item of every layer, in the sandbox where a script sees it: each declared field is an own property
  // (a lazily read one too) and the item has no other.
  const seen = await tool.execute({ query: "widget", topk: 50,
    code: `const declared = ${JSON.stringify(declared)}; const names = { knowledge: 'Knowledge', facts: 'Fact', raw: 'Raw' };
      return JSON.stringify(hits.map(h => { const fields = declared[names[h.layer]];
        return { layer: h.layer, status: h.status, missing: fields.filter(k => !Object.hasOwn(h, k)), undeclared: Object.keys(h).filter(k => !fields.includes(k)) }; }))` });
  const items = JSON.parse(/\[.*\]/.exec(seen as string)![0].replaceAll("\\\"", "\""));
  expect(new Set(items.map((item: { layer: string }) => item.layer))).toEqual(new Set(["knowledge", "facts", "raw"]));
  expect(items.some((item: { status: string }) => item.status === "archived")).toBe(true);
  for (const item of items) expect(item, `${item.layer} item`).toMatchObject({ missing: [], undeclared: [] });
});

test("candidates come from metadata: counting hits reads no Raw body, and a body is read when text, role or lines are first needed", async () => {
  const f = corpus();
  const entries = memory.store.listSourceEntries(f.session.id).length;
  const search = (code: string) => memory.search(undefined, "raw", { ...f.path, code }) as Promise<string>;
  const hydrated = countHydratedRows();
  try {
    expect(await search("return hits.length + ' ' + hits.map(h => h.address + h.entry + h.turn + h.session + h.time + h.citedBy.length).length")).toContain(`${entries} ${entries}`);
    expect(await search("return hits[0].address")).toContain("trace://raw/");
    expect(hydrated.reads()).toBe(0);
    expect(await search("return hits[0].text")).toMatch(/Output:\n.+/);
    expect(hydrated.reads()).toBeGreaterThan(0);
    expect(hydrated.reads()).toBeLessThanOrEqual(entries);
    hydrated.reset();
    // The default print needs bodies; a query search needs them to filter, and only for the Turns its index returns.
    memory.search(undefined, "raw", { ...f.path, topk: 1 });
    expect(hydrated.reads()).toBeGreaterThan(0);
  } finally { hydrated.restore(); }
});
