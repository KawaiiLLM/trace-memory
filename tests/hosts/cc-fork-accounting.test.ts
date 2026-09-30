import { expect, test } from "vitest";
import { accountForkTranscript, catalogFromLiteral, priceResponse, priceResponses, readForkTranscript, transcriptResponses, type CcPriceCatalog } from "../../src/hosts/cc/fork-accounting.ts";

// Ticket 108: a CC fork's usage from its own transcript and its price from Claude Code's own catalog.

const catalog: CcPriceCatalog = {
  tiers: { tier_2_10: { input: 2, output: 10, cache_write_5m: 2.5, cache_write_1h: 4, cache_read: 0.2, web_search: 0.01 } },
  models: { "claude-sonnet-5-5": "tier_2_10" },
};
const row = (id: string, usage: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "assistant", message: { id, model: "claude-sonnet-5-5", usage, ...extra } });
// One fork response of the probe's mock: 40k input, 2k output, 100k read, 5k written (3k of them at the 1h rate).
const usage = (over: Record<string, unknown> = {}) => ({ input_tokens: 40000, output_tokens: 2000, cache_read_input_tokens: 100000,
  cache_creation_input_tokens: 5000, cache_creation: { ephemeral_1h_input_tokens: 3000, ephemeral_5m_input_tokens: 2000 }, ...over });
const PRICE = 0.08 + 0.02 + 0.02 + 0.012 + 0.005; // in + out + read + 3k@$4 + 2k@$2.5, per million

test("transcript usage keeps one latest response per message id, with its 1h split", () => {
  const text = [
    row("m1", usage({ output_tokens: 1 })), // the first, partial row of a streamed response
    row("m1", usage({ output_tokens: 2000 })), // the latest complete counters win
    "{not json, a torn line",
    row("m2", usage({ input_tokens: 1, cache_creation: undefined, cache_creation_input_tokens: 10 })),
    row("skip", { input_tokens: 1 }), // no complete counters
    JSON.stringify({ type: "assistant", message: { id: "syn", model: "<synthetic>", usage: usage() } }),
    JSON.stringify({ type: "user", message: { id: "u", usage: usage() } }),
  ].join("\n");
  const responses = transcriptResponses(text);
  expect(responses.map(r => [r.id, r.output, r.cacheWrite1h])).toEqual([["m1", 2000, 3000], ["m2", 2000, 0]]);
});

test("pricing follows Claude Code's formula against a fixture catalog: 1h/5m split, us geo, web search", () => {
  const [one] = transcriptResponses(row("m1", usage()));
  expect(priceResponse(catalog, one!)).toBeCloseTo(PRICE, 12);
  // Writes all at the 5m rate when nothing is marked 1h: 5000 x $2.5 instead of 3000 x $4 + 2000 x $2.5.
  const [fiveMinute] = transcriptResponses(row("m1", usage({ cache_creation: undefined })));
  expect(priceResponse(catalog, fiveMinute!)).toBeCloseTo(PRICE - 0.012 - 0.005 + 0.0125, 12);
  const [us] = transcriptResponses(row("m1", usage({ inference_geo: "us", server_tool_use: { web_search_requests: 2 } })));
  expect(priceResponse(catalog, us!)).toBeCloseTo(PRICE * 1.1 + 0.02, 12);
  expect(priceResponses(catalog, transcriptResponses([row("a", usage()), row("b", usage())].join("\n")))).toBeCloseTo(2 * PRICE, 12);
});

test("an unlisted model, fast mode and an unreadable catalog leave the cost unknown, never zero and never a partial sum", () => {
  const priced = row("a", usage()), other = row("b", usage(), { model: "claude-future-9" }), fast = row("c", usage({ speed: "fast" }));
  expect(priceResponses(catalog, transcriptResponses([priced, other].join("\n")))).toEqual({ unknown: "model claude-future-9 is not in Claude Code's price list" });
  expect(priceResponses(catalog, transcriptResponses([priced, fast].join("\n")))).toEqual({ unknown: expect.stringContaining("fast mode") });
  expect(catalogFromLiteral("{not a catalog}")).toBeUndefined();
});

test("the baked catalog literal, as the bundle spells it, parses into tiers and a model map", () => {
  const literal = '{"//":"Hand-maintained baked-in model catalog \\u2014 one, two:three",schema_version:1,pricing_tiers:{tier_2_10:{input:2,output:10,cache_write_5m:2.5,cache_write_1h:4,cache_read:0.2,web_search:0.01}},' +
    'models:[{id:"claude-sonnet-5-5",eager:!0,cutoff:void 0,provider_ids:{first_party:"claude-sonnet-5-5-20260601"},pricing:"tier_2_10"},{id:"no-tier",pricing:"missing"}]}';
  expect(catalogFromLiteral(literal)).toEqual({ tiers: catalog.tiers, models: { "claude-sonnet-5-5": "tier_2_10", "claude-sonnet-5-5-20260601": "tier_2_10" } });
});

