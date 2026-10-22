// Ticket 24b "Global settings", as tickets 26d and 29e and the 2026-10-22 fresh-only ruling left it: each
// phase's model and thinking level plus the borrowing scope, on the existing canonical N/D keys, written into the
// resolved agent settings file by a re-read-and-merge write, and applied to tasks admitted afterwards
// through the façade's `configure` (amendment 2) and the host's own model selection. No new key, no
// second configuration source, no reload, no credential and no model call to validate a selection.
import { afterEach, expect, test } from "vitest";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emptyNote, host, NOTER_BATCH_REQUESTS, notingFact, reply } from "./test-host.ts";
import { configuration, parseKnowledgeBudgetInput, parseLayer, preferences, thinkingChoices, writeGlobal } from "../../../src/hosts/pi/settings.ts";
import { validateConfig } from "../../../src/core/api/index.ts";

const hosts: ReturnType<typeof host>[] = [];
const setup = (config: Record<string, unknown> = {}) => { const h = host(config); hosts.push(h); return h; };
afterEach(async () => { for (const h of hosts.splice(0)) await h.dispose(); });
const command = (h: ReturnType<typeof host>, args: string) => h.commands.get("trace").handler(args, h.ctx);
const globalPath = (h: ReturnType<typeof host>) => join(h.dir, "agent", "settings.json");
const globalFile = (h: ReturnType<typeof host>) => JSON.parse(readFileSync(globalPath(h), "utf8"));
/** Seed the resolved global settings file with unrelated content the edit must preserve. */
const seed = (h: ReturnType<typeof host>, traceMemory: Record<string, unknown> = {}) => {
  const file = globalFile(h); // the fake host already wrote Pi's own `retry` policy here
  writeFileSync(globalPath(h), JSON.stringify({ ...file, "other-extension": { keep: "me" }, "trace-memory": traceMemory }));
};
/** Open Settings and choose one preference line, then one value. */
const edit = async (h: ReturnType<typeof host>, line: string, value: string | undefined) => {
  h.ctx.hasUI = true;
  // Select by the canonical setting identity; values in older test call sites describe the
  // pre-redesign presentation, not a second Settings protocol.
  const key = line.split(":", 1)[0]!;
  const labels = ["Global Knowledge budget", "Project Knowledge budget", "Session Knowledge budget",
    "Noter model", "Noter thinking", "Dreamer model", "Dreamer thinking", "Classifier model", "Classifier thinking", "Closed-session scope"];
  if (!labels.includes(key)) throw new Error(`Unknown editable settings row: ${line}`);
  h.answers.push("Settings…", undefined);
  await command(h, "");
  const current = h.dialogs.at(-1)!.options!.find(option => option.startsWith(`${key === "Closed-session scope" ? "Closed sessions" : key}:`));
  if (!current) throw new Error(`Missing settings row: ${key}`);
  h.answers.push("Settings…", current, value);
  await command(h, "");
};

test("35d/45 retire file-owned knowledge caps and parse exact database-budget input", () => {
  expect(validateConfig({})).not.toHaveProperty("consolidation");
  expect(parseKnowledgeBudgetInput("0", "Global Knowledge budget")).toBe(0);
  expect(parseKnowledgeBudgetInput("15000", "Project Knowledge budget")).toBe(15_000);
  for (const value of ["-1", "1.5", "NaN", "Infinity", "01", " 1", "1 ", "9007199254740992", "1e3", ""])
    expect(() => parseKnowledgeBudgetInput(value, "Global Knowledge budget")).toThrow(/exact nonnegative safe integer/);
  for (const value of [20_000, 1]) for (const key of ["render.knowledgeBlockTokens", "consolidation.knowledgeTokens"]) {
    expect(() => parseLayer({ [key]: value })).toThrow(new RegExp(`Removed setting ${key.replace(".", "\\.")}.*remove it.*Settings.*bound database`));
    const [section, field] = key.split(".");
    expect(() => validateConfig({ [section!]: { [field!]: value } } as never)).toThrow(new RegExp(`Removed setting ${key.replace(".", "\\.")}`));
  }
  const h = setup();
  for (const key of ["render.knowledgeBlockTokens", "consolidation.knowledgeTokens"])
    expect(() => configuration(h.dir, JSON.stringify({ [key]: 20_000 }), join(h.dir, "agent")))
      .toThrow(new RegExp(`Removed setting ${key.replace(".", "\\.")}`));
  expect(() => writeGlobal(globalPath(h), "consolidation.knowledgeTokens", 1 as never)).toThrow(/Removed setting consolidation\.knowledgeTokens/);
  expect(() => h.memory.configure({ consolidation: { knowledgeTokens: 1 } } as never)).toThrow(/Removed setting consolidation\.knowledgeTokens/);
  expect(globalFile(h)["trace-memory"]).toBeUndefined();
  expect(preferences.map(p => p.key)).toEqual(["notingModel", "notingThinking",
    "dreaming.model", "dreaming.thinking", "dreaming.classifyModel", "dreaming.classifyThinking", "closedSessionScope"]);
});

