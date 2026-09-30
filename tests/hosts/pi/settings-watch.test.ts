// Every Pi session watches the settings files it reads: a change saved by one reaches the others'
// next admitted task with no message between them. A second host here is a second Pi session of the
// same installation: its own extension instance, database and working directory, the first one's agent
// directory (so the same global settings.json) and, through that directory's models.json, the first one's wire.
import { afterEach, expect, test, vi } from "vitest";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { host, notingFact } from "./test-host.ts";

const hosts: ReturnType<typeof host>[] = [];
afterEach(async () => { for (const h of hosts.splice(0)) await h.dispose(); });
function pair() {
  const first = host({ "noting.triggerTokens": 30 });
  const second = host({ "noting.triggerTokens": 30 }, { agentDir: first.agentDir });
  hosts.push(first, second);
  first.provider(async c => notingFact(c));
  return { first, second, file: join(first.agentDir, "settings.json") };
}
const edit = (file: string, values: Record<string, unknown>) => {
  const current = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...current, "trace-memory": { ...current["trace-memory"], ...values } }));
};
const requestedModes = (h: ReturnType<typeof host>) => h.memory.store.listRuns(1).map(r => JSON.parse(r.response!).requestedMode);
const notices = (h: ReturnType<typeof host>) => h.notices.filter(n => n.startsWith("Trace Memory: ") && /restart|could not be read/.test(n));
/** The mode the session's next admitted Noting task requests: the observable effect of the Noter mode setting. */
const nextMode = async (h: ReturnType<typeof host>) => { await h.turn(); return requestedModes(h).at(-1); };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

test("a change saved by one session reaches a second live session's next admitted task, without a notice", async () => {
  const { first, second, file } = pair();
  await first.emit("session_start"); await second.emit("session_start");
  await second.turn();
  expect(requestedModes(second)).toEqual(["subagent"]);
  const before = second.notices.length;
  // The first session saves through its own Settings menu; nothing is sent to the second.
  first.ctx.hasUI = true;
  first.answers.push("Settings…", undefined); await first.commands.get("trace").handler("", first.ctx);
  const row = first.dialogs.at(-1)!.options!.find(o => o.startsWith("Noter mode:"))!;
  first.answers.push("Settings…", row, "fork"); await first.commands.get("trace").handler("", first.ctx);
  expect(JSON.parse(readFileSync(file, "utf8"))["trace-memory"]["noting.forkModeDefault"]).toBe(true);
  await sleep(1_000); // file-system event latency plus the debounce
  expect(await nextMode(second)).toBe("fork");
  expect(requestedModes(second)).toEqual(["subagent", "fork"]);
  // The fork-to-subagent fallback is the fixture having no persisted parent; nothing speaks of the settings.
  expect(second.notices.slice(before).filter(n => /setting|saved|restart|mode =/i.test(n))).toEqual([]);
});

test("a write that renames a temporary file over the settings file is detected", async () => {
  const { first, second, file } = pair();
  await first.emit("session_start"); await second.emit("session_start");
  const current = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(`${file}.tmp`, JSON.stringify({ ...current, "trace-memory": { "noting.forkModeDefault": true } }));
  renameSync(`${file}.tmp`, file);
  await sleep(1_000); // file-system event latency plus the debounce
  expect(await nextMode(second)).toBe("fork");
  expect(await nextMode(first)).toBe("fork");
});

test("a change to a setting that cannot change live is refused once, with a restart notice, and nothing in the file applies", async () => {
  const { first, second, file } = pair();
  await first.emit("session_start"); await second.emit("session_start");
  edit(file, { "noting.forkModeDefault": true, "render.entryTokens": 222 });
  await vi.waitFor(() => expect(notices(second)).toHaveLength(1));
  expect(notices(second)[0]).toMatch(/render\.entryTokens.*restart/s);
  await sleep(200);
  expect(await nextMode(second)).toBe("subagent"); // the live half of the same edit was not applied either
  edit(file, { "render.entryTokens": 222 }); // the same refusal again is not repeated
  await sleep(300);
  expect(notices(second)).toHaveLength(1);
});

test("an invalid or half-written settings file keeps the running settings and is reported only if it stays invalid", async () => {
  const { first, second, file } = pair();
  await first.emit("session_start"); await second.emit("session_start");
  const valid = JSON.parse(readFileSync(file, "utf8"));
  // Half-written, then completed before the settle time ends: no report, and the change applies.
  writeFileSync(file, `{ "trace-memory": `);
  await sleep(150);
  writeFileSync(file, JSON.stringify({ ...valid, "trace-memory": { "noting.forkModeDefault": true } }));
  await sleep(1_000); // file-system event latency plus the debounce
  expect(await nextMode(second)).toBe("fork");
  await sleep(1_300);
  expect(notices(second)).toEqual([]);
  // Left truncated: the settings stay, and it is reported once.
  writeFileSync(file, `{ "trace-memory": `);
  await vi.waitFor(() => expect(notices(second)).toHaveLength(1), { timeout: 3_000 });
  expect(await nextMode(second)).toBe("fork"); // unchanged while the file is unreadable
  expect(notices(second)).toHaveLength(1);
  // The next valid write is read again.
  writeFileSync(file, JSON.stringify({ ...valid, "trace-memory": { "noting.forkModeDefault": false } }));
  await sleep(1_000); // file-system event latency plus the debounce
  expect(await nextMode(second)).toBe("subagent");
});
