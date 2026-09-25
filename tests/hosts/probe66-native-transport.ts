import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { spawnSync } from 'node:child_process';
import { createFencedClaudeExecutable, preflightNetworkFence } from './cc-native-fence.ts';
import { startLoopbackAnthropic } from './cc-native-loopback.ts';
import { TraceMemory } from '../../src/core/api/index.ts';
import { resolveCcHostConfig } from '../../src/hosts/cc/config.ts';
import { bindingPath } from '../../src/hosts/cc/binding.ts';
import { operateCcSession } from '../../src/hosts/cc/operator.ts';
import { CcImporter } from '../../src/hosts/cc/importer.ts';
import { readBinding } from '../../src/hosts/cc/binding.ts';

const root = '/private/tmp/tm-66-implementation.lyQREJ/native-transport';
mkdirSync(root, { recursive: true });
const run = mkdtempSync(join(root, 'run-'));
const configDir = join(run, 'config'), cwd = join(run, 'cwd'), fenceDir = join(run, 'fence');
for (const dir of [configDir, cwd, fenceDir]) mkdirSync(dir);
const plugin = join(run, 'plugin'), stateDir = join(run, 'state');
mkdirSync(join(plugin, '.claude-plugin'), { recursive: true }); mkdirSync(join(plugin, 'hooks')); mkdirSync(stateDir);
const worktree = '/private/tmp/tm-66-implementation.lyQREJ/worktree/plugin';
cpSync(join(worktree, '.claude-plugin/plugin.json'), join(plugin, '.claude-plugin/plugin.json'));
cpSync(join(worktree, 'hooks/slice.mjs'), join(plugin, 'hooks/slice.mjs'));
symlinkSync(join(worktree, 'dist'), join(plugin, 'dist'));
const config = join(plugin, 'cc.config.json');
const dbPath = join(run, 'db.sqlite');
writeFileSync(config, JSON.stringify({ dbPath, stateDir, baseline: '2025-01-01T00:00:00.000Z' }));
const memory = TraceMemory(dbPath, async () => { throw new Error('offline native probe'); });
const project = memory.store.createProject({ name: 'seed', declaredBy: 'mark' });
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
const executable = '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe';
const { wrapperPath, profilePath } = createFencedClaudeExecutable(fenceDir, executable);
// Verify the network fence BEFORE any Claude subprocess starts.
await preflightNetworkFence(profilePath);
const api = await startLoopbackAnthropic(() => ({ blocks: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' }));
class Turns implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = [];
  private waiters: ((value: IteratorResult<SDKUserMessage>) => void)[] = [];
  private closed = false;
  push(text: string, session_id = '') {
    const value = { type: 'user', session_id, message: { role: 'user', content: [{ type: 'text', text }] }, parent_tool_use_id: null } as unknown as SDKUserMessage;
    const next = this.waiters.shift(); if (next) next({ value, done: false }); else this.queue.push(value);
  }
  close() { this.closed = true; for (const next of this.waiters.splice(0)) next({ value: undefined as never, done: true }); }
  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> { return { next: () => {
    const value = this.queue.shift(); if (value) return Promise.resolve({ value, done: false });
    if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
    return new Promise(resolve => this.waiters.push(resolve));
  } }; }
}
try {
  const hook = join(plugin, 'hooks/slice.mjs');
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ matcher: 'startup|clear|compact', hooks: Array.from({ length: 24 }, (_, slot) => ({ type: 'command', command: `node "${hook}" "${config}" ${slot}`, timeout: 60 })) }] } }));
  const input = new Turns(); input.push('hello');
  const turns = [...Array(6).fill('please retain this context. '.repeat(160)), '/compact', '/clear', 'hello after clear'];
  let session = '', compact = false, clear = false, enabled = false, seededFact = 0;
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, CLAUDE_CONFIG_DIR: configDir,
    ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: 'sk-ant-fake-stat-key', CLAUDE_CODE_MAX_RETRIES: '0',
    DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };
  const execution = query({ prompt: input, options: { model: 'sonnet', cwd, pathToClaudeCodeExecutable: wrapperPath,
    env, tools: [], allowedTools: [], settingSources: ['user'], plugins: [], permissionMode: 'dontAsk', strictMcpConfig: true } });
  for await (const message of execution) {
    const m = message as { type: string; subtype?: string; session_id?: string };
    if (m.session_id) session = m.session_id;
    if (m.type === 'system' && m.subtype === 'compact_boundary') compact = true;
    if (m.type === 'system' && m.subtype === 'conversation_reset') clear = true;
    if (m.type === 'result') {
      if (!enabled) { await operateCcSession(resolveCcHostConfig({ dbPath, stateDir,
        baseline: '2025-01-01T00:00:00.000Z' }), session, 'on'); enabled = true; }
      if (turns[0] === '/clear' && !seededFact) {
        const parent = readBinding(resolveCcHostConfig({ dbPath, stateDir, baseline: '2025-01-01T00:00:00.000Z' }), session);
        if (!parent) throw new Error('native parent binding missing before clear');
        const importer = new CcImporter(resolveCcHostConfig({ dbPath, stateDir, baseline: '2025-01-01T00:00:00.000Z' }), parent);
        try {
          const projected = await importer.reconcile();
          if (projected.state !== 'ready' || !projected.coreSessionId || !projected.headTurnId) throw new Error('native parent has no ready path');
          const entries = importer.memory.store.listSourceEntries(projected.coreSessionId);
          const source = entries.find(entry => entry.turnId && entry.id);
          if (!source) throw new Error('native parent has no source entry');
          const fact = importer.memory.store.commitNotingRun({ run: { kind: 'manual', sessionId: projected.coreSessionId,
            branch: projected.branch, createdAt: new Date().toISOString() }, facts: [{ turnId: source.turnId,
            actor: 'user', category: 'decision', text: 'native retained fact: keep the fixture choice', source: [],
            createdAt: new Date().toISOString() }, { turnId: source.turnId, actor: 'user', category: 'decision',
            text: 'legacy oversized pending fact ' + 'x'.repeat(12_000), source: [], createdAt: new Date().toISOString() }] });
          if (!fact.ok) throw new Error(fact.problems.join('; '));
          seededFact = fact.facts[0]!.id;
        } finally { importer.close(); }
      }
      if (turns.length) input.push(turns.shift()!, session); else input.close();
    }
  }
  // Native --session-id makes the startup identity known ahead of the Hook, so this fixture
  // supplies an explicit on choice without changing the unknown-age default used above.
  const enrolledId = '66000000-0000-4000-8000-000000000066';
  const enrolledPath = join(configDir, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'), `${enrolledId}.jsonl`);
  mkdirSync(join(stateDir, 'bindings'), { recursive: true });
  writeFileSync(bindingPath(resolveCcHostConfig({ dbPath, stateDir,
    baseline: '2025-01-01T00:00:00.000Z' }), enrolledId), JSON.stringify({
    version: 1, nativeSessionId: enrolledId, transcriptPath: enrolledPath, dbPath,
    nativeCreatedAt: null, enrollment: { defaultEnabled: false, choice: true },
    coreSessionId: null, projectId: project.id, branch: 'main', selectedLeafUuid: null,
    executor: null, lastClose: null,
  }));
  const enrolled = query({ prompt: 'hello enrolled', options: { model: 'sonnet', cwd,
    extraArgs: { 'session-id': enrolledId }, pathToClaudeCodeExecutable: wrapperPath, env,
    tools: [], allowedTools: [], settingSources: ['user'], plugins: [], permissionMode: 'dontAsk', strictMcpConfig: true } });
  for await (const _ of enrolled) { /* one local fake-provider turn */ }
  const projectDir = join(configDir, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
  const transcriptPaths = (await import('node:fs')).readdirSync(projectDir).filter(file => file.endsWith('.jsonl'));
  const dispatches = transcriptPaths.flatMap(file => readFileSync(join(projectDir, file), 'utf8').trim().split('\n')
    .map(line => JSON.parse(line)).filter(row => row.attachment?.type === 'hook_additional_context')
    .map(row => ({ source: row.attachment.hookName, content: row.attachment.content.map((item: string) => ({
      length: item.length, persisted: item.includes('<persisted-output>'), marker: item.includes('TRACE-MEMORY-CC/1') })) })));
  writeFileSync(join(run, 'report.json'), JSON.stringify({ dispatches, clear, compact, seededFact }, null, 2));
  const review = spawnSync(process.execPath, [join(worktree, '../tests/hosts/probe66-review-transport.ts'), run],
    { encoding: 'utf8', timeout: 20_000 });
  if (review.status !== 0 || review.error) throw new Error(`native Hook audit failed: ${review.error?.message ?? review.stderr}`);
  console.log(JSON.stringify({ run, clear, compact, dispatches, audited: JSON.parse(review.stdout) }));
} finally { await api.close(); }