test("35d Settings edits the bound database row, shows derived diagnostics, and never writes preferences", async () => {
  const h = setup();
  await h.emit("session_start");
  const before = readFileSync(globalPath(h), "utf8");
  h.ctx.hasUI = true;
  h.answers.push("Settings…", undefined);
  await command(h, "");
  expect(h.dialogs.at(-1)!.title).toContain(`\n${join(h.dir, "trace.db")}`);
  expect(h.dialogs.at(-1)!.title).toContain("knowledge window 20,000 + shared allowance 10,000 = 30,000 max input");
  expect(h.dialogs.at(-1)!.options!.slice(0, 3)).toEqual([
    "Global Knowledge budget: 4,000", "Project Knowledge budget: 15,000", "Session Knowledge budget: 1,000",
  ]);
  await edit(h, "Project Knowledge budget: 15000 tokens per project owner pool (database)", "16000");
  expect(h.memory.knowledgeBudgets()).toMatchObject({ global: 4000, project: 16000, session: 1000,
    applicable: 21000, injection: 21000 });
  expect(h.notices.at(-1)).toContain("saved Project Knowledge budget = 16000 tokens");
  expect(h.notices.at(-1)).toContain("Knowledge base window 21000; shared material allowance 10000; maximum Knowledge input 31000");
  expect(readFileSync(globalPath(h), "utf8")).toBe(before);
  expect(h.requests).toEqual([]);

  const rows = Number(h.memory.store.db.prepare("SELECT total_changes() AS n").get()!.n);
  await edit(h, "Project Knowledge budget: 16000 tokens per project owner pool (database)", "16000");
  expect(h.notices.at(-1)).toContain("nothing was written");
  expect(Number(h.memory.store.db.prepare("SELECT total_changes() AS n").get()!.n)).toBe(rows);
  await edit(h, "Global Knowledge budget: 4000 tokens (database)", undefined);
  await edit(h, "Global Knowledge budget: 4000 tokens (database)", "01");
  expect(h.memory.knowledgeBudgets().global).toBe(4000);
  expect(h.notices.at(-1)).toContain("exact nonnegative safe integer");
  expect(readFileSync(globalPath(h), "utf8")).toBe(before);
});

test("35d cancelled, invalid, stale and failed database-budget edits preserve policy and files", async () => {
  const h = setup();
  await h.emit("session_start");
  const settings = readFileSync(globalPath(h), "utf8");
  await edit(h, "Global Knowledge budget: 4000 tokens (database)", undefined);
  expect(h.memory.knowledgeBudgets().global).toBe(4000);
  await edit(h, "Global Knowledge budget: 4000 tokens (database)", "01");
  expect(h.notices.at(-1)).toContain("exact nonnegative safe integer");
  h.memory.setKnowledgeBudget("project", 16_000); // another connection wins after the row was displayed
  await edit(h, "Session Knowledge budget: 1000 tokens per session owner pool (database)", "2000");
  expect(h.memory.knowledgeBudgets()).toMatchObject({ project: 16_000, session: 2_000 });

  h.memory.store.db.exec("CREATE TRIGGER reject_budget BEFORE UPDATE ON knowledge_budget_policy BEGIN SELECT RAISE(ABORT, 'policy write failed'); END");
  await edit(h, "Global Knowledge budget: 4000 tokens (database)", "5000");
  expect(h.notices.at(-1)).toContain("Global Knowledge budget unchanged");
  expect(h.notices.at(-1)).toContain("policy write failed");
  expect(h.memory.knowledgeBudgets().global).toBe(4_000);
  expect(readFileSync(globalPath(h), "utf8")).toBe(settings);
  expect(h.requests).toEqual([]);
});

