import { afterEach, expect, test } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { TraceMemory } from "../../src/core/api/index.ts";
import { knowledgeBatch, legacyFacts } from "../support/seed.ts";
import { databaseIdentity, decodeCcInjection } from "../../src/hosts/cc/injection.ts";

const dirs: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const epoch = Date.parse("2026-09-26T10:00:00Z");
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const put = (path: string, value: unknown) => {
  writeFileSync(`${path}.tmp`, JSON.stringify(value)); renameSync(`${path}.tmp`, path);
};
async function until(path: string) {
  const end = performance.now() + 15_000;
  while (!existsSync(path)) {
    if (performance.now() > end) throw new Error(`test barrier timed out: ${path}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
function fixture(real = false, prompt = false) {
  // All artifacts belong to this checkout; no native CLI, installed plugin or shared cache.
  const scratch = resolve(".scratch"); mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, "92-snapshot-")); dirs.push(dir);
  const plugin = join(dir, "plugin"), stateDir = join(dir, "state"), dbPath = join(dir, "db.sqlite");
  mkdirSync(join(plugin, ".claude-plugin"), { recursive: true }); mkdirSync(join(plugin, "dist"));
  put(join(plugin, ".claude-plugin/plugin.json"), { version: "92-snapshot" });
  const configPath = join(plugin, "cc.config.json");
  put(configPath, { dbPath, stateDir, baseline: "2025-01-01T00:00:00.000Z" });
  const transcript = join(dir, "native.jsonl");
  writeFileSync(transcript, JSON.stringify({ uuid: "first-user", parentUuid: null, type: "user",
    timestamp: "2026-01-02T00:00:00.000Z", promptSource: "typed", message: { role: "user", content: "hello" } }) + "\n");
  const stageDir = join(stateDir, prompt ? "prompt-delta" : "session-start", "snapshot-test");
  const script = real
    ? `import(${JSON.stringify(pathToFileURL(resolve("src/hosts/cc/index.ts")).href)}).then(m => m.runCcCommand()).catch(e => {console.error(e);process.exitCode=1;});`
    : `const fs = require('node:fs'); const path = require('node:path');
const config = JSON.parse(fs.readFileSync(process.argv.at(-1), 'utf8'));
const log = path.join(path.dirname(process.argv.at(-1)), 'calls.jsonl');
fs.appendFileSync(log, JSON.stringify({command:process.argv[2],now:Date.now()})+'\\n');
if (['hook-slices', 'hook-delta'].includes(process.argv[2])) {
  if (fs.existsSync(path.join(path.dirname(log),'fail'))) throw new Error('fixture producer failure');
  if (fs.existsSync(path.join(path.dirname(log),'mutate-transcript'))) {
    const input = JSON.parse(fs.readFileSync(0, 'utf8')); fs.appendFileSync(input.transcript_path, 'changed');
  }
  process.stdout.write(JSON.stringify({selection:'a'.repeat(64),snapshot:{at:Date.now()},
    slices:Array.from({length:24},(_,slot)=>({hookSpecificOutput:{hookEventName:'SessionStart', additionalContext:Date.now()+':'+slot}}))}));
}`;
  writeFileSync(join(plugin, "dist/cc.cjs"), script);
  let sequence = 0;
  function run(slot: number, now: number, options: { pauseReader?: boolean; pauseSnapshot?: boolean; holdInput?: boolean } = {}) {
    const control = join(dir, `control-${sequence++}.json`); put(control, { now, ...options });
    const child = spawn(process.execPath, ["--import", resolve("tests/hosts/snapshot-stage-preload.mjs"),
      resolve("plugin/hooks/slice.mjs"), configPath, String(slot)], {
      stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, CLAUDE_PID: "", TM_SNAPSHOT_CONTROL: control,
        NODE_OPTIONS: `--import=${pathToFileURL(resolve("tests/hosts/snapshot-stage-preload.mjs")).href}` },
    });
    children.push(child);
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
    const result = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      child.on("error", reject); child.on("close", code => resolve({ code, stdout, stderr }));
    });
    const input = JSON.stringify({ hook_event_name: prompt ? "UserPromptSubmit" : "SessionStart", source: "startup",
      session_id: "snapshot-test", transcript_path: transcript, ...(prompt ? { prompt: "next prompt" } : {}) });
    if (!options.holdInput) child.stdin.end(input);
    return { control, result, input: () => child.stdin.end(input),
      time: (now: number) => put(control, { ...read(control), now }),
      resume: () => writeFileSync(`${control}.resume`, "continue") };
  }
  const stages = () => readdirSync(stageDir).filter(file => file.endsWith(".json")).map(file => read(join(stageDir, file)));
  const calls = () => readFileSync(join(plugin, "calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  return { dir, plugin, stageDir, stateDir, dbPath, transcript, run, stages, calls };
}

test("92: real staging renders once across an external mid-snapshot commit and 24 permuted consumers", async () => {
  const f = fixture(true);
  const memory = TraceMemory(f.dbPath, async () => { throw new Error("offline only"); });
  try {
    const project = memory.store.createProject({ name: "fixture", declaredBy: "mark" });
    const session = memory.store.createSession({ enrollmentChoice: true, host: "fixture", projectId: project.id,
      startedAt: "2026-01-01T00:00:00.000Z", firstReplyAt: "2026-01-01T00:00:00.000Z" });
    const turn = memory.store.appendTurn({ sessionId: session.id, kind: "turn", startedAt: "now", userPrompt: "a rule" });
    const source = memory.appendEntry({ sessionId: session.id, turnId: turn.id, nativeLineage: "fixture", nativeId: "rule",
      role: "user", text: "a rule", raw: "a rule", calls: [] });
    const evidence = legacyFacts(memory.store, { kind: "manual", sessionId: session.id, createdAt: "now" },
      [{ sources: [{ entry: source, address: `T${turn.id}#E${source.entryOrdinal}` }], category: "decision",
        actor: "user", text: "Rule evidence", createdAt: "now" }]).facts[0]!;
    const content = { author: "fixture", topics: [], reason: "fixture", supports: [evidence.id],
      createdAt: "now", category: "constraint" as const, scope: "global" as const };
    const created = knowledgeBatch(memory.store, memory.store.knowledgePath(session.id, "main", turn.id),
      Array.from({ length: 24 }, (_, n) => ({ ...content, text: `Original rule ${n}: ${"x".repeat(6000)}` })),
      { kind: "manual", createdAt: "now" });
    memory.store.db.exec("UPDATE knowledge_budget_policy SET global_tokens=100000");
    const oldIds = created.committed.map(commit => commit.commit);
    const producer = f.run(0, epoch, { pauseSnapshot: true });
    await until(`${producer.control}.snapshot`);
    const path = { sessionId: session.id, branch: "main", headTurnId: turn.id };
    const claim = memory.store.acquireClaim(path, "dreaming", "snapshot-fixture")!;
    const range = memory.store.retainKnowledgePoolRange(path, "global", claim);
    const run = memory.store.bindDreamingRun({ kind: "dreaming", sessionId: session.id, branch: "main", projectId: project.id,
      claim, dreamingRangeId: range.id, executionId: memory.store.beginExecution({ sessionId: session.id,
        phase: "dreaming", head: range.anchor, origin: range.origin }), createdAt: "later" });
    const changed = memory.store.commitConsolidationRun({ path, run,
      operations: [{ ...content, op: "update", knowledgeId: created.committed[0]!.knowledgeId, baseCommit: oldIds[0]!,
        text: "NEW concurrent rule" }] });
    if (!changed.ok) throw new Error(changed.problems.join(";"));
    const newId = changed.committed[0]!.commit;
    // A real eligible waiter starts while the renderer still holds its original read snapshot.
    const waiter = f.run(23, epoch + 54_999);
    await until(`${waiter.control}.checked`);
    waiter.time(epoch + 55_001); // After producer deadline, still before waiter's own deadline.
    producer.resume();
    const first = await producer.result;
    expect(first.code, first.stderr).toBe(0);
    const waited = await waiter.result;
    expect(waited.code, waited.stderr).toBe(0);
    const order = Array.from({ length: 22 }, (_, n) => (n * 7) % 22 + 1);
    const rest = await Promise.all(order.map(slot => f.run(slot, epoch + 1).result));
    for (const result of rest) expect(result.code, result.stderr).toBe(0);
    const stage = f.stages(); expect(stage).toHaveLength(1);
    expect(stage[0].snapshot.watermarks.kr).toBe(oldIds.at(-1));
    expect(memory.store.db.prepare("SELECT MAX(id) n FROM knowledge_revisions").get()!.n).toBe(newId);
    const outputs = [first, waited, ...rest].map((result, index) => { expect(result.stdout, `slot ${index}: ${result.stderr}`).not.toBe(""); return JSON.parse(result.stdout); });
    expect(outputs).toHaveLength(24);
    const visible = { db: databaseIdentity(f.dbPath), nativeSession: "snapshot-test", coreSession: null };
    const decoded = outputs.map(output => decodeCcInjection(output.hookSpecificOutput.additionalContext, visible)!);
    const delivered = decoded.sort((a, b) => a.slice![0] - b.slice![0]).flatMap(value => value.commits);
    expect(delivered).toEqual(oldIds); expect(delivered).not.toContain(newId);
    for (const output of outputs) {
      const slot = decodeCcInjection(output.hookSpecificOutput.additionalContext, visible)!.slice![0];
      expect(output).toEqual(stage[0].slices[slot]);
    }
    // 97 "Staged is delivered": every part of the staged publication is recorded, with its own cost,
    // before any slot prints; a segment the conversation later lost still counts.
    expect(stage[0].slices.filter(Boolean)).toHaveLength(24);
    const recorded = memory.store.db.prepare("SELECT commits, knowledge_tokens FROM knowledge_deliveries WHERE owner = ? ORDER BY id")
      .all("cc:snapshot-test") as { commits: string; knowledge_tokens: number }[];
    expect(recorded.flatMap(row => JSON.parse(row.commits))).toEqual(oldIds);
    expect(recorded.map(row => row.knowledge_tokens)).toEqual(decoded.map(value => value.knowledgeTokens));
    // At the next SessionStart only the version committed during the snapshot is missing.
    const next = await f.run(0, epoch + 60_000).result;
    expect(next.code, next.stderr).toBe(0);
    const nextStage = f.stages().find(value => value.deadline === epoch + 115_000)!;
    const delta = nextStage.slices.filter(Boolean).flatMap((output: any) => decodeCcInjection(output.hookSpecificOutput.additionalContext, visible)!.commits);
    expect(delta).toEqual([newId]);
  } finally { memory.store.close(); }
}, 30_000);

