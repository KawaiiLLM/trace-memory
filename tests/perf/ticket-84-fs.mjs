import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";

const fd = openSync(process.argv[2], "w");
const block = Buffer.alloc(1024 * 1024, 84);
let writes = 0, finished = false, writing = true;
const seconds = Number(process.argv[3]);
if (seconds > 0) setTimeout(() => { writing = false; }, seconds * 1000);
process.on("message", message => {
  if (message !== "stop" || finished) return;
  finished = true;
  closeSync(fd);
  process.send({ type: "done", writes });
  process.disconnect();
});
process.send({ type: "ready" });
process.on("disconnect", () => { if (!finished) { finished = true; writing = false; closeSync(fd); } });
function write() {
  if (!writing || finished) return;
  writeSync(fd, block, 0, block.length, 0);
  fsyncSync(fd);
  writes++;
  setImmediate(write);
}
write();