test("2026-10-22: the Noter has model and thinking rows only, and a saved fork key is refused by name", async () => {
  const h = setup();
  await h.emit("session_start");
  h.ctx.hasUI = true;
  h.answers.push("Settings…", undefined); await command(h, "");
  expect(h.dialogs.at(-1)!.options!.filter(line => line.startsWith("Noter"))).toEqual(["Noter model: follow foreground", "Noter thinking: inherit"]);
  for (const key of ["noting.forkModeDefault", "noting.branchModeDefault"]) {
    expect(() => parseLayer({ [key]: true })).toThrow(`Removed setting ${key}: the Noter runs fresh only; remove this key`);
    expect(() => writeGlobal(globalPath(h), key, true as never)).toThrow(`Removed setting ${key}`);
    expect(() => configuration(h.dir, JSON.stringify({ [key]: false }), join(h.dir, "agent"))).toThrow(`Removed setting ${key}`);
  }
  expect(globalFile(h)["trace-memory"]).toBeUndefined();
});

test("32d: Dreamer preferences reuse Settings with no mode or advanced page", async () => {
  const h = setup();
  seed(h, { "render.entryTokens": 222 });
  await h.emit("session_start");
  await edit(h, "Dreamer model: follow foreground (Default)", "fake/test-mini");
  await edit(h, "Dreamer thinking: inherit (Default)", "high");
  expect(globalFile(h)["trace-memory"]).toEqual({ "render.entryTokens": 222, "dreaming.model": "fake/test-mini", "dreaming.thinking": "high" });
  expect(preferences.filter(p => p.phase === "dreaming").map(p => p.kind)).toEqual(["model", "thinking"]);
  expect(() => parseLayer({ "dreaming.forkModeDefault": true })).toThrow(/Unknown setting/);
  expect(() => parseLayer({ "dreaming.thinking": "unknown" })).toThrow(/dreaming.thinking/);
  expect(() => parseLayer({ "dreaming.maxToolRounds": 0 })).toThrow(/Removed setting dreaming\.maxToolRounds/); // 144: a leftover key fails the load by name
  expect(parseLayer({ "dreaming.triggerTokens": 6000, "dreaming.timeoutMs": 120000 }).dreaming)
    .toMatchObject({ triggerTokens: 6000, timeoutMs: 120000 });
  expect(parseLayer({}).dreaming).toMatchObject({ timeoutMs: 1_800_000 }); // 103: default rises to thirty minutes
  expect(h.requests).toEqual([]);
});

test("classify has its own Settings rows and keys; absent, they show the Dreamer's values (PENDING Q2)", async () => {
  const h = setup();
  seed(h, { "dreaming.model": "fake/test-mini" });
  await h.emit("session_start");
  h.ctx.hasUI = true;
  h.answers.push("Settings…", undefined); await command(h, "");
  expect(h.dialogs.at(-1)!.options).toContain("Classifier model: fake/test-mini");
  await edit(h, "Classifier model: fake/test-mini", "fake/test");
  await edit(h, "Classifier thinking: inherit (Default)", "low");
  expect(globalFile(h)["trace-memory"]).toEqual({ "dreaming.model": "fake/test-mini", "dreaming.classifyModel": "fake/test", "dreaming.classifyThinking": "low" });
  h.answers.push("Settings…", undefined); await command(h, "");
  expect(h.dialogs.at(-1)!.options).toEqual(expect.arrayContaining(["Dreamer model: fake/test-mini", "Classifier model: fake/test", "Classifier thinking: low"]));
  expect(() => parseLayer({ "dreaming.classifyThinking": "unknown" })).toThrow(/dreaming.classifyThinking/);
  expect(h.requests).toEqual([]);
});