test("92: deadline is exclusive; old delayed reader keeps its generation after the next one publishes", async () => {
  const f = fixture();
  expect((await f.run(0, epoch).result).code).toBe(0);
  const old = f.run(5, epoch + 54_999, { pauseReader: true });
  await until(`${old.control}.paused`);
  const next = await f.run(0, epoch + 55_000).result;
  expect(next.code, next.stderr).toBe(0);
  old.time(epoch + 55_001); old.resume();
  const delayed = await old.result;
  expect(delayed.code, delayed.stderr).toBe(0);
  expect(delayed.stdout).toContain(`${epoch}:5`);
  expect(next.stdout).toContain(`${epoch + 55_000}:0`);
  const stages = f.stages().sort((a, b) => a.deadline - b.deadline);
  expect(stages).toHaveLength(2); expect(stages[1].windowStart).toBe(stages[0].deadline);
  expect(f.calls().map(call => call.command)).toEqual(["hook-prepare", "hook-slices", "hook-prepare", "hook-slices"]);
  // If an old generation is unavailable, an old reader must not join the later producer.
  const earlier = f.run(3, epoch + 54_999, { pauseReader: true });
  await until(`${earlier.control}.paused`);
  const oldFile = readdirSync(f.stageDir).find(file => file.endsWith(`.${epoch + 55_000}.json`))!;
  rmSync(join(f.stageDir, oldFile)); earlier.resume();
  const rejected = await earlier.result;
  expect(rejected.code).not.toBe(0); expect(rejected.stderr).toContain("precedes the available");
});

