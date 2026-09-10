// Ticket 24b "Global settings", as tickets 26d and 29e left it: each phase's mode, model and thinking
// level plus the borrowing scope, on the existing canonical keys — the Consolidator-mode entry 25b
// withdrew is back, because the mode it chooses is back — written into the
// resolved agent settings file by a re-read-and-merge write, and applied to tasks admitted afterwards
// through the façade's `configure` (amendment 2) and the host's own model selection. No new key, no
// second configuration source, no reload, no credential and no model call to validate a selection.
import { afterEach, expect, test } from "vitest";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emptyNoteReply, host, notingFact, reply } from "./test-host.ts";
import { parseLayer, preferences, thinkingChoices } from "../../../src/hosts/pi/settings.ts";
import { validateConfig } from "../../../src/core/api/index.ts";

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

test("32a: knowledge budgets use the existing core and flat validators, not Settings preferences", () => {
  expect(validateConfig({}).consolidation.knowledgeTokens).toBe(10_000);
  expect(parseLayer({ "consolidation.knowledgeTokens": 1234 }).consolidation!.knowledgeTokens).toBe(1234);
  expect(validateConfig({ consolidation: { knowledgeTokens: 1234 } }).consolidation.knowledgeTokens).toBe(1234);
  for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "10000", true, null]) {
    expect(() => validateConfig({ consolidation: { knowledgeTokens: value as number } })).toThrow(/consolidation.knowledgeTokens/);
    expect(() => parseLayer({ "consolidation.knowledgeTokens": value as number })).toThrow(/consolidation.knowledgeTokens/);
  }
  expect(preferences.map(p => p.key)).toEqual(["noting.forkModeDefault", "notingModel", "notingThinking",
    "consolidation.forkModeDefault", "consolidationModel", "consolidationThinking", "closedSessionScope"]);
});

test("both modes default to subagent in Settings and ordinary execution; saving fork changes only that phase", async () => {
  const h = setup({ "noting.triggerTokens": 20, "consolidation.triggerTokens": 1 });
  // A fork has no system prompt of its own — it inherits the parent's — so the phase of a forked
  // child is told from the task text this host appended, not from the Consolidator instructions.
  // The skipped facts are read out of the batch this run was actually given: this case runs two
  // Consolidation batches, and a `skipped` entry naming a fact outside the range is rejected.
  const consolidate = (c: { messages: { content: unknown }[] }) => {
    const facts = [...c.messages.map(m => String(m.content)).join("\n").matchAll(/\[F(\d+)\]/g)].map(m => `F${m[1]}`);
    return { ...reply(""), stopReason: "toolUse" as const, content: [{ type: "toolCall" as const, id: "memory-1", name: "memory",
      arguments: { operations: [], skipped: [...new Set(facts)].map(fact => ({ fact, because: "Not durable." })) } }] };
  };
  h.provider(async c => c.systemPrompt?.includes("### Second-round user message")
    || /Range: F\d+/.test(c.messages.map(m => String(m.content)).join("\n")) ? consolidate(c) : notingFact(c));
  await h.emit("session_start");
  h.ctx.hasUI = true;
  h.answers.push("Settings", undefined); await command(h, ""); // opened and cancelled: the list itself is the assertion
  expect(h.dialogs.at(-1)!.options!.filter(line => line.startsWith("Consolidator"))).toEqual([
    // 29e restored the entry 25b withdrew, beside the Noter's, with this phase's own default.
    "Consolidator mode: subagent (Default)",
    "Consolidator model: follow foreground (Default)", "Consolidator thinking: inherit (Default)"]);
  h.ctx.hasUI = false;
  expect(h.dialogs.at(-1)!.options!.filter(line => line.startsWith("Noter"))).toEqual([
    "Noter mode: subagent (Default)", "Noter model: follow foreground (Default)", "Noter thinking: inherit (Default)"]);
  // Neither mode was configured: both ordinary slots must request subagent, not fall back to it.
  await h.turn();
  await h.answer("tick"); await h.emit("agent_settled"); await h.drain();
  const modes = (kind: string) => h.memory.store.listRuns(1).filter(r => r.kind === kind)
    .map(r => [JSON.parse(r.response!).requestedMode, r.mode]);
  expect(modes("noting")).toEqual([["subagent", "subagent"]]);
  expect(h.memory.store.listRuns(1).every(r => JSON.parse(r.response!).fallbackReason === undefined)).toBe(true);
  expect(modes("consolidation")).toEqual([["subagent", "subagent"]]); // never asked for anything else, and ran as itself
  // 29e: saving the restored preference reaches tasks admitted afterwards without a reload, and the
  // slot then asks only this phase to fork — into the documented fallback in this
  // fake session, which captures no provider payload to fork from. (A Consolidation fork that really
  // runs, and the fallback path it shares with Noting, are pinned on the native fixture:
  // native.test.ts "19a/29e" and fallback.test.ts's 29e cases.)
  await edit(h, "Consolidator mode: subagent (Default)", "fork");
  expect(h.notices.at(-1)).toContain(`saved consolidation.forkModeDefault = true (fork) in ${globalPath(h)}`);
  expect(globalFile(h)["trace-memory"]["consolidation.forkModeDefault"]).toBe(true);
  h.ctx.hasUI = false;
  await h.turn();
  await h.answer("tick again"); await h.emit("agent_settled"); await h.drain();
  expect(modes("consolidation")).toEqual([["subagent", "subagent"], ["fork", "subagent"]]);
  expect(modes("noting").at(-1)).toEqual(["subagent", "subagent"]);
});

