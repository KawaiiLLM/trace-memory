// Ticket 136: a project-sized Raw search with code stays inside the ruled limits (a 10 s script
// deadline, 256 MB of script memory). The fixture is synthetic; nothing here reads a real store.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { TraceMemory } from "../../../src/core/api/index.ts";
import { SEARCH_CHUNK_TURNS } from "../../../src/core/api/search.ts";
import { CODE_DEADLINE_MS } from "../../../src/core/api/code.ts";
import { countHydratedRows, generate, type Fixture } from "../../perf/fixture.ts";

// Counts the questions the script's thread puts to the host (ticket 138), by passing every call through.
const asked = vi.hoisted(() => ({ fields: [] as string[] }));
vi.mock("../../../src/core/api/code.ts", async importOriginal => {
  const original = await importOriginal<typeof import("../../../src/core/api/code.ts")>();
  return { ...original, runCode: (source: string, host: Parameters<typeof original.runCode>[1], limits?: Parameters<typeof original.runCode>[2]) =>
    original.runCode(source, { ...host, field: (index, name) => { asked.fields.push(name); return host.field(index, name); } }, limits) };
});

let directory: string, fixture: Fixture, memory: ReturnType<typeof TraceMemory>;
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "tm-search-perf-"));
  fixture = generate(join(directory, "trace.db"), { entries: 20_000, resultChars: 3_000, facts: 300 });
  memory = TraceMemory(fixture.dbPath, async () => { throw new Error("no model calls"); });
}, 120_000);
afterAll(() => { memory.close(); rmSync(directory, { recursive: true, force: true }); });

const scope = () => ({ sessionId: fixture.sessionId, branch: fixture.branch, headTurnId: fixture.headTurnId });
const timed = async <T>(run: () => T | Promise<T>) => { const started = performance.now(); const value = await run(); return { value, ms: performance.now() - started }; };

test("a default Raw search reads a few Turns, not the project, however common its word", async () => {
  const hydrated = countHydratedRows();
  try {
    const { value, ms } = await timed(() => memory.search("build", "raw", scope()));
    expect((value as string).split("\n").filter(line => line.startsWith("[S"))).toHaveLength(10);
    expect(hydrated.reads()).toBeLessThan(200); // one chunk of Turns, against about 20,000 entries
    expect(ms).toBeLessThan(500);
  } finally { hydrated.restore(); }
});

test("code over every Raw entry of a project-sized store finishes well inside the script deadline and memory limit", async () => {
  const before = process.memoryUsage().rss;
  const { value, ms } = await timed(() => memory.search("build", "raw", { ...scope(), topk: 100_000,
    code: "let chars = 0, observations = 0; for (const h of hits) { chars += h.text.length; if (h.role === 'observation') observations++; } text(hits.length + ' ' + observations + ' ' + chars)" }));
  expect(value).toMatch(/^Script completed[\s\S]*Output:\n\d+ \d+ \d+$/);
  const [hits] = /\d+/.exec((value as string).split("Output:\n")[1]!)!;
  expect(Number(hits)).toBeGreaterThan(5_000);
  expect(ms).toBeLessThan(CODE_DEADLINE_MS / 2);
  expect(process.memoryUsage().rss - before).toBeLessThan(900 * 1024 * 1024);
}, 30_000);

test("a search with no query lists the newest entries cheaply and counts the whole project through code", async () => {
  const hydrated = countHydratedRows();
  try {
    const newest = await timed(() => memory.search(undefined, "all", { ...scope(), topk: 50 }));
    expect((newest.value as string).split("\n").filter(line => line.startsWith("["))).toHaveLength(50);
    expect(hydrated.reads()).toBeLessThan(200);
    expect(newest.ms).toBeLessThan(500);
  } finally { hydrated.restore(); }
  const whole = await timed(() => memory.search(undefined, "raw", { ...scope(), code: "text(hits.length)" }));
  expect(Number((whole.value as string).split("Output:\n")[1])).toBeGreaterThanOrEqual(fixture.entryCount);
  expect(whole.ms).toBeLessThan(CODE_DEADLINE_MS / 2);
  // 136 review SPEC1, by counting hydrated bodies and not by time: listing candidates reads none, so counting every
  // hit of the project hydrates 0, and reading one hit's text hydrates at most the chunk of Turns it sits in.
  const counted = countHydratedRows();
  try {
    const printed = await memory.search(undefined, "raw", { ...scope(), code: "return hits.length" }) as string;
    expect(Number(printed.split("Output:\n")[1])).toBeGreaterThanOrEqual(fixture.entryCount);
    expect(counted.reads()).toBe(0);
    expect(await memory.search(undefined, "raw", { ...scope(), code: "return hits[0].text.length > 0" })).toMatch(/Output:\ntrue$/);
    const newest = memory.store.listTurns(fixture.sessionId).map(turn => turn.id).sort((a, b) => b - a).slice(0, SEARCH_CHUNK_TURNS);
    const chunkEntries = [...memory.store.listSourceEntryRefsOf(newest).values()].reduce((sum, list) => sum + list.length, 0);
    expect(counted.reads()).toBeGreaterThan(0);
    expect(counted.reads()).toBeLessThanOrEqual(chunkEntries);
    expect(chunkEntries).toBeLessThan(fixture.entryCount / 10);
  } finally { counted.restore(); }
}, 30_000);

// 138: the first read of a lazy field answers for the whole chunk of Turns the hit sits in, so reading `role` of every
// hit costs one request per chunk and not one per hit; a second field costs one more request per chunk.
test("a script reading a lazy field of every hit asks the host once per chunk", async () => {
  const chunks = Math.ceil(memory.store.listTurns(fixture.sessionId).length / SEARCH_CHUNK_TURNS);
  asked.fields.length = 0;
  const counted = countHydratedRows();
  try {
    const out = await memory.search(undefined, "raw", { ...scope(), code: "let n = 0; for (const h of hits) if (h.role === 'observation') n++; return n + ' of ' + hits.length" }) as string;
    expect(out).toMatch(/Output:\n\d+ of \d+$/);
    expect(Number(/of (\d+)$/.exec(out)![1])).toBeGreaterThanOrEqual(fixture.entryCount);
    expect(asked.fields).toEqual(Array(chunks).fill("role"));
    expect(counted.reads()).toBeLessThanOrEqual(fixture.entryCount + 1_000); // each body read once, none twice
    asked.fields.length = 0;
    await memory.search(undefined, "raw", { ...scope(), code: "return hits.length" });
    expect(asked.fields).toEqual([]);
  } finally { counted.restore(); }
}, 30_000);