test("24b: each control writes only its canonical key, and every other setting in the file survives", async () => {
  const h = setup();
  seed(h, { "render.entryTokens": 222 });
  await h.emit("session_start");
  await edit(h, "Noter model: follow foreground (Default)", "fake/test-mini");
  expect(h.notices.at(-1)).toContain(`saved notingModel = "fake/test-mini" (fake/test-mini) in ${globalPath(h)}`);
  expect(h.notices.at(-1)).toContain("applies to memory tasks admitted from now on; running tasks keep the model they started with");
  await edit(h, "Dreamer model: follow foreground (Default)", "fake/test");
  const file = globalFile(h);
  expect(file["other-extension"]).toEqual({ keep: "me" });          // another extension's section
  expect(file.retry).toMatchObject({ enabled: true });               // Pi's own settings
  expect(file["trace-memory"]).toEqual({                             // only the canonical keys, plus what was there
    "render.entryTokens": 222,
    notingModel: "fake/test-mini",
    "dreaming.model": "fake/test",
  });
  // The values read back exactly as the menu shows them, from the Global layer: each phase's model
  // and thinking level plus the borrowing scope.
  h.answers.push("Settings…", undefined); await command(h, "");
  expect(h.dialogs.at(-1)!.options).toEqual([
    "Global Knowledge budget: 4,000", "Project Knowledge budget: 15,000", "Session Knowledge budget: 1,000",
    "Noter model: fake/test-mini", "Noter thinking: inherit",
    "Dreamer model: fake/test", "Dreamer thinking: inherit",
    "Classifier model: fake/test", "Classifier thinking: inherit", "Closed sessions: project",
  ]);
  expect(h.requests).toEqual([]); // editing settings calls no model
});

test("26d: each phase's thinking level is saved under its own key, listed with its source layer, and an unknown level is refused by name", async () => {
  const h = setup();
  seed(h, { "render.entryTokens": 222 });
  await h.emit("session_start");
  // The default is fresh execution: the saved thinking preference applies directly.
  await edit(h, "Noter thinking: inherit (Default)", "high");
  expect(h.dialogs.at(-1)!.options).toEqual(thinkingChoices);
  expect(h.dialogs.at(-1)!.title).not.toContain("fork");
  expect(h.notices.at(-1)).toContain(`saved notingThinking = "high" (high) in ${globalPath(h)}`);
  expect(h.notices.at(-1)).toContain("running tasks keep the thinking level they were frozen with");
  // Dreamer is always a fresh subagent and has its own thinking preference.
  await edit(h, "Dreamer thinking: inherit (Default)", "minimal");
  expect(h.dialogs.at(-1)!.title).not.toContain("fork");
  const file = globalFile(h);
  expect(file["other-extension"]).toEqual({ keep: "me" });
  expect(file["trace-memory"]).toEqual({ "render.entryTokens": 222, notingThinking: "high", "dreaming.thinking": "minimal" });
  h.answers.push("Settings…", undefined); await command(h, "");
  expect(h.dialogs.at(-1)!.options).toEqual([
    "Global Knowledge budget: 4,000", "Project Knowledge budget: 15,000", "Session Knowledge budget: 1,000",
    "Noter model: follow foreground", "Noter thinking: high",
    "Dreamer model: follow foreground", "Dreamer thinking: minimal",
    "Classifier model: follow foreground", "Classifier thinking: minimal", "Closed sessions: project",
  ]);
  // A level nothing accepts never reaches the file, and the refusal names the key and the list.
  const before = readFileSync(globalPath(h), "utf8");
  await edit(h, "Dreamer thinking: minimal (Global)", "extreme");
  expect(h.notices.at(-1)).toContain("Invalid dreaming.thinking: expected one of inherit, off, minimal, low, medium, high, xhigh, max");
  expect(readFileSync(globalPath(h), "utf8")).toBe(before);
  // The same value in a settings file is refused by the load path itself, by name.
  expect(() => host({ notingThinking: "extreme" })).toThrow("Invalid notingThinking: expected one of inherit, off, minimal, low, medium, high, xhigh, max");
  expect(h.requests).toEqual([]); // editing a level calls no model
});

