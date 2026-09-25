import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { Store } from "../../src/core/store/index.ts";
import { resolveCcHostConfig } from "../../src/hosts/cc/config.ts";
import { recordSessionStart } from "../../src/hosts/cc/binding.ts";
import { CcImporter } from "../../src/hosts/cc/importer.ts";

// Run through /tmp/tm-with-suite-lock.sh. All databases and pressure files are disposable.
const [kind, label, ...flags] = process.argv.slice(2);
if (!["cc", "pi"].includes(kind) || !label || flags.some(flag => !/^--(sync=(FULL|NORMAL|OFF)|checkpoint=(0|1000)|fs|fs-seconds=\d+)$/.test(flag)))
  throw new Error("usage: ticket-84-commit.mjs cc|pi label [--sync=FULL|NORMAL|OFF] [--checkpoint=0|1000] [--fs --fs-seconds=4]");
const sync = flags.find(flag => flag.startsWith("--sync="))?.split("=")[1];
const checkpoint = flags.find(flag => flag.startsWith("--checkpoint="))?.split("=")[1];
const fsLoad = flags.includes("--fs");
const fsSeconds = Number(flags.find(flag => flag.startsWith("--fs-seconds="))?.split("=")[1] ?? 0);
const dir = mkdtempSync(resolve("evidence/tm84-"));
const dbPath = join(dir, "trace.db");
const at = "2026-01-01T00:00:00.000Z";
const commits = [], cpu = [], wal = [];
let store, importer, writer, stress;
process.on("exit", () => { writer?.kill(); stress?.kill(); });
function percentile(values, fraction) { const ordered = [...values].sort((a, b) => a - b); return ordered[Math.ceil(ordered.length * fraction) - 1]; }
function summary(values) { return { n: values.length, median: percentile(values, .5), p90: percentile(values, .9), max: Math.max(...values) }; }
// Passive WAL-file-size sampling around each COMMIT (no PRAGMA wal_checkpoint call, which would
// force one): SQLite only ever grows the `-wal` file between checkpoints, so any decrease between
// the sample taken just before a COMMIT and the one taken just after it is a checkpoint resetting or
// truncating that file during that COMMIT — the signal the report attributes >100ms COMMITs against.
function walSize(path) { try { return statSync(path).size; } catch { return 0; } }
function instrument(db, walPath) {
  const original = db.exec.bind(db);
  db.exec = sql => {
    if (sql !== "COMMIT") return original(sql);
    const start = performance.now(), cpuStart = process.cpuUsage(), before = walSize(walPath);
    try { return original(sql); }
    finally {
      commits.push(performance.now() - start); cpu.push(process.cpuUsage(cpuStart));
      const after = walSize(walPath);
      wal.push({ before, after, checkpointed: after < before });
    }
  };
}
function worker(command, args) {
  const child = spawn(command, args, { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  const ready = new Promise((resolveReady, reject) => {
    child.once("message", message => message?.type === "ready" ? resolveReady() : reject(new Error("worker did not become ready")));
    child.once("error", reject);
    child.once("exit", code => reject(new Error(`worker exited before ready: ${code}`)));
  });
  return { child, ready };
}
async function startLoad(sessionId) {
  const active = worker(process.execPath, [resolve("tests/hosts/cc-67-writer.mjs"), dbPath, String(sessionId)]);
  writer = active.child;
  await active.ready;
  if (fsLoad) {
    const pressure = worker(process.execPath, [resolve("tests/perf/ticket-84-fs.mjs"), join(dir, "pressure"), String(fsSeconds)]);
    stress = pressure.child;
    await pressure.ready;
  }
}
async function stop(child) {
  if (!child) return;
  if (child.exitCode !== null) throw new Error(`load worker exited early: ${child.exitCode}`);
  const done = new Promise((resolveDone, reject) => {
    child.on("message", message => { if (message?.type === "done") resolveDone(message); });
    child.once("error", reject);
    child.once("exit", code => { if (code !== 0) reject(new Error(`worker exited: ${code}`)); });
  });
  child.send("stop");
  return await done;
}
try {
  let sessionId, result;
  if (kind === "cc") {
    const transcriptPath = join(dir, "native.jsonl");
    const rows = Array.from({ length: 15_000 }, (_, i) => [
      { uuid: `u${i}`, parentUuid: i ? `a${i - 1}` : null, type: "user", timestamp: at,
        promptId: `p${i}`, promptSource: "sdk", message: { role: "user", content: `question ${i}` } },
      { uuid: `a${i}`, parentUuid: `u${i}`, type: "assistant", timestamp: at,
        message: { role: "assistant", content: [{ type: "text", text: `answer ${i}` }] } },
    ]).flat();
    writeFileSync(transcriptPath, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    const config = resolveCcHostConfig({ dbPath, stateDir: join(dir, "s"), baseline: "2025-01-01T00:00:00Z" });
    const binding = await recordSessionStart(config, { hook_event_name: "SessionStart", session_id: "performance", transcript_path: transcriptPath }, at);
    importer = new CcImporter(config, binding);
    store = importer.memory.store;
    sessionId = binding.coreSessionId;
  } else {
    store = new Store(dbPath);
    const project = store.createProject({ name: "pi84", declaredBy: "mark" });
    const session = store.createSession({ host: "pi", projectId: project.id, enrollmentChoice: true, startedAt: at, firstReplyAt: at });
    sessionId = session.id;
  }
  if (sync) store.db.exec(`PRAGMA synchronous=${sync}`);
  if (checkpoint) store.db.exec(`PRAGMA wal_autocheckpoint=${checkpoint}`);
  const actual = { journal: store.db.prepare("PRAGMA journal_mode").get().journal_mode,
    synchronous: store.db.prepare("PRAGMA synchronous").get().synchronous,
    autocheckpoint: store.db.prepare("PRAGMA wal_autocheckpoint").get().wal_autocheckpoint };
  instrument(store.db, `${dbPath}-wal`);
  await startLoad(sessionId);
  const began = performance.now();
  if (kind === "cc") {
    result = await importer.reconcile();
    if (result.state !== "ready" || result.appendedEntryIds.length !== 30_000) throw new Error(`CC import incomplete: ${JSON.stringify(result)}`);
  } else {
    const turn = store.appendTurn({ sessionId, kind: "turn", userPrompt: "start", startedAt: at });
    for (let i = 0; i < 3_000; i++) store.appendSourceEntry({ sessionId, turnId: turn.id,
      nativeLineage: "pi", nativeId: String(i), role: "user", text: `entry ${i}`, raw: `entry ${i}`, calls: [] });
  }
  const elapsedMs = performance.now() - began;
  if (commits.length !== (kind === "cc" ? 30_002 : 3_001)) throw new Error(`unexpected COMMIT count: ${commits.length}`);
  const writerResult = await stop(writer), stressResult = await stop(stress);
  const measured = kind === "pi" ? commits.slice(1) : commits; // Exclude the Pi Turn setup COMMIT.
  const measuredWal = kind === "pi" ? wal.slice(1) : wal;
  const worst = commits.indexOf(Math.max(...measured));
  // Every measured COMMIT over 100ms, with whether a checkpoint ran inside it (WAL-size decrease).
  const slowCommits = measured.map((ms, i) => ({ ms, ...measuredWal[i] })).filter(c => c.ms > 100);
  result = { kind, label, flags, actual, elapsedMs, commits: summary(measured), worstCpuMs: (cpu[worst].user + cpu[worst].system) / 1000,
    slowCommits, writerResult, stressResult };
  writeFileSync(resolve(`evidence/${label}.json`), JSON.stringify({ ...result, samplesMs: commits, walSamples: wal }) + "\n");
  console.log(JSON.stringify(result));
  if (writerResult?.error || stressResult?.error) throw new Error("load worker failed");
} finally {
  if (writer?.connected) writer.kill();
  if (stress?.connected) stress.kill();
  if (importer) importer.close(); else store?.close();
  rmSync(dir, { recursive: true, force: true });
}
