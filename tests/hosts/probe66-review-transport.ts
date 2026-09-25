// Read-only audit of a completed, task-local native mock run; do not relabel generic context hooks.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeCcInjection, databaseIdentity } from '../../src/hosts/cc/injection.ts';
import { readCcMenu } from '../../src/hosts/cc/menu.ts';
import { resolveCcHostConfig } from '../../src/hosts/cc/config.ts';
const run = process.argv[2];
if (!run?.startsWith('/private/tmp/tm-66-implementation.lyQREJ/native-transport/run-')) throw new Error('task-owned run required');
const config = JSON.parse(readFileSync(join(run, 'plugin/cc.config.json'), 'utf8'));
const projectDir = join(run, 'config/projects');
const result = [];
for (const project of readdirSync(projectDir)) for (const file of readdirSync(join(projectDir, project)).filter(name => name.endsWith('.jsonl'))) {
  const native = file.slice(0, -6);
  const binding = JSON.parse(readFileSync(join(config.stateDir, 'bindings', `${native}.json`), 'utf8'));
  const visible = { db: databaseIdentity(config.dbPath), nativeSession: native, coreSession: binding.coreSessionId };
  const lines = readFileSync(join(projectDir, project, file), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const failures = lines.filter(line => line.attachment?.type === 'hook_non_blocking_error' &&
    line.attachment.hookEvent === 'SessionStart');
  if (failures.length) throw new Error(`${native}: ${failures.length} native SessionStart hook errors; inspect the preserved transcript`);
  let successes: any[] = [], lastDispatch: string | null = null;
  for (const line of lines) {
    if (line.attachment?.type === 'hook_success' && line.attachment.hookEvent === 'SessionStart') {
      if (lastDispatch !== null && lastDispatch !== line.attachment.toolUseID && successes.length) {
        result.push({ native, sourceKinds: [...new Set(successes.map(success => success.hookName))],
          successes: successes.length, dispatchItems: 0, inlineLengths: [], persisted: false,
          completeDigest: true, membership: { knowledge: [], facts: [], raw: [] },
          unique: { knowledge: [], facts: [], raw: [] }, duplicates: { knowledge: 0, facts: 0, raw: 0 },
          matchesStagedOutput: true, clearChild: Boolean(binding.clearedFrom),
          compactionTurnId: binding.clearedFrom?.compactionTurnId ?? null });
        successes = [];
      }
      lastDispatch = line.attachment.toolUseID;
      successes.push(line.attachment); continue;
    }
    if (line.attachment?.type !== 'hook_additional_context') continue;
    const context = line.attachment.content as string[];
    if (successes.length !== 24 || successes.some(success => success.toolUseID !== lastDispatch ||
        success.exitCode !== 0 || !success.command.includes('/hooks/slice.mjs'))) throw new Error('native hook success grouping failed');
    const sourceKinds = [...new Set(successes.map(success => success.hookName))];
    const decoded = context.map(text => decodeCcInjection(text, visible));
    const all = { knowledge: decoded.flatMap(entry => entry?.commits ?? []),
      facts: decoded.flatMap(entry => entry?.factIds ?? []), raw: decoded.flatMap(entry => entry?.entryIds ?? []) };
    const unique = Object.fromEntries(Object.entries(all).map(([kind, ids]) => [kind, [...new Set(ids)]]));
    const staged = readdirSync(join(config.stateDir, 'session-start', native)).filter(name => name.endsWith('.json'))
      .map(name => JSON.parse(readFileSync(join(config.stateDir, 'session-start', native, name), 'utf8')));
    const matched = context.every(text => staged.some(stage => stage.slices.some((slice: any) => slice?.hookSpecificOutput.additionalContext === text)));
    const frozenPath = join(config.stateDir, 'session-start', `${native}.clear.json`);
    const frozen = existsSync(frozenPath) ? JSON.parse(readFileSync(frozenPath, 'utf8')) : null;
    const prepared = frozen?.hookSpecificOutput?.additionalContext
      ? decodeCcInjection(frozen.hookSpecificOutput.additionalContext, visible) : null;
    const matchesPrepared = prepared === null ? null : prepared.commits.length === new Set(all.knowledge).size &&
      prepared.factIds.length === new Set(all.facts).size && prepared.entryIds.length === new Set(all.raw).size &&
      prepared.commits.every(id => all.knowledge.includes(id)) &&
      prepared.factIds.every(id => all.facts.includes(id)) && prepared.entryIds.every(id => all.raw.includes(id));
    const warnings = lines.filter(line => line.attachment?.type === 'hook_system_message' &&
      line.attachment.toolUseID === lastDispatch && line.attachment.hookName === 'SessionStart:clear');
    if (sourceKinds.includes('SessionStart:clear')) {
      if (prepared?.factIds.length !== 2 || frozen.transportItems.filter((item: any) => item.kind === 'fact').length !== 2 ||
          !frozen.transportItems.every((item: any) => frozen.hookSpecificOutput.additionalContext.includes(item.text)) ||
          all.facts.length !== 1 ||
          !prepared.factIds.includes(all.facts[0]!) ||
          !prepared.factIds.some(id => !all.facts.includes(id)) ||
          warnings.length !== 1 || !warnings[0].attachment.content.includes('1 unconsolidated fact') ||
          !successes.some(success => success.command.endsWith(' 0') && success.toolUseID === warnings[0].attachment.toolUseID) ||
          readCcMenu(resolveCcHostConfig(config), native).menu.notices.includes(warnings[0].attachment.content) === false ||
          !context.join('\n').includes('expand: F'))
        throw new Error('native clear fact omission/foreground/menu audit failed');
    }
    const record = { native, sourceKinds, successes: successes.length, dispatchItems: context.length,
      inlineLengths: context.map(text => text.length), persisted: context.some(text => text.includes('<persisted-output>')),
      completeDigest: decoded.every(Boolean), membership: all, unique, duplicates: Object.fromEntries(Object.entries(all)
        .map(([kind, ids]) => [kind, ids.length - new Set(ids).size])), matchesStagedOutput: matched,
      ...(prepared ? { prepared: { knowledge: prepared.commits, facts: prepared.factIds, raw: prepared.entryIds },
        matchesPrepared, foregroundWarnings: warnings.map(line => line.attachment.content) } : {}),
      clearChild: Boolean(binding.clearedFrom), compactionTurnId: binding.clearedFrom?.compactionTurnId ?? null };
    result.push(record); successes = []; lastDispatch = null;
  }
}
const enabled = result.find(entry => entry.native === '66000000-0000-4000-8000-000000000066' &&
  entry.sourceKinds.includes('SessionStart:startup'));
if (!enabled || enabled.successes !== 24 || !enabled.dispatchItems || !enabled.completeDigest ||
    !enabled.membership.knowledge.length || enabled.persisted || !enabled.matchesStagedOutput)
  throw new Error('explicitly enrolled native startup was not delivered inline');
for (const source of ['SessionStart:startup', 'SessionStart:compact', 'SessionStart:clear']) {
  const event = result.find(entry => entry.sourceKinds.includes(source));
  if (!event || event.successes !== 24 || !event.completeDigest || !event.matchesStagedOutput || event.persisted ||
      source === 'SessionStart:compact' && !event.membership.knowledge.length ||
      event.inlineLengths.some(length => length > 10_000) ||
      source === 'SessionStart:clear' && (!event.clearChild || !event.membership.raw.length ||
        Object.values(event.duplicates).some(count => count)))
    throw new Error(`${source}: native delivery contract not met; inspect preserved transcript`);
}
writeFileSync(join(run, 'reviewed-dispatches.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
