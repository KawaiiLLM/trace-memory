// Task-local fault injection: commit on another SQLite connection between preparation and selection.
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const childProcess = require('node:child_process');
const original = childProcess.spawnSync;
childProcess.spawnSync = function (file, args, options) {
  let revert = null, restoreBinding = null;
  if (args?.includes('hook-slices')) {
    try {
      const receipt = process.env.TRACE_66_INTERLEAVE_RECEIPT;
      openSync(receipt, 'wx');
      const config = JSON.parse(readFileSync(args.at(-1), 'utf8'));
      const mode = process.env.TRACE_66_INTERLEAVE_MODE ?? 'budget';
      if (mode === 'budget') {
        const writer = new DatabaseSync(config.dbPath);
        try { writer.exec('UPDATE knowledge_budget_policy SET global_tokens = global_tokens + 1 WHERE id = 1'); }
        finally { writer.close(); }
        if (process.env.TRACE_66_INTERLEAVE_REVERT === '1') revert = config.dbPath;
      } else {
        const session = JSON.parse(options.input).session_id;
        const bindingPath = join(config.stateDir, 'bindings', `${session}.json`);
        const original = readFileSync(bindingPath, 'utf8');
        const binding = JSON.parse(original);
        if (mode === 'enrollment') binding.enrollment.choice = false;
        else if (mode === 'project') binding.projectId = Number(process.env.TRACE_66_ALT_PROJECT);
        else throw new Error(`unsupported interleave mode ${mode}`);
        const temporary = `${bindingPath}.${process.pid}.tmp`;
        writeFileSync(temporary, JSON.stringify(binding)); renameSync(temporary, bindingPath);
        restoreBinding = { bindingPath, original };
      }
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  try { return original.call(this, file, args, options); }
  finally {
    if (revert) {
      const writer = new DatabaseSync(revert);
      try { writer.exec('UPDATE knowledge_budget_policy SET global_tokens = global_tokens - 1 WHERE id = 1'); }
      finally { writer.close(); }
    }
    if (restoreBinding) {
      const temporary = `${restoreBinding.bindingPath}.${process.pid}.tmp`;
      writeFileSync(temporary, restoreBinding.original); renameSync(temporary, restoreBinding.bindingPath);
    }
  }
};
syncBuiltinESMExports();