// A clock and file the test controls: the transcript is written after the event fires.
function harness(files: Record<number, string | null>) {
  let clock = 0;
  const at = () => { const times = Object.keys(files).map(Number).filter(t => t <= clock); return files[Math.max(...times)] ?? null; };
  return { now: () => clock, sleep: async (ms: number) => { clock += ms; }, read: () => at(), clock: () => clock };
}
const tokens = { input: 80000, output: 4100, cacheRead: 200000, cacheWrite: 10000 };
const late = [row("a", usage({ output_tokens: 2000 })), row("b", usage({ output_tokens: 2100 }))].join("\n");

test("bounded read: a transcript that catches up after a late flush is a match, however late within ten seconds", async () => {
  const h = harness({ 0: null, 60: row("a", usage({ output_tokens: 2000 })), 100: late });
  const read = await readForkTranscript("x", tokens, h);
  expect(read.status).toBe("match");
  expect(h.clock()).toBeGreaterThanOrEqual(100); // it waited for the flush
  expect(h.clock()).toBeLessThan(10_000);
  expect((await readForkTranscript("x", tokens, harness({ 0: null, 9_900: late }))).status).toBe("match");
});

test("bounded read: a transcript that never reaches the recorded tokens times out at ten seconds; one already above them mismatches at once", async () => {
  const short = harness({ 0: row("a", usage({ output_tokens: 2000 })) });
  expect(await readForkTranscript("x", tokens, short)).toMatchObject({ status: "timeout", present: true });
  expect(short.clock()).toBeGreaterThanOrEqual(10_000);
  expect((await readForkTranscript("x", tokens, harness({ 0: null }))).present).toBe(false);
  const over = harness({ 0: [late, row("c", usage())].join("\n") });
  expect((await readForkTranscript("x", tokens, over)).status).toBe("mismatch");
  expect(over.clock()).toBe(0);
});

test("a match prices each response and keeps the recorded tokens; the cost is exactly the sum of the responses", async () => {
  const account = await accountForkTranscript("x", tokens, () => catalog, harness({ 0: late }));
  expect(account.patch?.usage).toMatchObject({ ...tokens, cost: { total: expect.closeTo(PRICE * 2 + 0.001, 9) } });
  expect(account.patch?.problem).toBeUndefined();
  expect(account.patch?.usageStatus).toBeUndefined();
});

test("an undercount or a missing transcript records a problem and no cost; an unreadable catalog keeps the tokens and says why", async () => {
  const under = await accountForkTranscript("x", tokens, () => catalog, harness({ 0: row("a", usage({ output_tokens: 2000 })) }));
  expect(under.patch).toEqual({ problem: expect.stringMatching(/cost unknown: its transcript did not reach the recorded tokens \(timeout\) within 10 s/) });
  const none = await accountForkTranscript("x", tokens, () => catalog, harness({ 0: null }));
  expect(none.patch?.problem).toContain("was never written");
  const noCatalog = await accountForkTranscript("x", tokens, () => ({ unknown: "the running Claude Code executable cannot be found" }), harness({ 0: late }));
  expect(noCatalog.patch?.usage).toEqual(tokens); // tokens kept, no cost key
  expect(noCatalog.patch?.problem).toBe("CC fork cost unknown: the running Claude Code executable cannot be found");
});

test("a fork stopped before it completed records whatever its transcript holds as partial usage, priced as known usage only", async () => {
  const partial = await accountForkTranscript("x", undefined, () => catalog, { ...harness({ 0: row("a", usage()) }), stablePolls: 2 });
  expect(partial.patch).toMatchObject({ usage: { input: 40000, output: 2000, cacheRead: 100000, cacheWrite: 5000, cost: { total: expect.closeTo(PRICE, 9) } }, usageStatus: "partial" });
  // With no transcript at all the usage stays unknown: nothing to amend.
  expect((await accountForkTranscript("x", undefined, () => catalog, { ...harness({ 0: null }), stablePolls: 2 })).patch).toBeUndefined();
});

test("every missed response warns once with the input tokens read from cache; hits and unknown responses warn nothing", async () => {
  const miss = (id: string) => row(id, usage({ input_tokens: 30000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 10, cache_creation: undefined }));
  const hit = row("hit", usage({ input_tokens: 100, cache_read_input_tokens: 40000, cache_creation_input_tokens: 0, output_tokens: 10, cache_creation: undefined }));
  const tiny = row("tiny", usage({ input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 10, cache_creation: undefined }));
  const account = await accountForkTranscript("x", undefined, () => catalog, { ...harness({ 0: [miss("m1"), hit, tiny, miss("m2")].join("\n") }), stablePolls: 2 });
  expect(account.warnings).toEqual(Array(2).fill("Trace Memory: fork cache miss (0 of 30000 input tokens read from cache)."));
  expect(account.patch?.cacheMiss).toMatchObject({ miss: true, input: 30000 });
});