test("closed-session scope is saved globally and changes subsequent queue admission without reload", async () => {
  const h = setup({ "noting.triggerTokens": 1_000_000_000 });
  await h.turn();
  const projectId = h.memory.store.createProject({ name: "foreign", declaredBy: "mark" }).id;
  const s = h.memory.store.createSession({ host: "closed", projectId, enrollmentChoice: true, startedAt: "t", firstReplyAt: "t" });
  const t = h.memory.store.appendTurn({ sessionId: s.id, kind: "turn", userPrompt: "closed evidence", startedAt: "t" });
  const e = h.memory.appendEntry({ sessionId: s.id, turnId: t.id, nativeId: "closed", nativeLineage: "closed", role: "user", text: "closed evidence", raw: "closed evidence", calls: [] });
  h.memory.selectEntries(s.id, "main", [e.id]); h.memory.store.closeSession(s.id);
  const tick = async () => { await h.prompt("another main turn"); await h.answer("small new completion"); await h.drain(); };
  await tick(); expect(h.requests).toEqual([]); // default project: foreign tail is invisible
  await edit(h, "Closed-session scope: project (Default)", "off");
  expect(globalFile(h)["trace-memory"].closedSessionScope).toBe("off");
  await tick(); expect(h.requests).toEqual([]);
  await edit(h, "Closed-session scope: off (Global)", "global");
  expect(globalFile(h)["trace-memory"].closedSessionScope).toBe("global");
  expect(h.requests).toEqual([]); // a settings change is not an extraction opportunity
  await tick(); expect(h.requests).toHaveLength(NOTER_BATCH_REQUESTS); // one batch: both tasks
  expect(h.memory.store.listRuns(s.id).some(r => r.kind === "noting")).toBe(true);
});

test("closed-session scope respects a project override and invalid values never overwrite settings", async () => {
  const h = setup();
  const project = join(h.dir, ".pi", "settings.json");
  mkdirSync(join(h.dir, ".pi"), { recursive: true });
  writeFileSync(project, JSON.stringify({ "trace-memory": { closedSessionScope: "off" } }));
  await h.emit("session_start");
  await edit(h, "Closed-session scope: off (Project)", "global");
  expect(globalFile(h)["trace-memory"].closedSessionScope).toBe("global");
  expect(h.notices.at(-1)).toContain("effective Closed-session scope stays off (Project)");
  const before = readFileSync(globalPath(h), "utf8");
  await edit(h, "Closed-session scope: off (Project); Global=global masked", "invalid");
  expect(readFileSync(globalPath(h), "utf8")).toBe(before);
  expect(h.notices.at(-1)).toContain("Invalid closedSessionScope");
});

test("24b: a saved model is used by the next subagent run, and choosing the foreground model saves \"session\"", async () => {
  const h = setup({ "noting.triggerTokens": 30 });
  h.provider(async conversation => notingFact(conversation));
  await h.emit("session_start");
  await edit(h, "Noter model: follow foreground (Default)", "fake/test-mini");
  expect(globalFile(h)["trace-memory"]).toEqual({ notingModel: "fake/test-mini" });
  h.ctx.hasUI = false;
  await h.turn();
  expect((h.requests.at(-1) as { model: string }).model).toBe("test-mini"); // the child really used it
  h.ctx.hasUI = true;
  h.answers.push("Settings…", undefined); await command(h, "");
  expect(h.dialogs.at(-1)!.options![3]).toBe("Noter model: fake/test-mini");
  await edit(h, "Noter model: fake/test-mini", "Follow foreground");
  expect(globalFile(h)["trace-memory"]).toEqual({ notingModel: "session" });
  expect(h.dialogs.at(-1)!.title).toContain("used by this phase's subagent runs");
});