test("92: Hook start precedes stdin waiting; its own exhausted deadline fails even with a staged result", async () => {
  const f = fixture(); expect((await f.run(0, epoch).result).code).toBe(0);
  const old = f.run(4, epoch + 1, { holdInput: true });
  await until(`${old.control}.input`);
  old.time(epoch + 55_001); old.input();
  const result = await old.result;
  expect(result.code).not.toBe(0); expect(result.stderr).toContain("deadline exceeded");
  expect(f.stages()).toHaveLength(1);
});

test("92: a producer that leaves its lock cannot make another Hook wait beyond its own deadline", async () => {
  const f = fixture(); expect((await f.run(0, epoch).result).code).toBe(0);
  const key = readdirSync(f.stageDir).find(file => file.endsWith(".json"))!.split(".")[0]!;
  mkdirSync(join(f.stageDir, `${key}.lock`));
  const waiting = f.run(0, epoch + 55_000);
  await until(`${waiting.control}.checked`);
  waiting.time(epoch + 110_000);
  const result = await waiting.result;
  expect(result.code).not.toBe(0); expect(result.stderr).toContain("deadline exceeded");
  expect(result.stdout).toBe(""); expect(f.calls()).toHaveLength(2);
});

test("92: producer failure is shared only for its window; later invocation retries preparation", async () => {
  const f = fixture(); writeFileSync(join(f.plugin, "fail"), "fail");
  const first = await f.run(0, epoch).result;
  expect(first.code).not.toBe(0); expect(first.stderr).toContain("fixture producer failure");
  rmSync(join(f.plugin, "fail"));
  // 97: the producer reported the failure once; a slot sharing its window passes through silently.
  const eligible = await f.run(2, epoch + 54_999).result;
  expect(eligible).toMatchObject({ code: 0, stdout: "" });
  expect(eligible.stderr).not.toMatch(/fail/i);
  expect(f.calls()).toHaveLength(2);
  const next = await f.run(2, epoch + 55_000).result;
  expect(next.code, next.stderr).toBe(0); expect(f.calls()).toHaveLength(4);
  writeFileSync(join(f.plugin, "fail"), "fail");
  const laterFailure = await f.run(2, epoch + 200_000).result;
  expect(laterFailure.code).not.toBe(0);
  expect(f.stages().some(stage => stage.deadline === epoch + 55_000)).toBe(false);
});

