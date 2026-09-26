// Offline, task-local benchmark: run under /tmp/tm-with-suite-lock.sh with an output directory.
import { copyFileSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { TraceMemory, noVisibility, type RunAgent } from "../../src/core/api/index.ts";
import { Store } from "../../src/core/store/index.ts";
import { freezeNoting } from "../../src/core/noting/index.ts";
import { tokens } from "../../src/core/render/index.ts";
import { generate, countHydratedRows, countSourceReads, countGraphResolutions, countPathSnapshots } from "./fixture.ts";

const output = process.argv[2];
if (!output) throw new Error("task-local output directory required");
mkdirSync(output, { recursive: true });
const measurements: Record<string, unknown>[] = [];
const lengths = [200, 2_000];
const repeats = 6; // first sample cold, five warm; no sample discarded
const quantiles = (samples: number[]) => {
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return { min: sorted[0], median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1]! + sorted[middle]!) / 2, max: sorted.at(-1) };
};
function counters() {
  const raw = countSourceReads(), hydrated = countHydratedRows(), graphs = countGraphResolutions(), paths = countPathSnapshots();
  return { reset: () => { raw.reset(); hydrated.reset(); graphs.reset(); paths.reset(); },
    value: () => ({ directRawReads: raw.reads(), hydratedRows: hydrated.reads(), graphResolutions: graphs.resolutions(), pathSnapshots: paths.snapshots() }),
    restore: () => { paths.restore(); graphs.restore(); hydrated.restore(); raw.restore(); } };
}
function sample(name: string, size: number, action: () => unknown, extra: Record<string, unknown> = {}) {
  const counter = counters(), times: number[] = [], work: ReturnType<typeof counter.value>[] = [];
  try {
    for (let i = 0; i < repeats; i++) {
      counter.reset(); const start = performance.now(); action(); times.push(performance.now() - start); work.push(counter.value());
    }
  } finally { counter.restore(); }
  measurements.push({ name, size, coldMs: times[0], warmMs: times.slice(1), warmDistributionMs: quantiles(times.slice(1)), work, ...extra });
}
if (!process.argv.includes("--fixed-only")) for (const length of lengths) {
  const db = join(output, `fixture-${length}.db`);
  rmSync(db, { force: true }); // only this script's disposable fixture, including a prior failed run
  const fixture = generate(db, { entries: length, facts: Math.max(20, Math.floor(length / 20)), resultChars: 256 });
  // Restore the final three entries as pending. The generator may already have a larger
  // contiguous pending suffix (the large fixture has 30); report its actual size below.
  const seeded = new Store(db);
  try {
    const tail = seeded.sourcePath(fixture.sessionId, fixture.branch, fixture.headTurnId).slice(-3);
    seeded.transaction(() => { for (const entry of tail) seeded.db.prepare("DELETE FROM noted_entries WHERE entry_id=?").run(entry.id); });
  } finally { seeded.close(); }
  const memory = TraceMemory(db, async () => { throw new Error("provider unexpectedly called"); });
  const store = memory.store;
  const target = { sessionId: fixture.sessionId, branch: fixture.branch, headTurnId: fixture.headTurnId };
  const branch = { ...target, branch: fixture.siblingBranch, headTurnId: fixture.siblingHeadTurnId };
  const full = store.sourcePath(target.sessionId, target.branch, target.headTurnId);
  const pending = store.pendingEntries(target.sessionId, target.branch, target.headTurnId);
  const inventory = { entries: fixture.entryCount, turns: fixture.turnCount, facts: fixture.factCount,
    knowledge: fixture.knowledgeCount, pending: pending.length, rawChars: fixture.rawChars, dbBytes: statSync(db).size };
  let terminalBaseRevisions = fixture.knowledgeCount;
  try {
    sample("unchanged path, missing-body injection", length, () => memory.injection(target, noVisibility()), inventory);
    // The first call for a changed target builds its view; later calls are warm, on the SAME revision set.
    const supplied = noVisibility();
    for (const item of store.currentKnowledge(target)) supplied.knowledgeCommitIds.add(item.revision.id);
    sample("no-delta injection, exact retained versions", length, () => memory.injection(target, supplied), inventory);
    const original = store.listBranchFacts(target.sessionId, target.branch, target.headTurnId)[0]!;
    const changed = store.commitConsolidationRun({ path: target,
      run: { kind: "manual", sessionId: target.sessionId, branch: target.branch, createdAt: "2026-09-26T00:00:00Z" },
      operations: [{ op: "create", handle: "$change", author: "benchmark", text: "new synthetic rule",
        category: "constraint", scope: "session", supports: [original.id], topics: [], reason: "benchmark", createdAt: "2026-09-26T00:00:00Z" }] });
    if (!changed.ok) throw Error(changed.problems.join("; "));
    sample("changed knowledge injection", length, () => memory.injection(target, supplied), { ...inventory, newVersions: changed.committed.length });
    sample("rewind / branch switch injection pair", length, () => { memory.injection(branch, noVisibility()); memory.injection(target, supplied); },
      { ...inventory, siblingHead: branch.headTurnId, mainPathEntries: full.length });
    const counter = counters();
    try {
      const times: number[] = [], work: ReturnType<typeof counter.value>[] = [];
      let selectedEntries = 0, materialChars = 0;
      for (let i = 0; i < repeats; i++) {
        counter.reset(); const started = performance.now();
        const frozen = freezeNoting(store, { ...target, mode: "subagent" }, memory.config, memory.resultText);
        times.push(performance.now() - started); work.push(counter.value());
        selectedEntries = frozen.entries.length; materialChars = frozen.prepared?.text.length ?? 0;
      }
      measurements.push({ name: "admitted N freeze / compact preparation", size: length,
        coldMs: times[0], warmMs: times.slice(1), warmDistributionMs: quantiles(times.slice(1)), work, ...inventory,
        selectedEntries, materialChars, note: "actual repeated freeze on pending batch; no provider" });
    } finally { counter.restore(); }
    terminalBaseRevisions = Number((store.db.prepare("SELECT count(*) n FROM knowledge_revisions").get() as { n: number }).n);
  } finally { memory.close(); }
  // Terminal measurements run distinct real N tasks on identical disposable copies. The provider is
  // an in-process deterministic script; the timer inside commitNotingRun measures the short atomic
  // publication separately from admission/freeze and from script/tool-call time.
  const terminal: { totalMs: number; commitMs: number; work: ReturnType<ReturnType<typeof counters>["value"]>; facts: number; revisions: number; processed: number }[] = [];
  for (let i = 0; i < repeats; i++) {
    const copy = join(output, `task-${length}-${i}.db`);
    copyFileSync(db, copy);
    let commitMs = NaN;
    const agent: RunAgent = async raw => {
      const task = raw as { tools: { name: string; execute: (input: unknown) => string }[]; reportRequest: (request: unknown) => void;
        entryIds: number[] };
      const request = { messages: [{ role: "user", content: "synthetic benchmark" }] };
      task.reportRequest(request);
      const write = (name: string, input: unknown) => {
        const result = task.tools.find(tool => tool.name === name)!.execute(input);
        if (result.includes("rejected:")) throw Error(`${name} rejected: ${result}`);
      };
      const first = task.entryIds[0]!;
      const entry = local!.store.getSourceEntry(first)!;
      const path = local!.store.sourcePath(target.sessionId, target.branch, target.headTurnId);
      const ordinal = path.filter(item => item.turnId === entry.turnId).findIndex(item => item.id === first) + 1;
      write("note", { facts: [{ text: "Synthetic user specified a durable rule", source: [`T${entry.turnId}#E${ordinal}`] }] });
      write("memory", { operations: [{ op: "create", text: "Synthetic rule applies", category: "constraint",
        scope: "session", supports: ["$1"], topics: [], reason: "benchmark", }], skipped: [] });
      return { outcome: "success", output: "done", request };
    };
    let local: ReturnType<typeof TraceMemory> | undefined;
    local = TraceMemory(copy, agent);
    const instrumented = local.store;
    const old = instrumented.commitNotingRun.bind(instrumented);
    instrumented.commitNotingRun = (input => { const started = performance.now(); const result = old(input);
      commitMs = performance.now() - started; return result; }) as typeof instrumented.commitNotingRun;
    const count = counters();
    try {
      count.reset(); const started = performance.now();
      const result = await local.noting({ ...target, mode: "subagent" });
      const totalMs = performance.now() - started;
      const measuredWork = count.value();
      if (result.outcome !== "success") throw Error(`real N failed: ${JSON.stringify(result)}`);
      const facts = local.store.listSessionFacts(target.sessionId).length - fixture.factCount;
      const revisions = Number((local.store.db.prepare("SELECT count(*) n FROM knowledge_revisions").get() as { n: number }).n) - terminalBaseRevisions;
      const processed = pending.filter(entry => local!.store.entryNoted(entry.id)).length;
      if (facts !== 1 || revisions !== 1 || processed === 0) throw Error(`terminal not published: ${JSON.stringify({ facts, revisions, processed })}`);
      terminal.push({ totalMs, commitMs, work: measuredWork, facts, revisions, processed });
    } finally { count.restore(); local.close(); rmSync(copy, { force: true }); }
  }
  measurements.push({ name: "real N admitted + scripted tools + atomic terminal", size: length,
    coldMs: terminal[0]!.totalMs, warmMs: terminal.slice(1).map(item => item.totalMs),
    warmDistributionMs: quantiles(terminal.slice(1).map(item => item.totalMs)),
    commitMs: terminal.map(item => item.commitMs), commitDistributionMs: quantiles(terminal.map(item => item.commitMs)),
    work: terminal.map(item => item.work), published: terminal.map(({ facts, revisions, processed }) => ({ facts, revisions, processed })), ...inventory,
    note: "scripted in-process provider; total/work stop at noting return, before publication assertions; commitMs times Store.commitNotingRun only, including its transaction; no native/model latency or model quality" });
  const appendMemory = TraceMemory(db, async () => { throw new Error("provider unexpectedly called"); });
  const appendStore = appendMemory.store;
  const counter = counters(), times: number[] = [], work: ReturnType<typeof counter.value>[] = [];
  let head = fixture.headTurnId;
  try {
    for (let i = 0; i < repeats; i++) {
      const turn = appendStore.appendTurn({ sessionId: fixture.sessionId, parentTurnId: head, kind: "turn",
        userPrompt: "short appended message", startedAt: "2026-09-26T00:00:00Z" });
      const entry = appendStore.appendSourceEntry({ sessionId: fixture.sessionId, turnId: turn.id, nativeLineage: "perf",
        nativeId: `new-${i}`, role: "user", text: "short appended message", raw: "short appended message", calls: [] });
      const state = appendStore.sourcePathState(fixture.sessionId, fixture.branch)!;
      counter.reset(); const started = performance.now();
      appendStore.appendSourcePath(fixture.sessionId, fixture.branch, state, [entry.id], turn.id, "perf");
      head = turn.id;
      appendMemory.taskEligibility("noting", { ...target, headTurnId: head });
      appendMemory.injection({ ...target, headTurnId: head }, noVisibility());
      times.push(performance.now() - started); work.push(counter.value());
    }
    measurements.push({ name: "normal append + N due + injection", size: length, coldMs: times[0], warmMs: times.slice(1),
      warmDistributionMs: quantiles(times.slice(1)), work, ...inventory,
      note: "Turn/entry creation before timer; path append + due + knowledge delivery inside timer" });
  } finally { counter.restore(); appendMemory.close(); rmSync(db, { force: true }); }
}
// Controlled history comparison: same three native Raw views and pending count on both
// histories. Prior pending Raw is settled through the ordinary synthetic Noting commit.
for (const length of lengths) {
  const db = join(output, `fixed-${length}.db`);
  rmSync(db, { force: true });
  const fixture = generate(db, { entries: 200, facts: 20, resultChars: 256 });
  const seed = new Store(db);
  let head = fixture.headTurnId;
  try {
    const old = seed.pendingEntries(fixture.sessionId, fixture.branch, head);
    if (old.length) {
      const marked = seed.commitNotingRun({ run: { kind: "noting", sessionId: fixture.sessionId, branch: fixture.branch,
        createdAt: "2026-09-26T00:00:00Z" }, facts: [], entryIds: old.map(entry => entry.id) });
      if (!marked.ok) throw Error(marked.problems.join("; "));
    }
    // Both cases share the byte-identical 200-entry seed (same facts and knowledge).
    // Extend only the long case's processed ancestry; it cannot enter N's pending Raw.
    if (length === 2_000) {
      const oldState = seed.sourcePathState(fixture.sessionId, fixture.branch)!;
      const historical: number[] = [];
      seed.transaction(() => {
        for (let i = 0; i < 1_800; i++) {
          const turn = seed.appendTurn({ sessionId: fixture.sessionId, parentTurnId: head,
            kind: "turn", userPrompt: "identical processed history", startedAt: "2026-09-26T00:00:00Z" });
          const entry = seed.appendSourceEntry({ sessionId: fixture.sessionId, turnId: turn.id, nativeLineage: "fixed",
            nativeId: `processed-${i}`, role: "user", text: "identical processed history",
            raw: "identical processed history", calls: [] });
          historical.push(entry.id); head = turn.id;
        }
        seed.appendSourcePath(fixture.sessionId, fixture.branch, oldState, historical, head, "fixed");
        const processed = seed.commitNotingRun({ run: { kind: "noting", sessionId: fixture.sessionId,
          branch: fixture.branch, createdAt: "2026-09-26T00:00:00Z" }, facts: [], entryIds: historical });
        if (!processed.ok) throw Error(processed.problems.join("; "));
      });
    }
    const state = seed.sourcePathState(fixture.sessionId, fixture.branch)!;
    const added: number[] = [];
    for (let i = 0; i < 3; i++) {
      const turn = seed.appendTurn({ sessionId: fixture.sessionId, parentTurnId: head,
        kind: "turn", userPrompt: "identical pending message", startedAt: "2026-09-26T00:00:00Z" });
      const entry = seed.appendSourceEntry({ sessionId: fixture.sessionId, turnId: turn.id, nativeLineage: "fixed",
        nativeId: `fixed-${i}`, role: "user", text: "identical pending message", raw: "identical pending message", calls: [] });
      added.push(entry.id); head = turn.id;
    }
    seed.appendSourcePath(fixture.sessionId, fixture.branch, state, added, head, "fixed");
  } finally { seed.close(); }
  const memory = TraceMemory(db, async () => { throw Error("no provider expected during fixed reads"); });
  const path = { sessionId: fixture.sessionId, branch: fixture.branch, headTurnId: head };
  const size = length;
  const inventory = { entries: fixture.entryCount + (length === 2_000 ? 1_800 : 0) + 3,
    turns: fixture.turnCount + (length === 2_000 ? 1_800 : 0) + 3, pending: 3,
    pendingRaw: "three identical user entries (text and raw: identical pending message)",
    facts: fixture.factCount, knowledge: fixture.knowledgeCount, dbBytes: statSync(db).size, controlledHistory: true };
  try {
    if (memory.pendingEntries(path.sessionId, path.branch, path.headTurnId).length !== 3) throw Error("fixed pending mismatch");
    sample("controlled 3 pending / due", size, () => memory.taskEligibility("noting", path), inventory);
    const supplied = noVisibility();
    for (const item of memory.store.currentKnowledge(path)) supplied.knowledgeCommitIds.add(item.revision.id);
    sample("controlled 3 pending / no-delta injection", size, () => memory.injection(path, supplied), inventory);
    const measured = memory.store;
    const original = { path: measured.sourcePath.bind(measured), pending: measured.pendingEntries.bind(measured),
      snapshot: measured.pathSnapshot.bind(measured), raw: measured.getSourceEntry.bind(measured) };
    let phase = { pathMs: 0, pendingMs: 0, snapshotMs: 0, rawMs: 0,
      pathCalls: 0, pendingCalls: 0, snapshotCalls: 0, rawCalls: 0 };
    const timed = <F extends (...args: never[]) => unknown>(method: F, ms: keyof typeof phase, calls: keyof typeof phase) =>
      ((...args: Parameters<F>) => { const start = performance.now(); const value = method(...args);
        phase[ms] += performance.now() - start; phase[calls]++; return value; }) as F;
    measured.sourcePath = timed(original.path, "pathMs", "pathCalls") as Store["sourcePath"];
    measured.pendingEntries = timed(original.pending, "pendingMs", "pendingCalls") as Store["pendingEntries"];
    measured.pathSnapshot = timed(original.snapshot, "snapshotMs", "snapshotCalls") as Store["pathSnapshot"];
    measured.getSourceEntry = timed(original.raw, "rawMs", "rawCalls") as Store["getSourceEntry"];
    const counter = counters(), times: number[] = [], work: ReturnType<typeof counter.value>[] = [], phases: typeof phase[] = [];
    let material: Record<string, unknown> = {};
    try {
      for (let i = 0; i < repeats; i++) {
        phase = { pathMs: 0, pendingMs: 0, snapshotMs: 0, rawMs: 0,
          pathCalls: 0, pendingCalls: 0, snapshotCalls: 0, rawCalls: 0 };
        counter.reset(); const start = performance.now();
        const frozen = freezeNoting(measured, { ...path, mode: "subagent" }, memory.config, memory.resultText);
        times.push(performance.now() - start); phases.push(phase);
        work.push({ ...counter.value(), directRawReads: phase.rawCalls, pathSnapshots: phase.snapshotCalls });
        if (frozen.entries.length !== 3 || !frozen.prepared) throw Error("fixed N membership mismatch");
        material = { pendingNativeIds: frozen.entries.map(entry => entry.nativeId),
          pendingText: frozen.entries.map(entry => entry.text), selectedEntryIds: frozen.prepared.selectedEntryIds,
          factCount: frozen.prepared.supplied.factIds.length,
          knowledgeCount: frozen.prepared.supplied.knowledgeCommitIds.length,
          factIds: frozen.prepared.supplied.factIds, knowledgeCommitIds: frozen.prepared.supplied.knowledgeCommitIds,
          rawTokens: tokens(frozen.prepared.material.entries.map(entry => entry.view).join("\n")),
          factTokens: tokens(frozen.prepared.material.facts.join("\n")),
          knowledgeTokens: tokens((frozen.prepared.material.knowledge ?? []).map(group => group.text).join("\n")),
          totalMaterialTokens: tokens(frozen.prepared.text) };
      }
    } finally {
      counter.restore(); measured.sourcePath = original.path; measured.pendingEntries = original.pending;
      measured.pathSnapshot = original.snapshot; measured.getSourceEntry = original.raw;
    }
    measurements.push({ name: "controlled 3 pending / admitted N material freeze", size,
      coldMs: times[0], warmMs: times.slice(1), warmDistributionMs: quantiles(times.slice(1)), work, phases,
      material, ...inventory });
  } finally { memory.close(); }
  const terminal: { totalMs: number; commitMs: number; work: ReturnType<ReturnType<typeof counters>["value"]>; facts: number; revisions: number; processed: number }[] = [];
  for (let i = 0; i < repeats; i++) {
    const copy = join(output, `fixed-task-${length}-${i}.db`);
    copyFileSync(db, copy);
    let local: ReturnType<typeof TraceMemory> | undefined, commitMs = NaN;
    const request = { messages: [{ role: "user", content: "synthetic benchmark" }] };
    const agent: RunAgent = async raw => {
      const task = raw as { tools: { name: string; execute: (input: unknown) => string }[]; reportRequest: (request: unknown) => void };
      task.reportRequest(request);
      const note = task.tools.find(tool => tool.name === "note")!.execute({ facts: [{ text: "Synthetic user rule",
        source: [`T${head - 2}#E1`] }] });
      if (!note.includes("held: $1")) throw Error(`note rejected: ${note}`);
      const knowledge = task.tools.find(tool => tool.name === "memory")!.execute({ operations: [{ op: "create", text: "Synthetic rule",
        category: "constraint", scope: "session", supports: ["$1"], topics: [], reason: "benchmark" }], skipped: [] });
      if (!knowledge.includes("held: M1")) throw Error(`knowledge rejected: ${knowledge}`);
      return { outcome: "success", output: "done", request };
    };
    local = TraceMemory(copy, agent);
    const previousFactIds = new Set(local.store.listSessionFacts(path.sessionId).map(fact => fact.id));
    const previousRevisionIds = new Set(local.store.listKnowledgeRevisions().map(revision => revision.id));
    const original = local.store.commitNotingRun.bind(local.store);
    local.store.commitNotingRun = (input => { const start = performance.now(); const result = original(input);
      commitMs = performance.now() - start; return result; }) as typeof local.store.commitNotingRun;
    const count = counters();
    try {
      count.reset(); const start = performance.now(); const result = await local.noting({ ...path, mode: "subagent" });
      const totalMs = performance.now() - start;
      const measuredWork = count.value();
      if (result.outcome !== "success" || local.pendingEntries(path.sessionId, path.branch, path.headTurnId).length)
        throw Error(`fixed N terminal failed: ${JSON.stringify(result)}`);
      const newFacts = local.store.listSessionFacts(path.sessionId).filter(fact => !previousFactIds.has(fact.id));
      const newRevisions = local.store.listKnowledgeRevisions().filter(revision => !previousRevisionIds.has(revision.id));
      const processed = added.filter(id => local!.store.entryNoted(id)).length;
      if (newFacts.length !== 1 || newRevisions.length !== 1 || processed !== 3 ||
          newRevisions[0]!.supports.length !== 1 || newRevisions[0]!.supports[0] !== newFacts[0]!.id)
        throw Error(`fixed N publication mismatch: ${JSON.stringify({ newFacts, newRevisions, processed })}`);
      terminal.push({ totalMs, commitMs, work: measuredWork, facts: newFacts.length, revisions: newRevisions.length, processed });
    } finally { count.restore(); local.close(); rmSync(copy, { force: true }); }
  }
  measurements.push({ name: "controlled 3 pending / real N + atomic terminal", size,
    coldMs: terminal[0]!.totalMs, warmMs: terminal.slice(1).map(value => value.totalMs),
    warmDistributionMs: quantiles(terminal.slice(1).map(value => value.totalMs)),
    commitMs: terminal.map(value => value.commitMs), commitDistributionMs: quantiles(terminal.map(value => value.commitMs)),
    work: terminal.map(value => value.work), published: terminal.map(({ facts, revisions, processed }) => ({ facts, revisions, processed })), ...inventory,
    note: "scripted in-process provider; total/work stop at noting return before publication assertions; commitMs instruments Store.commitNotingRun including its transaction only" });
  rmSync(db, { force: true });
}
const report = { candidate: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  dirty: execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=normal"], { encoding: "utf8" }).trim().length > 0,
  implementationBase: "7701155498f5f13f5e9dad538887c74e981a4f90", node: process.version,
  warmup: "first cold, next five warm on same store; terminal uses six independent identical DB copies; no discarded samples",
  measurements };
writeFileSync(join(output, process.argv.includes("--fixed-only") ? "ticket-92-fixed-results.json" : "ticket-92-results.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
