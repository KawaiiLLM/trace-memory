import { afterEach, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { host } from "./test-host.ts";
import { buildSettingsChoices, parseRunsCount, toggleConfirmation, TRACE_SETTINGS_FIXTURE } from "../../../src/hosts/trace-menu.ts";

const hosts: ReturnType<typeof host>[] = [];
const setup = () => { const h = host(); hosts.push(h); return h; };
afterEach(async () => { for (const h of hosts.splice(0)) await h.dispose(); });
const command = (h: ReturnType<typeof host>) => h.commands.get("trace").handler("", h.ctx);

test("main menu uses shared action order; cancellation and read do not schedule or write", async () => {
  const h = setup(); await h.turn(); h.ctx.hasUI = true;
  const before = { entries: h.entries.length, runs: h.memory.store.listRuns(1), requests: h.requests.length };
  h.answers.push(undefined); await command(h);
  expect(h.dialogs.at(-1)!.options).toEqual(["Turn off", "Catch up", "Stop", "Project…", "Runs…", "Settings…"]);
  expect(h.dialogs.at(-1)!.title).toContain("Pending / trigger");
  expect(h.dialogs.at(-1)!.title).toContain("Trace Memory · S1");
  expect(h.entries).toHaveLength(before.entries);
  expect(h.memory.store.listRuns(1)).toEqual(before.runs);
  expect(h.requests).toHaveLength(before.requests);
});

test("toggle, project, runs and settings retain their existing effects and cancellations", async () => {
  const h = setup(); await h.turn(); h.ctx.hasUI = true;
  h.answers.push("Turn off", false); await command(h);
  expect(h.memory.store.enabled(1)).toBe(true);
  expect(h.dialogs.at(-1)!.title).toContain(toggleConfirmation(false, false).message);
  h.answers.push("Turn off", true); await command(h);
  expect(h.memory.store.enabled(1)).toBe(false);
  h.answers.push("Turn on", true); await command(h);
  expect(h.memory.store.enabled(1)).toBe(true);
  h.answers.push("Runs…", "3"); await command(h);
  expect(h.notices.at(-1)).toContain("no runs yet");
  h.answers.push("Project…", "new-project"); await command(h);
  expect(h.memory.store.getProject(h.memory.store.getSession(1)!.projectId)!.name).toBe("new-project");
  const file = join(h.dir, "agent", "settings.json");
  const before = readFileSync(file, "utf8");
  h.answers.push("Settings…", undefined); await command(h);
  expect(h.dialogs.at(-1)!.title).toContain("Trace Memory · Settings");
  expect(h.dialogs.at(-1)!.title).toContain("knowledge window 20,000 + shared allowance 10,000");
  expect(readFileSync(file, "utf8")).toBe(before);
  h.answers.push("Settings…", "Project Knowledge budget: 15,000", "16000"); await command(h);
  expect(h.memory.knowledgeBudgets().project).toBe(16_000);
  expect(readFileSync(file, "utf8")).toBe(before);
  h.answers.push("Settings…", "Noter mode: subagent", "fork"); await command(h);
  expect(JSON.parse(readFileSync(file, "utf8"))["trace-memory"]["noting.forkModeDefault"]).toBe(true);
  expect(h.requests).toEqual([]);
});

test("Runs count rejects invalid input instead of silently using another limit; cancellation is inert", async () => {
  const h = setup(); await h.turn(); h.ctx.hasUI = true;
  const before = h.memory.store.listRuns(1);
  for (const value of ["", "0", "-1", "1.5", " 2", "01", "9007199254740992", "abc"]) {
    h.answers.push("Runs…", value); await command(h);
    expect(h.notices.at(-1)).toContain("Runs count must be a positive safe integer");
  }
  h.answers.push("Runs…", undefined); const notices = h.notices.length; await command(h);
  expect(h.notices).toHaveLength(notices);
  h.answers.push("Runs…", "21"); await command(h);
  expect(h.notices.at(-1)).toContain("no runs yet");
  expect(h.memory.store.listRuns(1)).toEqual(before);
  expect(parseRunsCount("21")).toBe(21);
  expect(h.requests).toEqual([]);
});

test("shared settings choices expose every editable row with stable IDs", () => {
  const choices = buildSettingsChoices(TRACE_SETTINGS_FIXTURE);
  expect(choices.map(c => c.id)).toEqual([
    "budget.global", "budget.project", "budget.session", "noting.mode", "noting.model", "noting.thinking",
    "consolidation.mode", "consolidation.model", "consolidation.thinking", "dreaming.model", "dreaming.thinking", "closedSessionScope",
  ]);
  expect(choices.find(c => c.id === "budget.project")!.label).toContain("15,000");
});