test("24b: each control writes only its canonical key, and every other setting in the file survives", async () => {
  const h = setup();
  seed(h, { "render.entryTokens": 222 });
  await h.emit("session_start");
  await edit(h, "Noter mode: subagent (Default)", "subagent");
  expect(h.notices.at(-1)).toContain(`saved noting.forkModeDefault = false (subagent) in ${globalPath(h)}`);
  expect(h.notices.at(-1)).toContain("applies to memory tasks admitted from now on; running tasks keep the mode and model they started with");
  await edit(h, "Noter model: follow foreground (Default)", "fake/test-mini");
  await edit(h, "Consolidator model: follow foreground (Default)", "fake/test");
  const file = globalFile(h);
  expect(file["other-extension"]).toEqual({ keep: "me" });          // another extension's section
  expect(file.retry).toMatchObject({ enabled: true });               // Pi's own settings
  expect(file["trace-memory"]).toEqual({                             // only the canonical keys, plus what was there
    "render.entryTokens": 222,
    "noting.forkModeDefault": false,
    notingModel: "fake/test-mini",
    consolidationModel: "fake/test",
  });
  // The values read back exactly as the menu shows them, from the Global layer. 29e: each phase's
  // mode, model and thinking level plus the borrowing scope.
  h.answers.push("Settings", undefined); await command(h, "");
  expect(h.dialogs.at(-1)!.options).toEqual([
    "Noter mode: subagent (Global)",
    "Noter model: fake/test-mini (Global)",
    "Noter thinking: inherit (Default)",
    "Consolidator mode: subagent (Default)",
    "Consolidator model: fake/test (Global)",
    "Consolidator thinking: inherit (Default)",
    "Closed-session scope: project (Default)",
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
  // Consolidation is configured for subagent mode here, so its level always applies and its line
  // discloses no inheriting mode (29e: it would, were the restored preference set to fork).
  await edit(h, "Consolidator thinking: inherit (Default)", "minimal");
  expect(h.dialogs.at(-1)!.title).not.toContain("fork");
  const file = globalFile(h);
  expect(file["other-extension"]).toEqual({ keep: "me" });
  expect(file["trace-memory"]).toEqual({ "render.entryTokens": 222, notingThinking: "high", consolidationThinking: "minimal" });
  h.answers.push("Settings", undefined); await command(h, "");
  expect(h.dialogs.at(-1)!.options).toEqual([
    "Noter mode: subagent (Default)",
    "Noter model: follow foreground (Default)",
    "Noter thinking: high (Global)",
    "Consolidator mode: subagent (Default)",
    "Consolidator model: follow foreground (Default)",
    "Consolidator thinking: minimal (Global)",
    "Closed-session scope: project (Default)",
  ]);
  // A level nothing accepts never reaches the file, and the refusal names the key and the list.
  const before = readFileSync(globalPath(h), "utf8");
  await edit(h, "Consolidator thinking: minimal (Global)", "extreme");
  expect(h.notices.at(-1)).toContain("Invalid consolidationThinking: expected one of inherit, off, minimal, low, medium, high, xhigh, max");
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
  const tick = async () => { h.persist(reply("small new completion")); await h.emit("agent_end"); await h.drain(); };
  await tick(); expect(h.requests).toEqual([]); // default project: foreign tail is invisible
  await edit(h, "Closed-session scope: project (Default)", "off");
  expect(globalFile(h)["trace-memory"].closedSessionScope).toBe("off");
  await tick(); expect(h.requests).toEqual([]);
  await edit(h, "Closed-session scope: off (Global)", "global");
  expect(globalFile(h)["trace-memory"].closedSessionScope).toBe("global");
  expect(h.requests).toEqual([]); // a settings change is not an extraction opportunity
  await tick(); expect(h.requests).toHaveLength(2); // 26a: the borrowed run submits, so it costs two requests
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

test("24b: a saved mode reaches the next admitted task without a reload, and a task already running keeps its own", async () => {
  const h = setup({ "noting.triggerTokens": 20 });
  h.provider(async conversation => notingFact(conversation));
  await h.emit("session_start");
  await h.turn();
  expect(requestedModes(h)).toEqual(["subagent"]); // the default the load froze
  // The edit, mid-session and with no reload of the extension.
  await edit(h, "Noter mode: subagent (Default)", "fork");
  h.ctx.hasUI = false;
  await h.turn();
  expect(requestedModes(h)).toEqual(["subagent", "fork"]); // admitted after the edit
  // A run already in flight keeps the mode frozen with it: hold the reply, switch back, release.
  let release: ((value: unknown) => void) | undefined;
  h.provider(async () => new Promise(resolve => { release = resolve; }) as never, { ignoreAbort: false });
  await h.prompt(); await h.answer("holding"); await h.emit("agent_settled"); await h.drain();
  expect(h.statuses.get("trace-memory")).toContain("<accent>"); // the third task is running, held at the wire
  await edit(h, "Noter mode: fork (Global)", "subagent");
  h.ctx.hasUI = false;
  release?.(emptyNoteReply()); // 26a: the held run completes its batch with the explicit empty submission
  await h.drain();
  expect(requestedModes(h)).toEqual(["subagent", "fork", "fork"]); // the running one kept its own
  expect(h.memory.store.listRuns(1).at(-1)!.outcome).toBe("success");
});

test("24b: a saved model is used by the next subagent run, and selecting a model never switches the mode", async () => {
  const h = setup({ "noting.triggerTokens": 20 });
  h.provider(async conversation => notingFact(conversation));
  await h.emit("session_start");
  await edit(h, "Noter mode: subagent (Default)", "subagent");
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
  await edit(h, "Noter mode: subagent (Default)", undefined);
  expect(readFileSync(globalPath(h), "utf8")).toBe(before);
  // A model the registry does not know: refused without calling anything.
  await edit(h, "Noter model: follow foreground (Default)", "ghost/model");
  expect(h.notices.at(-1)).toContain("ghost/model is not an available provider/model in Pi's registry");
  expect(readFileSync(globalPath(h), "utf8")).toBe(before);
  // A malformed settings file is reported, never overwritten.
  writeFileSync(globalPath(h), "{ not json");
  await edit(h, "Noter mode: subagent (Default)", "fork");
  expect(h.notices.at(-1)).toContain("Noter mode unchanged — Error: Invalid settings.json");
  expect(readFileSync(globalPath(h), "utf8")).toBe("{ not json");
  // A `trace-memory` section that is not an object is the same kind of refusal.
  writeFileSync(globalPath(h), JSON.stringify({ "trace-memory": [1, 2] }));
  await edit(h, "Noter mode: subagent (Default)", "fork");
  expect(h.notices.at(-1)).toContain("Invalid trace-memory Global: expected an object");
  expect(globalFile(h)).toEqual({ "trace-memory": [1, 2] });
  // A write that cannot happen at all reports the failure instead of a false success.
  writeFileSync(globalPath(h), before);
  chmodSync(join(h.dir, "agent"), 0o500);
  try {
    await edit(h, "Noter mode: subagent (Default)", "fork");
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
  await edit(h, "Noter mode: subagent (Default)", "fork");
  await edit(h, "Consolidator model: follow foreground (Default)", "fake/test-mini");
  expect(h.memory.store.forkSuppression(1)).toMatchObject({ at: "2026-09-09T00:00:00.000Z" });
  expect(h.memory.store.listRuns(1)).toHaveLength(runs);
  expect(h.requests).toEqual([]);
  expect(h.conversations).toEqual([]);
});
