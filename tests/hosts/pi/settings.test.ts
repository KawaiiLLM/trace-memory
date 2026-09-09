// Ticket 24b "Global settings": four preferences on the existing canonical keys, written into the
// resolved agent settings file by a re-read-and-merge write, and applied to tasks admitted afterwards
// through the façade's `configure` (amendment 2) and the host's own model selection. No new key, no
// second configuration source, no reload, no credential and no model call to validate a selection.
import { afterEach, expect, test } from "vitest";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { host, notingFact, reply } from "./test-host.ts";

const hosts: ReturnType<typeof host>[] = [];
const setup = (config: Record<string, unknown> = {}) => { const h = host(config); hosts.push(h); return h; };
afterEach(async () => { for (const h of hosts.splice(0)) await h.dispose(); });
const command = (h: ReturnType<typeof host>, args: string) => h.commands.get("trace").handler(args, h.ctx);
const globalPath = (h: ReturnType<typeof host>) => join(h.dir, "agent", "settings.json");
const globalFile = (h: ReturnType<typeof host>) => JSON.parse(readFileSync(globalPath(h), "utf8"));
/** The mode each run was admitted with, which is what a saved preference decides (the run's actual
 * mode may still be a documented fallback: a fork without a persisted parent file runs fresh). */
const requestedModes = (h: ReturnType<typeof host>) => h.memory.store.listRuns(1).map(r => JSON.parse(r.response!).requestedMode);
/** Seed the resolved global settings file with unrelated content the edit must preserve. */
const seed = (h: ReturnType<typeof host>, traceMemory: Record<string, unknown> = {}) => {
  const file = globalFile(h); // the fake host already wrote Pi's own `retry` policy here
  writeFileSync(globalPath(h), JSON.stringify({ ...file, "other-extension": { keep: "me" }, "trace-memory": traceMemory }));
};
/** Open Settings and choose one preference line, then one value. */
const edit = async (h: ReturnType<typeof host>, line: string, value: string | undefined) => {
  h.ctx.hasUI = true;
  h.answers.push("Settings", line, value);
  await command(h, "");
};

test("24b: each control writes only its canonical key, and every other setting in the file survives", async () => {
  const h = setup();
  seed(h, { "render.entryTokens": 222 });
  await h.emit("session_start");
  await edit(h, "Noter mode: fork (Default)", "subagent");
  expect(h.notices.at(-1)).toContain(`saved noting.forkModeDefault = false (subagent) in ${globalPath(h)}`);
  expect(h.notices.at(-1)).toContain("applies to memory tasks admitted from now on; running tasks keep the mode and model they started with");
  await edit(h, "Noter model: follow foreground (Default)", "fake/test-mini");
  await edit(h, "Consolidator mode: subagent (Default)", "fork");
  await edit(h, "Consolidator model: follow foreground (Default); fork mode inherits the foreground model fake/test", "fake/test");
  const file = globalFile(h);
  expect(file["other-extension"]).toEqual({ keep: "me" });          // another extension's section
  expect(file.retry).toMatchObject({ enabled: true });               // Pi's own settings
  expect(file["trace-memory"]).toEqual({                             // only the canonical keys, plus what was there
    "render.entryTokens": 222,
    "noting.forkModeDefault": false,
    notingModel: "fake/test-mini",
    "consolidation.subagentModeDefault": false,
    consolidationModel: "fake/test",
  });
  // The values read back exactly as the menu shows them, from the Global layer.
  h.answers.push("Settings", undefined); await command(h, "");
  expect(h.dialogs.at(-1)!.options).toEqual([
    "Noter mode: subagent (Global)",
    "Noter model: fake/test-mini (Global)",
    "Consolidator mode: fork (Global)",
    "Consolidator model: fake/test (Global); fork mode inherits the foreground model fake/test",
  ]);
  expect(h.requests).toEqual([]); // editing settings calls no model
});

