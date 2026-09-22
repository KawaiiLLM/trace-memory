import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";

// Independent connection/process: no inherited facade, claim or provider.
const db = new DatabaseSync(process.argv[2]);
db.exec("PRAGMA busy_timeout = 5000");
const update = db.prepare("UPDATE sessions SET first_reply_at = ? WHERE id = ?");
let writes = 0, maxMs = 0, firstAt = null, lastAt = null, timer, finished = false;
const finish = error => {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  db.close();
  process.send({ type: "done", writes, maxMs, firstAt, lastAt, ...(error ? { error: String(error) } : {}) });
  process.disconnect();
};
const write = () => {
  const start = performance.now();
  try {
    db.exec("BEGIN IMMEDIATE");
    update.run(new Date(Date.UTC(2026, 0, 1) + writes).toISOString(), Number(process.argv[3]));
    db.exec("COMMIT");
    writes++; firstAt ??= Date.now(); lastAt = Date.now();
    maxMs = Math.max(maxMs, performance.now() - start);
    timer = setTimeout(write, 10);
  } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); finish(error); }
};
process.on("message", message => { if (message === "stop") finish(); });
process.send({ type: "ready" });
write();
