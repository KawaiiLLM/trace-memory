// Run after extracting the baseline into .scratch/baseline (never the main worktree).
// node tests/perf/unified-entry-drift.ts .scratch/baseline > .scratch/unified-drift.json
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as current from "../../src/core/render/index.ts";
import { DEFAULT_CONFIG, toolDefinitions } from "../../src/core/api/index.ts";
import { unifiedFixture } from "../fixtures/unified-entry.ts";

const directory = process.argv[2];
if (!directory) throw new Error("pass an isolated extracted baseline directory");
const baseline = await import(pathToFileURL(resolve(directory, "src/core/render/index.ts")).href) as typeof current;
const oldTools = await import(pathToFileURL(resolve(directory, "src/core/api/tools.ts")).href) as { toolDefinitions: typeof toolDefinitions };
const { entries, facts } = unifiedFixture();
const times = new Map(facts.map(fact => [fact.turnId, fact.createdAt]));
const metrics = (raw: string[], semantic: typeof facts, renderer: typeof current) => {
  const rawText = raw.join("\n\n");
  const factsText = (selected: typeof facts) => renderer.renderFactGroups(selected, fact => renderer.renderFact(fact, []), times).join("\n");
  const prefixes = raw.map((_, i) => renderer.tokens(raw.slice(0, i + 1).join("\n\n")));
  const factPrefixes = semantic.map((_, i) => renderer.tokens(factsText(semantic.slice(0, i + 1))));
  const boundaries = <T>(items: T[], text: (items: T[]) => string) => {
    const ends: number[] = []; let start = 0;
    for (let end = 1; end <= items.length; end++) {
      if (renderer.tokens(text(items.slice(start, end))) > 10_000) {
        assert.ok(end - 1 > start, "the fixture's oldest whole item must fit");
        ends.push(end - 1); start = end - 1;
      }
    }
    ends.push(items.length); return ends;
  };
  return { raw: { bytes: Buffer.byteLength(rawText), tokens: renderer.tokens(rawText),
      triggerEntry: prefixes.findIndex(value => value >= 10_000) + 1,
      batchEnds: boundaries(raw, values => values.join("\n\n")), prefixes },
    facts: { bytes: Buffer.byteLength(factsText(semantic)), tokens: renderer.tokens(factsText(semantic)),
      triggerFact: factPrefixes.findIndex(value => value >= 5_000) + 1,
      batchEnds: boundaries(semantic, factsText), prefixes: factPrefixes } };
};
const beforeRaw = entries.map(entry => baseline.renderEntry(entry, DEFAULT_CONFIG.render).content);
const afterRaw = entries.map(entry => current.renderEntry(entry, DEFAULT_CONFIG.render).content);
// Same claims and selected facts, with old source labels versus newly authored exact citations.
const before = metrics(beforeRaw, facts.map(fact => ({ ...fact, source: [`T${fact.turnId}#t1`] })), baseline);
const after = metrics(afterRaw, facts, current);
const currentPrompt = readFileSync(new URL("../../src/core/prompts/noting.md", import.meta.url), "utf8");
const oldPrompt = readFileSync(resolve(directory, "src/core/prompts/noting.md"), "utf8");
const fixed = (prompt: string, tools: typeof toolDefinitions) => ({
  promptBytes: Buffer.byteLength(prompt), promptTokens: current.tokens(prompt),
  toolBytes: Buffer.byteLength(JSON.stringify(tools)), toolTokens: current.tokens(JSON.stringify(tools)) });
console.log(JSON.stringify({ baseline: "dfdeda694c9f280680e2ef018cdb37e9d3c35bdd", entries: entries.length, facts: facts.length,
  before, after, fixed: { before: fixed(oldPrompt, oldTools.toolDefinitions), after: fixed(currentPrompt, toolDefinitions) },
  examples: entries.slice(0, 4).map((entry, index) => ({ entry: `T${entry.turnId}#E${entry.entryOrdinal}`,
    before: beforeRaw[index], after: afterRaw[index], beforeTokens: current.tokens(beforeRaw[index]!), afterTokens: current.tokens(afterRaw[index]!) })) }, null, 2));
