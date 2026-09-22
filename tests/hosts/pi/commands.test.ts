// Ticket 24b: the command surface and the menu. The direct forms are `/trace`, `/trace on`,
// `/trace off`, `/trace catchup`, `/trace stop` and `/trace project <name>`; `enable`, `disable`,
// `status`, `runs` and the removed mark feature have no aliases. No model is called in this file.
import { afterEach, expect, test } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { host } from "./test-host.ts";

const hosts: ReturnType<typeof host>[] = [];
const setup = (config: Record<string, unknown> = {}) => { const h = host(config); hosts.push(h); return h; };
afterEach(async () => { for (const h of hosts.splice(0)) await h.dispose(); });
const command = (h: ReturnType<typeof host>, args: string) => h.commands.get("trace").handler(args, h.ctx);

test("24b: on and off act on this memory session immediately and without a reload; an independent session is untouched", async () => {
  const h = setup();
  await h.turn();                                            // S1 allocated, enabled by default
  expect(h.memory.status(1)).toContain("Enabled (default)");
  await command(h, "off");
  expect(h.memory.status(1)).toContain("Disabled (explicit choice)"); // immediately, in the same process
  expect(h.statuses.get("trace-memory")).toBe("🧠 <dim>○ off</dim>");
  await command(h, "on");
  expect(h.memory.status(1)).toContain("Enabled (explicit choice)");
  await command(h, "off");
  // A second, independent Pi session gets its own memory identity: the switch is per session, never global.
  h.ctx.sessionManager.getSessionId = () => "second-pi-session";
  h.entries.length = 0; h.allEntries.length = 0;
  await h.emit("session_start");
  await h.turn();
  expect(h.memory.store.getSession(2)).not.toBeNull();
  expect(h.memory.status(2)).toContain("Enabled (default)");  // untouched by S1's choice
  await command(h, "off");
  expect(h.memory.status(2)).toContain("Disabled (explicit choice)");
  expect(h.memory.status(1)).toContain("Disabled (explicit choice)"); // and S1 kept its own
  await command(h, "on");
  expect(h.memory.status(2)).toContain("Enabled (explicit choice)");
  expect(h.memory.status(1)).toContain("Disabled (explicit choice)"); // still its own, not the global one
  // Reopening the first identity restores the choice it made, with no reload of the extension.
  h.ctx.sessionManager.getSessionId = () => "pi-test";
  h.entries.length = 0; h.allEntries.length = 0;
  await h.emit("session_start");
  expect(h.memory.status(1)).toContain("Disabled (explicit choice)");
  expect(h.requests).toEqual([]);
});

test("24b: before the first reply, on and off persist the provisional choice and disclose the shared identity", async () => {
  const h = setup(); h.setHeaderTimestamp("2000-01-01T00:00:00Z"); // Disabled by default
  await h.emit("session_start");
  await command(h, "");
  expect(h.notices.at(-1)).toContain("Enrollment: Disabled (default)");
  await command(h, "on");
  expect(h.memory.store.getSession(1)).toBeNull();      // no artificial Turn, no identity yet
  expect(existsSync(join(h.dir, "agent", "trace-memory-enrollment"))).toBe(true); // the provisional receipt
  await h.emit("session_start");                        // reopen before any reply
  await command(h, "");
  expect(h.notices.at(-1)).toContain("Enabled (explicit choice)");
  await h.turn();
  expect(h.memory.store.enrollment(1)).toEqual({ defaultEnabled: false, choice: true }); // transferred at allocation
  // Keep the shared fork/clone scope in the confirmation, not permanent overview prose.
  h.ctx.hasUI = true; h.answers.push("Current session", "Off", false);
  await command(h, "");
  expect(h.dialogs.at(-1)!.title).toContain("Forks or clones carrying this memory identity share this switch.");
});

test("24b: retired subcommands and malformed arguments print the usage and change nothing", async () => {
  const h = setup();
  await h.turn();
  const before = { enrollment: h.memory.store.enrollment(1), runs: h.memory.store.listRuns(1).length, entries: h.entries.length };
  for (const bad of ["enable", "disable", "status", "runs", "runs 5", "on now", "off please", "mark K1", "mark K1 verified extra",
    "mark bogus verified", "mark K1 sideways", "project", "catchup now", "stop it", "retry fork", "settings", "nonsense"]) {
    await command(h, bad);
    expect(h.notices.at(-1)).toContain("is not a command form");
    expect(h.notices.at(-1)).toContain("/trace on");   // the usage, every time
    expect(h.notices.at(-1)).toContain("Nothing was changed.");
  }
  // The four retired spellings say where their function went, and remain inert.
  const said = async (verb: string, hint: string) => { await command(h, verb); expect(h.notices.at(-1)).toContain(hint); };
  await said("enable", "`enable` was retired; use /trace on");
  await said("disable", "`disable` was retired; use /trace off");
  await said("status", "`status` was retired; use the menu's Current session");
  await said("runs", "`runs` was retired; use the menu's Current session > Runs");
  expect(h.memory.store.enrollment(1)).toEqual(before.enrollment);
  expect(h.memory.store.listRuns(1)).toHaveLength(before.runs);
  expect(h.entries).toHaveLength(before.entries);
  expect(h.requests).toEqual([]);
});

