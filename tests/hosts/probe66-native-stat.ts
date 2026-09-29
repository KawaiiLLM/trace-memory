import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { createFencedClaudeExecutable, preflightNetworkFence } from './cc-native-fence.ts';
import { startLoopbackAnthropic } from './cc-native-loopback.ts';

const root = process.env.TM_PROBE_DIR;
if (!root) throw new Error('TM_PROBE_DIR must name this run’s private evidence directory');
mkdirSync(root, { recursive: true });
const run = mkdtempSync(join(root, 'run-'));
const configDir = join(run, 'config'), cwd = join(run, 'cwd'), fenceDir = join(run, 'fence');
for (const dir of [configDir, cwd, fenceDir]) mkdirSync(dir);
const log = join(run, 'starts.jsonl');
const executable = '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe';
const api = await startLoopbackAnthropic(() => ({ blocks: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' }));
const port = Number(new URL(api.url).port);
const { wrapperPath, profilePath } = createFencedClaudeExecutable(fenceDir, executable, [port], run);
await preflightNetworkFence(profilePath, [port], run);
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
  const hook = join(import.meta.dirname, 'probe66-stat-hook.mjs');
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ matcher: 'startup|clear|compact', hooks: Array.from({ length: 24 }, (_, slot) => ({ type: 'command', command: `node "${hook}" "${log}" ${slot}`, timeout: 60 })) }] } }));
  const input = new Turns(); input.push('hello');
  const turns = ['/clear', 'hello after', ...Array(6).fill('please retain this context. '.repeat(160)), '/compact', 'hello after compact'];
  let session = '', compact = false, clear = false;
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
    if (m.type === 'result') { if (turns.length) input.push(turns.shift()!, session); else input.close(); }
  }
  const events = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  writeFileSync(join(run, 'report.json'), JSON.stringify({ events, clear, compact }, null, 2));
  const bySource: Record<string, unknown[]> = {};
  for (const event of events) (bySource[event.source] ??= []).push(event);
  console.log(JSON.stringify({ run, clear, compact, bySource }));
} finally { await api.close(); }
