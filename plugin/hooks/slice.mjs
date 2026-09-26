// The small SessionStart reader. Only an elected cache miss launches the full CC bundle.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Capture before stdin or lock waits. A reader never renews the producer's reuse window.
const startedAt = Date.now(), deadline = startedAt + 55_000;
const remaining = () => {
  const ms = deadline - Date.now();
  if (ms <= 0) throw new Error('SessionStart stage deadline exceeded');
  return ms;
};
const [, , configPath, slotText] = process.argv;
const slot = Number(slotText);
if (!Number.isInteger(slot) || slot < 0 || slot >= 24) throw new Error('SessionStart slice slot must be 0..23');
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw);
if (!['SessionStart', 'UserPromptSubmit'].includes(input.hook_event_name) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(input.session_id))
  throw new Error('slice reader requires a valid native session');
const promptDelta = input.hook_event_name === 'UserPromptSubmit';
const config = JSON.parse(readFileSync(configPath, 'utf8'));
if (!config.stateDir?.startsWith('/')) throw new Error('slice reader needs an absolute stateDir');
const dbPath = config.dbPath ?? join(process.env.HOME, '.trace-memory', 'trace.db');
if (!dbPath.startsWith('/')) throw new Error('slice reader needs an absolute database path');
const pluginRoot = dirname(configPath);
const version = JSON.parse(readFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8')).version;
const state = join(config.stateDir, promptDelta ? 'prompt-delta' : 'session-start', input.session_id);
const stat = path => { try { const s = statSync(path); return [s.dev, s.ino, s.size, s.mtimeMs]; }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const readOptional = path => { try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const transcriptStat = stat(input.transcript_path);
const inputs = JSON.stringify({ version, session: input.session_id, source: input.source,
  transcript: input.transcript_path, transcriptStat: transcriptStat?.slice(2) ?? null,
  ...(promptDelta ? { prompt: input.prompt, event: input.hook_event_name } : {}) });
const keyOf = value => createHash('sha256').update(value).digest('hex');
const key = keyOf(inputs), lock = join(state, `${key}.lock`);
// Identity checks are independent of database freshness. Ownership, enrollment and database
// watermarks in the renderer's snapshot describe its bodies, not admission of later consumers.
const identity = () => {
  const own = readOptional(join(config.stateDir, 'bindings', `${input.session_id}.json`));
  const pid = process.env.CLAUDE_PID;
  const record = pid && /^\d+$/.test(pid) ? readOptional(join(config.stateDir, 'native-sessions', `${pid}.json`)) : null;
  return JSON.stringify({ db: stat(dbPath)?.slice(0, 2) ?? null, transcriptStat: stat(input.transcript_path),
    own: own && { nativeSessionId: own.nativeSessionId, coreSessionId: own.coreSessionId,
      nativeProcess: own.nativeProcess, transcriptPath: own.transcriptPath, dbPath: own.dbPath,
      branch: own.branch, selectedLeafUuid: own.selectedLeafUuid, lastClose: own.lastClose },
    native: record && { pid: record.pid, startedAt: record.startedAt, nativeSessionId: record.nativeSessionId,
      transcriptPath: record.transcriptPath, source: record.source } });
};
mkdirSync(state, { recursive: true });
// Immutable generations, rather than an overwritten reference, also serve eligible old waiters
// after a later invocation has published. Each owns [windowStart, deadline); subsequent windows
// start no earlier than the previous deadline. No Hook can wait longer than its own 55 seconds.
const generations = () => readdirSync(state).filter(file => /^[a-f0-9]{64}\.\d+\.json$/.test(file));
const reusable = () => {
  const file = generations().filter(file => file.startsWith(`${key}.`) && Number(file.split('.')[1]) > startedAt)
    .sort((a, b) => Number(a.split('.')[1]) - Number(b.split('.')[1]))[0];
  if (!file) return null;
  const { digest, ...result } = JSON.parse(readFileSync(join(state, file), 'utf8'));
  if (digest !== keyOf(JSON.stringify(result)) || result.inputs !== inputs ||
    result.deadline !== Number(file.split('.')[1]) || !Number.isFinite(result.windowStart) ||
    result.windowStart >= result.deadline)
    throw new Error('invalid SessionStart stage generation');
  if (startedAt < result.windowStart)
    throw new Error('Hook start precedes the available SessionStart producer window');
  return result;
};
const publish = value => {
  const previousDeadline = Math.max(0, ...generations().filter(file => file.startsWith(`${key}.`))
    .map(file => Number(file.split('.')[1])));
  // For the first producer, only still-live Hooks can precede its start. A later producer may
  // not adopt earlier-window readers even when those readers have not observed publication yet.
  const windowStart = Math.max(previousDeadline, startedAt - 55_000);
  const result = { inputs, windowStart, deadline, ...value };
  const resultPath = join(state, `${key}.${deadline}.json`), temporary = `${resultPath}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ digest: keyOf(JSON.stringify(result)), ...result }), { flag: 'wx', mode: 0o600 });
  renameSync(temporary, resultPath);
};
let staged;
while (!staged) {
  remaining();
  staged = reusable();
  if (staged) break;
  let acquired = false;
  try { mkdirSync(lock); acquired = true; }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (!acquired) {
    await new Promise(resolve => setTimeout(resolve, 20));
    continue;
  }
  try {
    staged = reusable();
    if (staged) break;
    try {
      const invoke = command => {
        const result = spawnSync(process.execPath, [join(pluginRoot, 'dist', 'cc.cjs'), command, '--config', configPath],
          { input: raw, encoding: 'utf8', timeout: remaining(), maxBuffer: 16 * 1024 * 1024 });
        if (result.error || result.status !== 0)
          throw new Error(`SessionStart ${command} failed: ${result.error?.message ?? result.stderr}`);
        return result;
      };
      // Lifecycle is never retried. Clear's frozen material remains owned by its preparation.
      invoke(promptDelta ? 'hook-delta-prepare' : 'hook-prepare');
      const before = identity();
      const { selection, snapshot, slices } = JSON.parse(invoke(promptDelta ? 'hook-delta' : 'hook-slices').stdout);
      if (!promptDelta && !/^[a-f0-9]{64}$/.test(selection) || !Array.isArray(slices) || slices.length !== 24)
        throw new Error('CC renderer returned an invalid selection or slot count');
      if (before !== identity() || JSON.stringify(transcriptStat) !== JSON.stringify(stat(input.transcript_path)))
        throw new Error('native identity or transcript changed during SessionStart rendering');
      remaining();
      // hook-slices captures snapshot and bodies in one read transaction. Never replace its
      // descriptor with current database metadata, or rerender because another writer committed.
      publish({ identity: before, selection, snapshot, producerSlot: slot, slices });
    } catch (error) {
      // Other Hooks in this window see the same failure, not a second lifecycle preparation.
      publish({ error: error.message });
      throw error;
    }
    staged = reusable();
  } finally {
    try {
      // Successes and failures have the same bounded retention. An active Hook has at most
      // 55 seconds, so these old generations cannot belong to a still-eligible reader.
      for (const file of generations()) if (Date.now() - Number(file.split('.')[1]) > 120_000)
        rmSync(join(state, file), { force: true });
    } finally { rmSync(lock, { recursive: true, force: true }); }
  }
}
remaining();
if (staged.inputs !== inputs || startedAt < staged.windowStart || startedAt >= staged.deadline)
  throw new Error('invalid SessionStart stage generation');
if (staged.error) throw new Error(`SessionStart stage producer failed: ${staged.error}`);
if (staged.identity !== identity()) throw new Error('native identity or transcript changed before its staged slice was read');
const slice = staged.slices[slot];
if (slice) process.stdout.write(`${JSON.stringify(promptDelta
  ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: slice.hookSpecificOutput.additionalContext } }
  : slice)}\n`);
