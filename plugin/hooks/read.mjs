// Native PreToolUse hands a fresh trace:// rendering to Claude Code's own Read.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const event = JSON.parse(input);
if (event.tool_name !== 'Read') process.exit(0);
const value = event.tool_input?.file_path;
// Claude Code resolves file_path against its working directory before a command hook runs, so
// `trace://K1` arrives as `<cwd>/trace:/K1`; accept that form and the raw one.
const cwd = typeof event.cwd === 'string' ? event.cwd.replace(/\/+$/, '') : '';
const rest = typeof value !== 'string' ? null : value.startsWith('trace://') ? value.slice('trace://'.length)
  : cwd && (value === `${cwd}/trace:` || value.startsWith(`${cwd}/trace:/`)) ? value.slice(cwd.length + '/trace:'.length) : null;
if (rest === null) process.exit(0);
const path = `trace://${rest.split('/').filter(Boolean).join('/')}`;
// Whole node views and exact Raw entries are answered by the main-session function hook.
if (/^trace:\/\/(?:(?:knowledge|compact)\/S[1-9]\d*(?:\/T[1-9]\d*)?|raw\/S[1-9]\d*\/T[1-9]\d*#E[1-9]\d*(?:@(user|assistant|observation))?)$/.test(path)) process.exit(0);
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
