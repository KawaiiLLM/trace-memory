// Local subprocess fault injection only; production has no clock or scheduling test switches.
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const require = createRequire(import.meta.url);
const fs = require('node:fs');
const controlPath = process.env.TM_SNAPSHOT_CONTROL;
const control = () => JSON.parse(readFileSync(controlPath, 'utf8'));
Date.now = () => control().now;
const wait = path => {
  const until = performance.now() + 15_000;
  while (!existsSync(path)) {
    if (performance.now() > until) throw new Error(`test barrier timed out: ${path}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
};
if (process.argv.some(arg => arg.endsWith('/slice.mjs'))) {
  writeFileSync(`${controlPath}.started`, 'started');
  const iterator = process.stdin[Symbol.asyncIterator];
  process.stdin[Symbol.asyncIterator] = function () {
    writeFileSync(`${controlPath}.input`, 'waiting');
    return iterator.call(this);
  };
  const original = fs.readdirSync;
  let paused = false;
  fs.readdirSync = function (...args) {
    writeFileSync(`${controlPath}.checked`, 'checked');
    if (!paused && control().pauseReader) {
      paused = true;
      writeFileSync(`${controlPath}.paused`, 'paused');
      wait(`${controlPath}.resume`);
    }
    return original.apply(this, args);
  };
  syncBuiltinESMExports();
}
if (process.argv.includes('hook-slices') && control().pauseSnapshot) {
  const original = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (sql) {
    const statement = original.call(this, sql);
    if (sql.includes('(SELECT IFNULL(MAX(id),0) FROM facts) f')) {
      const get = statement.get.bind(statement);
      statement.get = (...args) => {
        const value = get(...args); // The renderer's read transaction now owns its real snapshot.
        writeFileSync(`${controlPath}.snapshot`, JSON.stringify(value));
        wait(`${controlPath}.resume`);
        return value;
      };
    }
    return statement;
  };
}