test("24b: the retained forms work headless, and bare /trace prints status and the forms", async () => {
  const h = setup();                       // hasUI is false by default in the fake host
  expect(h.ctx.hasUI).toBe(false);
  await h.turn();
  await command(h, "");
  expect(h.notices.at(-1)).toContain("Session: S1");
  expect(h.notices.at(-1)).toContain("/trace (menu; status when headless) | /trace on | /trace off | /trace catchup | /trace stop | " +
    "/trace project <name>");
  expect(h.dialogs).toEqual([]);           // no dialog was opened without UI
  await command(h, "project headless-project");
  expect(h.notices.at(-1)).toContain("project: headless-project (mark)");
  await command(h, "catchup");
  expect(h.notices.at(-1)).toContain("Catchup:");
  await command(h, "stop");
  expect(h.notices.at(-1)).toContain("Trace Memory:");
  await command(h, "mark K1 verified");
  expect(h.notices.at(-1)).toContain("is not a command form");
  await command(h, "off"); expect(h.memory.status(1)).toContain("Disabled");
  await command(h, "on"); expect(h.memory.status(1)).toContain("Enabled");
});

test("24b: the menu has four entries and Current session keeps status, participation, runs and project", async () => {
  const h = setup();
  await h.turn();
  h.ctx.hasUI = true;
  h.answers.push(undefined);                       // cancelling the top level is inert
  await command(h, "");
  expect(h.dialogs.at(-1)!.options).toEqual(["Current session", "Catch up", "Stop", "Settings"]);
  const quiet = h.notices.length;
  h.answers.push("Current session", undefined);
  await command(h, "");
  expect(h.dialogs.at(-1)!.options).toEqual(["Off", "Runs", "Project"]); // no Retry fork while not downgraded
  expect(h.dialogs.at(-1)!.title).toContain("S1 | On(default) | $0.0000");                      // status, with 24a's counts
  expect(h.dialogs.at(-1)!.title).toContain("Pending / trigger (~tokens)");
  expect(h.notices).toHaveLength(quiet);                                          // cancelling wrote nothing
  // Runs, with its count selection.
  h.answers.push("Current session", "Runs", "3");
  await command(h, "");
  expect(h.notices.at(-1)).toContain("no runs yet");
  // Project assignment, through the same declaration core owns.
  h.answers.push("Current session", "Project", "menu-project");
  await command(h, "");
  expect(h.notices.at(-1)).toContain("project: menu-project (mark)");
  expect(h.memory.store.getProject(h.memory.store.getSession(1)!.projectId)!.name).toBe("menu-project");
  expect(h.requests).toEqual([]);
});

test("24b: cancelling any menu step changes nothing and makes no request", async () => {
  const h = setup();
  await h.turn();
  const globalSettings = join(h.dir, "agent", "settings.json");
  const before = { settings: readFileSync(globalSettings, "utf8"), enrollment: h.memory.store.enrollment(1), entries: h.entries.length };
  h.ctx.hasUI = true;
  const cancels: (string | boolean | undefined)[][] = [
    [undefined],                                   // the top level
    ["Current session", undefined],                // the session menu
    ["Current session", "Off", false],             // the participation confirmation
    ["Current session", "Runs", undefined],        // the count input
    ["Current session", "Project", undefined],     // the name input
    ["Catch up"],                                  // nothing pending: reports, starts nothing
    ["Settings", undefined],                       // the preference list
    ["Settings", "Noter mode: fork (Default)", undefined], // the value selection
  ];
  for (const answers of cancels) { h.answers.push(...answers); await command(h, ""); }
  expect(readFileSync(globalSettings, "utf8")).toBe(before.settings);
  expect(h.memory.store.enrollment(1)).toEqual(before.enrollment);
  expect(h.entries).toHaveLength(before.entries);
  expect(h.memory.store.listRuns(1)).toEqual([]);
  expect(h.requests).toEqual([]);
});

test("24b: menu Catch up and Stop are the same bounded operations, and Stop leaves future ordinary work enabled", async () => {
  const h = setup({ "noting.triggerTokens": 1_000_000_000 }); // nothing is ever due automatically
  await h.turn();
  h.ctx.hasUI = true;
  h.answers.push("Catch up");
  await command(h, "");
  expect(h.notices.at(-1)).toContain("Catchup:");                     // the finite drain, reported
  await h.drain();
  h.answers.push("Stop");
  await command(h, "");
  expect(h.notices.at(-1)).toContain("Trace Memory: nothing to stop."); // the drain had already ended
  expect(h.memory.store.enabled(1)).toBe(true);                        // stop is not participation
  expect(h.statuses.get("trace-memory")).not.toContain("off");
  // Future ordinary and explicit opportunities remain enabled after a stop: a new catchup is
  // admitted (this one finds the queue already drained, which is itself the proof it was allowed).
  h.answers.push("Catch up");
  await command(h, "");
  expect(h.notices.at(-1)).toContain("already caught up");
  await h.drain();
});
