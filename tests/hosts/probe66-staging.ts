// Offline 24-slot integration: the task-local plugin bundle, never an installed plugin or provider.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { TraceMemory } from '../../src/core/api/index.ts';
import { DatabaseSync } from 'node:sqlite';
const root = '/private/tmp/tm-66-implementation.lyQREJ/stage-probe';
mkdirSync(root, { recursive: true });
const dir = mkdtempSync(join(root, 'run-'));
const plugin = join(dir, 'plugin'), stateDir = join(dir, 'state');
mkdirSync(join(plugin, '.claude-plugin'), { recursive: true }); mkdirSync(stateDir);
const worktree = '/private/tmp/tm-66-implementation.lyQREJ/worktree/plugin';
cpSync(join(worktree, '.claude-plugin/plugin.json'), join(plugin, '.claude-plugin/plugin.json'));
symlinkSync(join(worktree, 'dist'), join(plugin, 'dist'));
const config = join(plugin, 'cc.config.json');
writeFileSync(config, JSON.stringify({ dbPath: join(dir, 'db.sqlite'), stateDir, baseline: '2025-01-01T00:00:00.000Z' }));
const memory = TraceMemory(join(dir, 'db.sqlite'), async () => { throw new Error('offline staging probe'); });
const project = memory.store.createProject({ name: 'seed', declaredBy: 'mark' });
const alternate = memory.store.createProject({ name: 'alternative', declaredBy: 'mark' });
const session = memory.store.createSession({ enrollmentChoice: true, host: 'fixture', projectId: project.id,
  startedAt: '2026-01-01T00:00:00.000Z', firstReplyAt: '2026-01-01T00:00:00.000Z' });
const turn = memory.store.appendTurn({ sessionId: session.id, kind: 'turn', startedAt: '2026-01-01T00:00:00.000Z', userPrompt: 'global rule' });
const noted = memory.store.commitNotingRun({ run: { kind: 'noting', sessionId: session.id, createdAt: '2026-01-01T00:00:00.000Z' },
  facts: [{ turnId: turn.id, category: 'decision', actor: 'user', text: 'global rule',
    source: [`T${turn.id}#user`], createdAt: '2026-01-01T00:00:00.000Z' }] });
if (!noted.ok) throw new Error(noted.problems.join('; '));
const committed = memory.store.commitConsolidationRun({ run: { kind: 'consolidation', sessionId: session.id,
  createdAt: '2026-01-01T00:00:00.000Z' }, operations: [{ op: 'create', topics: [], reason: 'fixture', handle: '$global',
  author: 'fixture', text: 'one injected global fact', supports: [noted.facts[0]!.id], createdAt: '2026-01-01T00:00:00.000Z',
  category: 'constraint', scope: 'global' }] });
if (!committed.ok) throw new Error(committed.problems.join('; '));
memory.store.close();
const transcript = join(dir, 'native.jsonl');
writeFileSync(transcript, JSON.stringify({ uuid: 'first-user', parentUuid: null, type: 'user',
  timestamp: '2026-01-02T00:00:00.000Z', promptSource: 'typed', message: { role: 'user', content: 'hello' } }) + '\n');
const input = JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup',
  session_id: 'stage-probe', transcript_path: transcript });
const stage = join(worktree, 'hooks/slice.mjs');
const run = (index: number, text = input, interleave: false | 'commit' | 'aba' | 'enrollment' | 'project' = false) => new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
  const child = spawn(process.execPath, [
    ...(interleave ? ['--import', join(worktree, '../tests/hosts/probe66-interleave.mjs')] : []),
    stage, config, String(index)], { stdio: ['pipe', 'pipe', 'pipe'],
    env: interleave ? { ...process.env, TRACE_66_INTERLEAVE_RECEIPT: join(dir, `interleaved-${interleave}.txt`),
      TRACE_66_INTERLEAVE_REVERT: interleave === 'aba' ? '1' : '0',
      TRACE_66_INTERLEAVE_MODE: interleave === 'enrollment' || interleave === 'project' ? interleave : 'budget',
      TRACE_66_ALT_PROJECT: String(alternate.id) } : process.env });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('error', reject);
  child.on('close', code => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`slot ${index} exit ${code}: ${stderr}`)));
  child.stdin.end(text);
});
const calls = await Promise.allSettled(Array.from({ length: 24 }, (_, index) => run(index)));
const results = calls.map((result, index) => result.status === 'rejected'
  ? { index, status: 'rejected' as const, error: String(result.reason) }
  : { index, status: 'fulfilled' as const, stdout: result.value.stdout, stderr: result.value.stderr });
const stagedDir = join(stateDir, 'session-start', 'stage-probe');
const stagedFiles = () => readdirSync(stagedDir).filter(file => file.endsWith('.json'));
const render = () => spawnSync(process.execPath, [join(plugin, 'dist/cc.cjs'), 'hook-slices', '--config', config],
  { input, encoding: 'utf8' });