test("97: Claude Code appending to the transcript during SessionStart rendering publishes the staged parts", async () => {
  const f = fixture(); writeFileSync(join(f.plugin, "mutate-transcript"), "change");
  const result = await f.run(0, epoch).result;
  expect(result.code, result.stderr).toBe(0); expect(result.stdout).toContain(":0");
  expect(f.calls().map(call => call.command)).toEqual(["hook-prepare", "hook-slices"]);
  expect(f.stages()).toHaveLength(1); expect(f.stages()[0].slices).toHaveLength(24);
});

test("97: a prompt delta renders once, with no preparation pass, while the transcript grows", async () => {
  const f = fixture(false, true);
  writeFileSync(join(f.plugin, "mutate-transcript"), "append");
  const result = await f.run(0, epoch).result;
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
  expect(f.calls().map(call => call.command)).toEqual(["hook-delta"]);
  expect(f.stages()).toHaveLength(1);
  expect(f.stages()[0].slices).toHaveLength(24);
});

test("92: carrier corruption and native identity replacement still fail closed", async () => {
  const f = fixture(); expect((await f.run(0, epoch).result).code).toBe(0);
  const file = join(f.stageDir, readdirSync(f.stageDir).find(file => file.endsWith(".json"))!);
  const original = readFileSync(file, "utf8");
  const corrupted = read(file); corrupted.slices[0].hookSpecificOutput.additionalContext = "wrong body"; put(file, corrupted);
  const invalid = await f.run(0, epoch + 1).result;
  expect(invalid.code).not.toBe(0); expect(invalid.stderr).toContain("invalid SessionStart stage generation");
  writeFileSync(file, original);
  mkdirSync(join(f.stateDir, "bindings"), { recursive: true });
  put(join(f.stateDir, "bindings/snapshot-test.json"), { nativeSessionId: "other" });
  const replaced = await f.run(0, epoch + 1).result;
  expect(replaced.code).not.toBe(0); expect(replaced.stderr).toContain("native identity");
});