test("24b: a saved mode reaches the next admitted task without a reload, and a task already running keeps its own", async () => {
  const h = setup({ "noting.triggerTokens": 20 });
  h.provider(async conversation => notingFact(conversation));
  await h.emit("session_start");
  await h.turn();
  expect(requestedModes(h)).toEqual(["fork"]); // the default the load froze
  // The edit, mid-session and with no reload of the extension.
  await edit(h, "Noter mode: fork (Default)", "subagent");
  h.ctx.hasUI = false;
  await h.turn();
  expect(requestedModes(h)).toEqual(["fork", "subagent"]); // admitted after the edit
  // A run already in flight keeps the mode frozen with it: hold the reply, switch back, release.
  let release: ((value: unknown) => void) | undefined;
  h.provider(async () => new Promise(resolve => { release = resolve; }) as never, { ignoreAbort: false });
  await h.prompt(); await h.answer("holding"); await h.emit("agent_settled"); await h.drain();
  expect(h.statuses.get("trace-memory")).toContain("<accent>"); // the third task is running, held at the wire
  await edit(h, "Noter mode: subagent (Global)", "fork");
  h.ctx.hasUI = false;
  release?.(reply("Done."));
  await h.drain();
  expect(requestedModes(h)).toEqual(["fork", "subagent", "subagent"]); // the running one kept its own
  expect(h.memory.store.listRuns(1).at(-1)!.outcome).toBe("success");
});

test("24b: a saved model is used by the next subagent run, and selecting a model never switches the mode", async () => {
  const h = setup({ "noting.triggerTokens": 20 });
  h.provider(async conversation => notingFact(conversation));
  await h.emit("session_start");
  await edit(h, "Noter mode: fork (Default)", "subagent");
  // Chosen while the phase is in subagent mode: the model is the one a subagent run uses.
  await edit(h, "Noter model: follow foreground (Default)", "fake/test-mini");
  expect(globalFile(h)["trace-memory"]).toEqual({ "noting.forkModeDefault": false, notingModel: "fake/test-mini" });
  h.ctx.hasUI = false;
  await h.turn();
  expect((h.requests.at(-1) as { model: string }).model).toBe("test-mini"); // the child really used it
  // Switching the mode back to fork preserves the saved subagent model and only discloses that fork
  // inherits the foreground model; choosing a model again does not switch the mode back.
  await edit(h, "Noter mode: subagent (Global)", "fork");
  h.answers.push("Settings", undefined); await command(h, "");
  expect(h.dialogs.at(-1)!.options![1]).toBe("Noter model: fake/test-mini (Global); fork mode inherits the foreground model fake/test");
  await edit(h, "Noter model: fake/test-mini (Global); fork mode inherits the foreground model fake/test", "Follow foreground");
  expect(globalFile(h)["trace-memory"]).toEqual({ "noting.forkModeDefault": true, notingModel: "session" });
  expect(h.dialogs.at(-1)!.title).toContain("inherits the foreground model fake/test; this choice is used by subagent runs");
});

test("24b: a project override stays effective and is explained; a global edit never erases it", async () => {
  const h = setup();
  const projectPath = join(h.dir, ".pi", "settings.json");
  mkdirSync(join(h.dir, ".pi"), { recursive: true });
  writeFileSync(projectPath, JSON.stringify({ "trace-memory": { "noting.forkModeDefault": true } }));
  const project = readFileSync(projectPath);
  seed(h, {});
  await h.emit("session_start");
  await edit(h, "Noter mode: fork (Project)", "subagent");
  expect(h.notices.at(-1)).toContain("A Project setting takes precedence, so the effective Noter mode stays fork (Project); it was not removed.");
  expect(readFileSync(projectPath)).toEqual(project);                       // the override file is untouched
  expect(globalFile(h)["trace-memory"]).toEqual({ "noting.forkModeDefault": false }); // the global edit was saved
  h.answers.push("Settings", undefined); await command(h, "");
  expect(h.dialogs.at(-1)!.options![0]).toBe("Noter mode: fork (Project); Global=subagent masked");
  // And the override survives a reopen, which re-reads every layer through the same load path.
  await h.emit("session_start");
  h.answers.push("Settings", undefined); await command(h, "");
  expect(h.dialogs.at(-1)!.options![0]).toBe("Noter mode: fork (Project); Global=subagent masked");
});

