// Native PreToolUse hands a fresh /tm rendering to Claude Code's own Read.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const event = JSON.parse(input);
if (event.tool_name !== 'Read') process.exit(0);
const value = event.tool_input?.file_path;
if (typeof value !== 'string' || !value.startsWith('/')) process.exit(0);
const parts = [];
for (const part of value.split('/')) {
  if (!part || part === '.') continue;
  if (part === '..') parts.pop(); else parts.push(part);
}
if (parts[0] !== 'tm') process.exit(0);
const path = `/${parts.join('/')}`;
// Whole node views and exact Raw entries are answered by the main-session function hook.
if (/^\/tm\/(?:(?:knowledge|compact)\/S[1-9]\d*(?:\/T[1-9]\d*)?|raw\/S[1-9]\d*\/T[1-9]\d*#E[1-9]\d*(?:@(user|assistant|observation))?)$/.test(path)) process.exit(0);
let decision;
try {
  const root = process.env.CLAUDE_PLUGIN_ROOT;
  if (!root || typeof event.session_id !== 'string') throw new Error('Claude Code plugin root or session is unavailable');
  const result = spawnSync(process.execPath, [join(root, 'dist/cc.cjs'), 'fs', '--config', join(root, 'cc.config.json'),
    '--session', event.session_id, 'materialize', path], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || `exit ${result.status}`).replace(/^Trace Memory CC: /, '').trim());
  const rendered = JSON.parse(result.stdout);
  if (typeof rendered.path !== 'string' || !rendered.path) throw new Error('memory renderer returned no snapshot');
  decision = { updatedInput: { ...event.tool_input, file_path: rendered.path }, permissionDecision: 'allow' };
} catch (error) {
  decision = { permissionDecision: 'deny', permissionDecisionReason: String(error) };
}
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...decision } }) + '\n');
