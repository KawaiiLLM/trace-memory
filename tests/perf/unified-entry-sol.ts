// Fixed synthetic fixture, not real conversation logs. Compare against an isolated pre-repair archive.
// node tests/perf/unified-entry-sol.ts .scratch/sol-repair/prior > .scratch/sol-repair/source-index.json
import assert from "node:assert/strict";
import { loadPrompt } from "../../src/core/prompts/load.ts";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as api from "../../src/core/api/index.ts";
import * as noting from "../../src/core/noting/index.ts";
import * as render from "../../src/core/render/index.ts";
import { unifiedFixture } from "../fixtures/unified-entry.ts";

const directory = process.argv[2];
if (!directory) throw new Error("pass an isolated pre-repair archive directory");
const oldApi = await import(pathToFileURL(resolve(directory, "src/core/api/index.ts")).href) as typeof api;
const oldNoting = await import(pathToFileURL(resolve(directory, "src/core/noting/index.ts")).href) as typeof noting;
const oldRender = await import(pathToFileURL(resolve(directory, "src/core/render/index.ts")).href) as typeof render;
const fixture = unifiedFixture();
const measure = (implementation: typeof api, freeze: typeof noting.freezeNoting, renderer: typeof render, prompt: string, mixed: boolean) => {
  const m = implementation.TraceMemory(":memory:", async () => { throw new Error("offline only"); }, {}, undefined,
    entry => fixture.entries.find(e => e.nativeId === entry.nativeId)!.blocks);
  try {
    const projectId = m.store.createProject({ name: "sol-fixture", declaredBy: "mark" }).id;
    const sessionId = m.store.createSession({ host: "test", projectId, startedAt: fixture.facts[0]!.createdAt, firstReplyAt: fixture.facts[0]!.createdAt, enrollmentChoice: true }).id;
    let parentTurnId: number | null = null;
    for (const fact of fixture.facts) {
      parentTurnId = m.store.appendTurn({ sessionId, parentTurnId, kind: "turn", startedAt: fact.createdAt }).id;
      for (const entry of fixture.entries.filter(e => e.turnId === fact.turnId)) {
        const { id: _, entryOrdinal: _ordinal, blocks: _blocks, ...input } = entry;
        m.appendEntry(input);
      }
    }
    m.selectEntries(sessionId, "main", fixture.entries.map(e => e.id));
    const visible = { raw: new Map(fixture.entries.filter((_, i) => !mixed || i % 3 !== 0).map(e => [e.nativeId, "source" as const])),
      factIds: new Set<number>(), knowledgeCommitIds: new Set<number>(), injection: false, suppliedGeneration: 0 };
    const input = { sessionId, branch: "main", headTurnId: parentTurnId!, mode: "fork" as const, visible };
    const frozen = freeze(m.store, input, m.config), p = frozen.prepared!;
    const textTokens = render.tokens(p.text), prefixTokens = 173;
    const capacity = prefixTokens + render.tokens(prompt) + textTokens;
    const exact = { ...input, boundary: { exactEntryIds: frozen.entries.map(e => e.id) } };
    assert.equal(freeze(m.store, { ...exact, capacity: { inputTokens: capacity, prefixTokens } }, m.config).prepared!.text, p.text);
    assert.throws(() => freeze(m.store, { ...exact, capacity: { inputTokens: capacity - 1, prefixTokens } }, m.config), /Noting capacity/);
    assert.equal(m.pendingTokens("noting", input).tokens, render.tokens(fixture.entries.map(e => renderer.renderEntry(e, m.config.render).content).join("\n\n")));
    return { selected: frozen.entries.map(e => e.id), rawEntries: p.material.entries.length, indexEntries: p.material.sources.length,
      indexBytes: Buffer.byteLength(p.material.sources.join("\n")), indexTokens: render.tokens(p.material.sources.join("\n")),
      headTokens: render.tokens(p.material.head ?? ""), incrementBytes: Buffer.byteLength(p.text), incrementTokens: textTokens,
      inputCapacity: capacity, acceptedAtCapacity: true, rejectedOneBelow: true,
      pendingTokens: m.pendingTokens("noting", input).tokens, triggerDue: m.taskEligibility("noting", input).due };
  } finally { m.close(); }
};
const oldPrompt = readFileSync(resolve(directory, "src/core/prompts/noting.md"), "utf8");
const prompt = loadPrompt("noting.md");
console.log(JSON.stringify({ prior: "94bdf393c979748bb6638148926b8e863b995f53", syntheticEntries: 240,
  allVisible: { before: measure(oldApi, oldNoting.freezeNoting, oldRender, oldPrompt, false), after: measure(api, noting.freezeNoting, render, prompt, false) },
  mixed: { before: measure(oldApi, oldNoting.freezeNoting, oldRender, oldPrompt, true), after: measure(api, noting.freezeNoting, render, prompt, true) } }, null, 2));