test("24b: cancelled, invalid, unavailable and failed edits leave the file and the effective settings alone", async () => {
  const h = setup();
  seed(h, { "render.entryTokens": 222 });
  await h.emit("session_start");
  const before = readFileSync(globalPath(h), "utf8");
  // Cancelling the value selection.
  await edit(h, "Noter mode: fork (Default)", undefined);
  expect(readFileSync(globalPath(h), "utf8")).toBe(before);
  // A model the registry does not know: refused without calling anything.
  await edit(h, "Noter model: follow foreground (Default); fork mode inherits the foreground model fake/test", "ghost/model");
  expect(h.notices.at(-1)).toContain("ghost/model is not an available provider/model in Pi's registry");
  expect(readFileSync(globalPath(h), "utf8")).toBe(before);
  // A malformed settings file is reported, never overwritten.
  writeFileSync(globalPath(h), "{ not json");
  await edit(h, "Noter mode: fork (Default)", "subagent");
  expect(h.notices.at(-1)).toContain("Noter mode unchanged — Error: Invalid settings.json");
  expect(readFileSync(globalPath(h), "utf8")).toBe("{ not json");
  // A `trace-memory` section that is not an object is the same kind of refusal.
  writeFileSync(globalPath(h), JSON.stringify({ "trace-memory": [1, 2] }));
  await edit(h, "Noter mode: fork (Default)", "subagent");
  expect(h.notices.at(-1)).toContain("Invalid trace-memory Global: expected an object");
  expect(globalFile(h)).toEqual({ "trace-memory": [1, 2] });
  // A write that cannot happen at all reports the failure instead of a false success.
  writeFileSync(globalPath(h), before);
  chmodSync(join(h.dir, "agent"), 0o500);
  try {
    await edit(h, "Noter mode: fork (Default)", "subagent");
    expect(h.notices.at(-1)).toContain("Noter mode unchanged —");
    expect(readFileSync(globalPath(h), "utf8")).toBe(before);
  } finally { chmodSync(join(h.dir, "agent"), 0o700); }
  expect(h.requests).toEqual([]);
});

test("24b: the legacy spelling of the edited preference is replaced, and unrelated legacy content is left alone", async () => {
  const h = setup();
  seed(h, { "noting.branchModeDefault": true, "render.entryTokens": 222 });
  await h.emit("session_start");
  h.ctx.hasUI = true;
  h.answers.push("Settings", undefined); await command(h, "");
  expect(h.dialogs.at(-1)!.options![0]).toBe("Noter mode: fork (Global)"); // the alias, shown canonically
  await edit(h, "Noter mode: fork (Global)", "subagent");
  expect(h.notices.at(-1)).toContain("The legacy spelling noting.branchModeDefault of the same preference was replaced by noting.forkModeDefault");
  expect(globalFile(h)["trace-memory"]).toEqual({ "render.entryTokens": 222, "noting.forkModeDefault": false });
  // The file the edit produced loads without an alias conflict, which is what the replacement is for.
  await h.emit("session_start");
  h.answers.push("Settings", undefined); await command(h, "");
  expect(h.dialogs.at(-1)!.options![0]).toBe("Noter mode: subagent (Global)");
});

test("24b: editing a setting starts no worker and does not clear the cache-miss latch", async () => {
  const h = setup();
  await h.turn();
  h.memory.store.suppressFork(1, "2026-09-09T00:00:00.000Z");
  const runs = h.memory.store.listRuns(1).length;
  await edit(h, "Noter mode: fork (Default)", "subagent");
  await edit(h, "Consolidator model: follow foreground (Default)", "fake/test-mini");
  expect(h.memory.store.forkSuppression(1)).toMatchObject({ at: "2026-09-09T00:00:00.000Z" });
  expect(h.memory.store.listRuns(1)).toHaveLength(runs);
  expect(h.requests).toEqual([]);
  expect(h.conversations).toEqual([]);
});