test("24b: a project override stays effective and is explained; a global edit never erases it", async () => {
  const h = setup();
  const projectPath = join(h.dir, ".pi", "settings.json");
  mkdirSync(join(h.dir, ".pi"), { recursive: true });
  writeFileSync(projectPath, JSON.stringify({ "trace-memory": { notingModel: "fake/test-mini" } }));
  const project = readFileSync(projectPath);
  seed(h, {});
  await h.emit("session_start");
  await edit(h, "Noter model: fake/test-mini (Project)", "fake/test");
  expect(h.notices.at(-1)).toContain("A Project setting takes precedence, so the effective Noter model stays fake/test-mini (Project); it was not removed.");
  expect(readFileSync(projectPath)).toEqual(project);                       // the override file is untouched
  expect(globalFile(h)["trace-memory"]).toEqual({ notingModel: "fake/test" }); // the global edit was saved
  h.answers.push("Settings…", undefined); await command(h, "");
  expect(h.dialogs.at(-1)!.options![3]).toBe("Noter model: fake/test-mini (Project setting — this edit will not take effect)");
  // And the override survives a reopen, which re-reads every layer through the same load path.
  await h.emit("session_start");
  h.answers.push("Settings…", undefined); await command(h, "");
  expect(h.dialogs.at(-1)!.options![3]).toBe("Noter model: fake/test-mini (Project setting — this edit will not take effect)");
});

test("24b: cancelled, invalid, unavailable and failed edits leave the file and the effective settings alone", async () => {
  const h = setup();
  seed(h, { "render.entryTokens": 222 });
  await h.emit("session_start");
  const before = readFileSync(globalPath(h), "utf8");
  // Cancelling the value selection.
  await edit(h, "Noter thinking: inherit (Default)", undefined);
  expect(readFileSync(globalPath(h), "utf8")).toBe(before);
  // A model the registry does not know: refused without calling anything.
  await edit(h, "Noter model: follow foreground (Default)", "ghost/model");
  expect(h.notices.at(-1)).toContain("ghost/model is not an available provider/model in Pi's registry");
  expect(readFileSync(globalPath(h), "utf8")).toBe(before);
  // A malformed settings file is reported, never overwritten.
  writeFileSync(globalPath(h), "{ not json");
  await edit(h, "Noter thinking: inherit (Default)", "high");
  expect(h.notices.at(-1)).toContain("Noter thinking unchanged — Error: Invalid settings.json");
  expect(readFileSync(globalPath(h), "utf8")).toBe("{ not json");
  // A `trace-memory` section that is not an object is the same kind of refusal.
  writeFileSync(globalPath(h), JSON.stringify({ "trace-memory": [1, 2] }));
  await edit(h, "Noter thinking: inherit (Default)", "high");
  expect(h.notices.at(-1)).toContain("Invalid trace-memory Global: expected an object");
  expect(globalFile(h)).toEqual({ "trace-memory": [1, 2] });
  // A write that cannot happen at all reports the failure instead of a false success.
  writeFileSync(globalPath(h), before);
  chmodSync(join(h.dir, "agent"), 0o500);
  try {
    await edit(h, "Noter thinking: inherit (Default)", "high");
    expect(h.notices.at(-1)).toContain("Noter thinking unchanged —");
    expect(readFileSync(globalPath(h), "utf8")).toBe(before);
  } finally { chmodSync(join(h.dir, "agent"), 0o700); }
  expect(h.requests).toEqual([]);
});

test("24b: editing a setting starts no worker", async () => {
  const h = setup();
  await h.turn();
  const runs = h.memory.store.listRuns(1).length;
  await edit(h, "Noter thinking: inherit (Default)", "high");
  await edit(h, "Dreamer model: follow foreground (Default)", "fake/test-mini");
  expect(h.memory.store.listRuns(1)).toHaveLength(runs);
  expect(h.requests).toEqual([]);
  expect(h.conversations).toEqual([]);
});
