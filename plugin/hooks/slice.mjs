// The small SessionStart reader. Only an elected cache miss launches the full CC bundle.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const [, , configPath, slotText] = process.argv;
const slot = Number(slotText);
if (!Number.isInteger(slot) || slot < 0 || slot >= 24) throw new Error('SessionStart slice slot must be 0..23');
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw);
if (input.hook_event_name !== 'SessionStart' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(input.session_id))
  throw new Error('slice reader requires a valid SessionStart native session');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
if (!config.stateDir?.startsWith('/')) throw new Error('slice reader needs an absolute stateDir');
const dbPath = config.dbPath ?? join(process.env.HOME, '.trace-memory', 'trace.db');
if (!dbPath.startsWith('/')) throw new Error('slice reader needs an absolute database path');
const pluginRoot = dirname(configPath);
const version = JSON.parse(readFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8')).version;
const state = join(config.stateDir, 'session-start', input.session_id);
const stat = path => { try { const s = statSync(path); return [s.dev, s.ino, s.size, s.mtimeMs]; }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const binding = name => { try { return JSON.parse(readFileSync(join(config.stateDir, 'bindings', `${name}.json`), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const relevant = value => value && ({ coreSessionId: value.coreSessionId, projectId: value.projectId,
  enrollment: value.enrollment, branch: value.branch, selectedLeafUuid: value.selectedLeafUuid,
  nativeProcess: value.nativeProcess, lastClose: value.lastClose,
  clearedFrom: value.clearedFrom && { nativeSessionId: value.clearedFrom.nativeSessionId,
    compactionTurnId: value.clearedFrom.compactionTurnId, at: value.clearedFrom.at,
    inheritedLength: value.clearedFrom.inheritedEntryIds.length,
    inheritedTail: value.clearedFrom.inheritedEntryIds.at(-1) ?? null },
  transcriptPath: value.transcriptPath, dbPath: value.dbPath, cwd: value.cwd });
const nativeSession = () => { const pid = process.env.CLAUDE_PID; if (!pid || !/^\d+$/.test(pid)) return null;
  try { return JSON.parse(readFileSync(join(config.stateDir, 'native-sessions', `${pid}.json`), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
let db = existsSync(dbPath) ? new DatabaseSync(dbPath, { readOnly: true }) : null;
try {
  const metadata = () => {
    if (!db && existsSync(dbPath)) db = new DatabaseSync(dbPath, { readOnly: true });
    const own = relevant(binding(input.session_id));
    const record = nativeSession();
    const native = record && { pid: record.pid, startedAt: record.startedAt, nativeSessionId: record.nativeSessionId,
      transcriptPath: record.transcriptPath, source: record.source };
    const parent = input.source === 'clear' && native?.nativeSessionId ? relevant(binding(native.nativeSessionId)) : null;
    const dbStat = stat(dbPath);
    const watermarks = db ? db.prepare(`SELECT
      (SELECT IFNULL(MAX(id),0) FROM facts) f,
      (SELECT IFNULL(MAX(rowid),0) FROM consolidated_facts) cf,
      (SELECT IFNULL(MAX(rowid),0) FROM noted_entries) ne,
      (SELECT IFNULL(MAX(id),0) FROM knowledge_revisions) kr,
      (SELECT IFNULL(MAX(rowid),0) FROM knowledge_processed) kp,
      (SELECT group_concat(project_id, ',') FROM (SELECT project_id FROM sessions ORDER BY id)) pa,
      (SELECT COUNT(*) FROM projects WHERE merged_into IS NOT NULL) pm,
      (SELECT global_tokens || ':' || project_tokens || ':' || session_tokens FROM knowledge_budget_policy WHERE id=1) bp,
      (SELECT IFNULL(MAX(version),0) FROM session_lineage_cursors) cv,
      (SELECT IFNULL(MAX(version),0) FROM source_paths) sv`).get() : null;
    const ownerOf = value => db && value?.coreSessionId ? db.prepare(`SELECT project_id, enrollment_default, enrollment_choice
      FROM sessions WHERE id=?`).get(value.coreSessionId) : null;
    const owner = ownerOf(own), parentOwner = ownerOf(parent);
    const header = db && own?.coreSessionId && own.branch ? db.prepare(`SELECT length, tail_entry_id, version, hwm_entry_id
      FROM source_paths WHERE session_id=? AND branch=?`).get(own.coreSessionId, own.branch) : null;
    const cursor = db && own?.coreSessionId ? db.prepare(`SELECT branch, head_turn_id, version FROM session_lineage_cursors
      WHERE session_id=? AND lineage=?`).get(own.coreSessionId, input.session_id) : null;
    return JSON.stringify({ version, config, dbStat, watermarks, header, cursor, owner, own, native, parent,
      parentOwner, parentTranscriptStat: parent?.transcriptPath ? stat(parent.transcriptPath) : null,
      dataVersion: db?.prepare('PRAGMA data_version').get(),
      session: input.session_id, source: input.source, transcript: input.transcript_path,
      transcriptStat: stat(input.transcript_path) });
  };
  const keyOf = value => createHash('sha256').update(value).digest('hex');
  const initial = metadata(), key = keyOf(initial);
  mkdirSync(state, { recursive: true });
  const reference = join(state, `${key}.ref`), lock = `${reference}.lock`;
  let acquired = false;
  try { mkdirSync(lock); acquired = true; }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (acquired) {
    try {
      let finalKey = key;
      if (!existsSync(join(state, `${key}.json`))) {
      // This command performs the existing lifecycle once. A bound clear reuses its frozen carrier
      // under the existing child binding mutex if another input key won earlier.
      const result = spawnSync(process.execPath, [join(pluginRoot, 'dist', 'cc.cjs'), 'hook-slices', '--config', configPath],
        { input: raw, encoding: 'utf8', timeout: 55_000, maxBuffer: 16 * 1024 * 1024 });
      if (result.error || result.status !== 0) throw new Error(`SessionStart render failed: ${result.error?.message ?? result.stderr}`);
      const slices = JSON.parse(result.stdout);
      if (!Array.isArray(slices) || slices.length !== 24) throw new Error('SessionStart renderer did not return 24 slots');
      const final = metadata();
      // The native transcript must not move while hook commands run. Store changes caused by the
      // producer's own lifecycle are recorded in final, never mislabelled as initial state.
      if (JSON.parse(initial).transcriptStat?.join(':') !== JSON.parse(final).transcriptStat?.join(':'))
        throw new Error('native transcript changed during SessionStart rendering');
      finalKey = keyOf(final);
      const resultPath = join(state, `${finalKey}.json`);
      const serialized = JSON.stringify({ final: finalKey, producerSlot: slot, slices });
      if (existsSync(resultPath)) {
        const previous = JSON.parse(readFileSync(resultPath, 'utf8'));
        if (JSON.stringify(previous.slices) !== JSON.stringify(slices))
          throw new Error('same SessionStart input produced different rendered slices');
      } else {
        const temporary = `${resultPath}.${process.pid}.tmp`;
        writeFileSync(temporary, serialized, { flag: 'wx', mode: 0o600 });
        renameSync(temporary, resultPath);
      }
      }
      const temporaryRef = `${reference}.${process.pid}.tmp`;
      writeFileSync(temporaryRef, finalKey, { flag: 'wx', mode: 0o600 });
      renameSync(temporaryRef, reference);
      // Keep a few recent results, but never delete a file an active reader might still need.
      const files = readdirSync(state).filter(file => /^[a-f0-9]{64}\.json$/.test(file))
        .map(file => ({ file, mtime: statSync(join(state, file)).mtimeMs })).sort((a, b) => b.mtime - a.mtime);
      for (const old of files.slice(3)) if (Date.now() - old.mtime > 120_000) {
        const oldKey = old.file.slice(0, -5);
        const refs = readdirSync(state).filter(file => /^[a-f0-9]{64}\.ref$/.test(file) &&
          readFileSync(join(state, file), 'utf8') === oldKey);
        if (refs.some(file => existsSync(join(state, `${file}.lock`)))) continue;
        for (const file of refs) rmSync(join(state, file));
        rmSync(join(state, old.file));
      }
    } finally { rmSync(lock, { recursive: true, force: true }); }
  } else {
    const deadline = Date.now() + 55_000;
    while (!existsSync(reference)) {
      if (!existsSync(lock)) throw new Error('SessionStart stage producer failed before publication');
      if (Date.now() >= deadline) throw new Error('timed out waiting for SessionStart stage');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  const finalKey = readFileSync(reference, 'utf8');
  if (!/^[a-f0-9]{64}$/.test(finalKey)) throw new Error('invalid SessionStart stage reference');
  const staged = JSON.parse(readFileSync(join(state, `${finalKey}.json`), 'utf8'));
  if (staged.final !== finalKey || finalKey !== keyOf(metadata()))
    throw new Error('SessionStart input changed before its staged slice was read');
  const slice = staged.slices[slot];
  if (slice) process.stdout.write(`${JSON.stringify(slice)}\n`);
} finally { db?.close(); }
