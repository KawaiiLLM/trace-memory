// node tests/perf/entry-upgrade-guidance.ts <isolated git archive of 862e406>
// Synthetic temporary databases only. No provider calls, configuration writes or installation.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Store, type SourceInput } from "../../src/core/store/index.ts";
import { piSourceBlocks } from "../../src/hosts/pi/source.ts";
import { tokens } from "../../src/core/render/index.ts";
import { toolDefinitions, dreamingToolDefinitions } from "../../src/core/api/tools.ts";

const baseline = process.argv[2];
if (!baseline) throw Error("Pass an isolated baseline archive directory");
const moduleAt = (path: string) => import(pathToFileURL(resolve(baseline, path)).href);
const oldTools = await moduleAt("src/core/api/tools.ts") as typeof import("../../src/core/api/tools.ts");
const oldStore = await moduleAt("src/core/store/index.ts") as typeof import("../../src/core/store/index.ts");
const oldSource = await moduleAt("src/hosts/pi/source.ts") as typeof import("../../src/hosts/pi/source.ts");
const size = (text: string) => ({ bytes: Buffer.byteLength(text), tokens: tokens(text) });
const prompts = Object.fromEntries(["noting", "consolidation", "dreaming"].map(role => [role, {
  before: size(readFileSync(resolve(baseline, `src/core/prompts/${role}.md`), "utf8")),
  after: size(readFileSync(new URL(`../../src/core/prompts/${role}.md`, import.meta.url), "utf8")),
}]));
const metadata = (tools: typeof toolDefinitions) => size(JSON.stringify(tools));
const samples = [];
for (let sample = 0; sample < 3; sample++) {
  const dir = mkdtempSync(join(tmpdir(), "tm-upgrade-measure-"));
  const path = join(dir, "fixture.sqlite");
  let store = new Store(path);
  const warn = console.warn;
  try {
    const projectId = store.createProject({ name: "synthetic", declaredBy: "mark" }).id;
    const sessionId = store.createSession({ projectId, host: "test", startedAt: "time", firstReplyAt: "time", enrollmentChoice: true }).id;
    const turnId = store.appendTurn({ sessionId, kind: "turn", startedAt: "time" }).id;
    const text = "Synthetic public text only. ".repeat(80);
    store.transaction(() => {
      for (let i = 0; i < 1200; i++) {
        const call = { callId: `call-${i}`, ordinal: i + 1, name: "bash", input: "{}", status: "attempted" };
        const block = { type: "toolCall", id: call.callId, name: call.name, arguments: {} };
        const content = [{ type: "text", text }, block, ...(i % 6 === 1 ? [block] : [])];
        store.appendSourceEntry({ sessionId, turnId, nativeId: `entry-${i}`, nativeLineage: "synthetic", role: "assistant", text,
          calls: i % 6 === 0 ? [] : [call], raw: JSON.stringify({ role: "assistant", content }) });
      }
    });
    const before = store.db.prepare("SELECT id, content, entry_ordinal FROM source_entries ORDER BY id").all();
    store.close();
    assert.throws(() => new oldStore.Store(path, oldSource.piSourceBlocks), /unique stored ordinal/);
    let calls = 0, warnings = 0;
    console.warn = () => { warnings++; };
    const normalizer = (input: SourceInput) => { calls++; return piSourceBlocks(input); };
    const start = performance.now(); store = new Store(path, normalizer); const upgradeMs = performance.now() - start;
    assert.deepEqual(store.db.prepare("SELECT id, content, entry_ordinal FROM source_entries ORDER BY id").all(), before);
    assert.equal(calls, 1200); assert.equal(warnings, 400);
    assert.equal(store.db.prepare("SELECT COUNT(*) n FROM source_entries WHERE blocks = 'null'").get()!.n, 400);
    store.close();
    const restart = performance.now(); store = new Store(path, normalizer); const reopenMs = performance.now() - restart;
    assert.equal(calls, 1200); assert.equal(warnings, 400);
    samples.push({ entries: before.length, legacyFailures: warnings, storedContentBytes: before.reduce((n, row) => n + Buffer.byteLength(String(row.content)), 0), upgradeMs, reopenMs });
  } finally { console.warn = warn; store.close(); rmSync(dir, { recursive: true, force: true }); }
}
console.log(JSON.stringify({ baseline: "862e40684b07bbe2be349d95139038facf9834c6", runtime: process.version,
  tools: { shared: { before: metadata(oldTools.toolDefinitions), after: metadata(toolDefinitions) },
    dreaming: { before: metadata(oldTools.dreamingToolDefinitions()), after: metadata(dreamingToolDefinitions()) } }, prompts, migration: samples }, null, 2));