const independentA = render(), independentB = render();
if (independentA.status !== 0 || independentB.status !== 0 || independentA.stdout !== independentB.stdout)
  throw new Error(`same-input independent pure render changed: ${independentA.stderr} ${independentB.stderr}`);
const first = stagedFiles().map(file => [file, statSync(join(stagedDir, file)).mtimeMs]);
const repeated = await Promise.allSettled(Array.from({ length: 24 }, (_, index) => run(index)));
const repeatedResults = repeated.map((result, index) => result.status === 'rejected'
  ? { index, status: 'rejected' as const, error: String(result.reason) }
  : { index, status: 'fulfilled' as const, stdout: result.value.stdout, stderr: result.value.stderr });
writeFileSync(join(dir, 'results.json'), JSON.stringify({ first: results, repeated: repeatedResults }, null, 2));
if (JSON.stringify(results.map(value => value.status === 'fulfilled' ? value.stdout : value.error)) !==
    JSON.stringify(repeatedResults.map(value => value.status === 'fulfilled' ? value.stdout : value.error)))
  throw new Error('same input changed output between independent 24-hook dispatches');
if (JSON.stringify(first) !== JSON.stringify(stagedFiles().map(file => [file, statSync(join(stagedDir, file)).mtimeMs])))
  throw new Error('same input repeated rendering instead of reusing staged selection');
const changedInput = JSON.stringify({ ...JSON.parse(input), session_id: 'stage-interleaved' });
const race = await run(0, changedInput, 'commit');
if (!existsSync(join(dir, 'interleaved-commit.txt')) || !race.stdout)
  throw new Error(`external database commit during SessionStart was not retried: ${race.stderr}`);
const after = new DatabaseSync(join(dir, 'db.sqlite'), { readOnly: true });
const expectedBudget = after.prepare("SELECT global_tokens || ':' || project_tokens || ':' || session_tokens bp FROM knowledge_budget_policy WHERE id=1").get()!.bp;
try {
  const raceDir = join(stateDir, 'session-start', 'stage-interleaved');
  const stageFile = readdirSync(raceDir).find(file => file.endsWith('.json'))!;
  const result = JSON.parse(readFileSync(join(raceDir, stageFile), 'utf8'));
  if (JSON.parse(result.inputs).watermarks.bp !== expectedBudget || !result.snapshot ||
      result.snapshot.watermarks.bp !== expectedBudget)
    throw new Error('race result did not bind the selected snapshot to the new budget');
} finally { after.close(); }
const abaInput = JSON.stringify({ ...JSON.parse(input), session_id: 'stage-aba' });
const aba = await run(0, abaInput, 'aba');
if (!existsSync(join(dir, 'interleaved-aba.txt')) || !aba.stdout)
  throw new Error(`reversible budget commit was not handled: ${aba.stderr}`);
const abaDir = join(stateDir, 'session-start', 'stage-aba');
const abaStage = JSON.parse(readFileSync(join(abaDir, readdirSync(abaDir).find(file => file.endsWith('.json'))!), 'utf8'));
if (JSON.parse(abaStage.inputs).watermarks.bp !== expectedBudget || abaStage.snapshot.watermarks.bp !== expectedBudget)
  throw new Error('ABA budget write paired a changed snapshot with the restored input');
for (const mode of ['enrollment', 'project'] as const) {
  const own = `stage-${mode}`;
  const result = await run(0, JSON.stringify({ ...JSON.parse(input), session_id: own }), mode);
  if (!result.stdout || !existsSync(join(dir, `interleaved-${mode}.txt`)))
    throw new Error(`${mode} ABA wrote stale output: ${result.stderr}`);
  const path = join(stateDir, 'session-start', own);
  const staged = JSON.parse(readFileSync(join(path, readdirSync(path).find(file => file.endsWith('.json'))!), 'utf8'));
  const current = JSON.parse(readFileSync(join(stateDir, 'bindings', `${own}.json`), 'utf8'));
  if (staged.snapshot.own.projectId !== current.projectId || staged.snapshot.own.enrollment.choice !== null ||
      JSON.parse(staged.inputs).own.projectId !== current.projectId || JSON.parse(staged.inputs).own.enrollment.choice !== null)
    throw new Error(`${mode} ABA stage was paired with mismatched enrollment/project`);
}
console.log(JSON.stringify({ dir, failed: results.filter(result => result.status === 'rejected').length,
  repeatedFailed: repeatedResults.filter(result => result.status === 'rejected').length,
  emitted: results.filter(result => result.status === 'fulfilled' && result.stdout).length,
  staged: existsSync(stagedDir), reused: true, independentRenderEqual: true,
  externalCommitCaptured: true, budgetABADetected: true, enrollmentABADetected: true, projectABADetected: true }));
