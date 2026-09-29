// Function-hooks module for Claude Code 2.1.280. Bundled from this source for the isolated hooks VM.
import { buildSettingsChoices, MENU_INPUTS, parseRunsCount, toggleConfirmation, type SettingsRowId, type TraceMenuInput, type SettingsInput } from "../../src/hosts/trace-menu.ts";
import { renderTraceMenu, renderTraceMenuText, renderTraceSettings, type CcContextBreakdown, type CcMemorySplit } from "../../src/hosts/cc/trace-menu-render.ts";
import { MEMORY_READ_ONLY, memoryGlob, memoryPath } from "../../src/core/model/address.ts";
import { ccOriginalRaw } from "../../src/hosts/cc/coverage-original.ts";

const PINNED_VERSION = "2.1.280";
type Reply = { menu: TraceMenuInput; settings: SettingsInput; context: { presence: "confirmed" | "unavailable"; estimatedMessagesTokens?: number; memory?: CcMemorySplit }; runs: { id: number; phase: string; status: string; cost: number; at: string }[] };
type Screen = "main" | "settings" | "runs" | "project" | "confirm" | "edit";
let screen: Screen = "main";
let reply: Reply | undefined;
let breakdown: CcContextBreakdown | undefined;
let notice = "";
let versionError = "";
let pluginRoot = "";
let selectedAction = "";
let selectedSetting: SettingsRowId | undefined;
// Claude Code docks a plugin pane at the width it requests (a person's drag or settings override it).
// 96 columns keep /context's full grid beside its legend: 20 cells of 2 columns, a gap and ~46-column lines.
const DOCK_COLUMNS = 96;
let paneWidth = DOCK_COLUMNS;
let runsLimit = 10;
let activeSession = "";
const id = "trace-memory-menu";

function renderCurrent() {
  if (!reply) throw new Error("Trace Memory: menu has not loaded");
  return renderTraceMenu(reply.menu, {
    breakdown,
    memory: reply.context.presence === "confirmed" ? reply.context.memory : undefined,
    contextTokens: reply.context.presence === "confirmed" ? reply.context.estimatedMessagesTokens : undefined,
  });
}
function decode(result: { stdout?: string; stderr?: string; exitCode: number }, label: string): string {
  if (result.exitCode !== 0) throw new Error(`${label}: ${result.stderr || `exit ${result.exitCode}`}`);
  if (!result.stdout) throw new Error(`${label}: empty CLI response${result.stderr ? ` (${result.stderr})` : ""}`);
  return result.stdout.trim();
}

// The pinned hooks checker follows `$` only through module-scope helper declarations.
async function load($: any) {
  const session = await $.session.id();
  let currentBreakdown: CcContextBreakdown | undefined;
  try {
    const usage = await $.session.usage({ breakdown: "summary", columns: paneWidth });
    const b = usage?.context?.breakdown;
    currentBreakdown = b ? { model: b.model, totalTokens: b.totalTokens, maxTokens: b.maxTokens,
      percentage: b.percentage, categories: b.categories, displayName: b.displayName, terminalWidth: paneWidth } : undefined;
  } catch { currentBreakdown = undefined; }
  let messages: unknown;
  try { messages = await $.session.messages({ as: "api" }); }
  catch { messages = null; }
  const result = await $.process.run(["node", `${pluginRoot}/dist/cc.cjs`, "cli", "--config", `${pluginRoot}/cc.config.json`, "--session", session, "menu", "--json", "--snapshot"],
    { stdin: JSON.stringify({ session, model: currentBreakdown?.model, messages }) });
  if (await $.session.id() !== session) throw new Error("native session changed while loading menu");
  return { session, data: JSON.parse(decode(result, "Trace Memory menu")) as Reply, breakdown: currentBreakdown };
}

// 92/08: native compaction, then the knowledge it lacks, recorded as that compaction's baseline (97).
async function nativeCompaction($: any, e: any, next: any, session: string) {
  const result = await next(e);
  if (result.skip || next.signal.aborted) return result;
  try {
    if (session !== await $.session.id()) throw new Error("native session changed during compact");
    const process = await $.process.run(["node", `${$.plugin.root}/dist/cc.cjs`, "hook-delta", "--config", `${$.plugin.root}/cc.config.json`],
      // 97: the supplement is recorded as this compaction's baseline; the retained messages are not read.
      { stdin: JSON.stringify({ hook_event_name: "session.compact", session_id: session, messages: [] }) });
    const slices = JSON.parse(decode(process, "Trace Memory compact delta")).slices;
    if (!Array.isArray(slices) || slices.length !== 24) throw new Error("compact delta returned invalid slices");
    const added = slices.filter(Boolean).map((slice: any) => slice.hookSpecificOutput?.additionalContext);
    if (added.some((text: unknown) => typeof text !== "string" || !text)) throw new Error("compact delta has invalid carrier");
    if (session !== await $.session.id() || next.signal.aborted) return result;
    return added.length ? { ...result, messages: [...result.messages,
      ...added.map((text: string) => ({ role: "user", text, toolUses: [] }))] } : result;
  } catch (error) {
    console.error(`Trace Memory compact delta: ${String(error)}`);
    return result;
  }
}

// 101: one `/tm` operation through `cc.cjs fs`, for this native session's reader. An answer made here
// skips Claude Code's permission and path checks, so every caller first checks the exact `/tm` prefix.
async function memoryFiles($: any, args: string[]): Promise<any> {
  const root = $.plugin.root, session = await $.session.id();
  const run = await $.process.run(["node", `${root}/dist/cc.cjs`, "fs", "--config", `${root}/cc.config.json`, "--session", session, ...args]);
  if (run.exitCode !== 0) throw new Error(String(run.stderr || `exit ${run.exitCode}`).replace(/^Trace Memory CC: /, "").trim());
  return JSON.parse(run.stdout);
}
const failure = (error: unknown) => ({ deny: error instanceof Error ? error.message : String(error) });
const listed = (listing: { lines: string[]; cut?: string }) => listing.cut ? [...listing.lines, listing.cut] : listing.lines;
async function forkEvent($: any, session: string, verb: string, detail: Record<string, unknown>): Promise<boolean> {
  const result = await $.process.run(["node", `${$.plugin.root}/dist/cc.cjs`, "hook-fork", "--config", `${$.plugin.root}/cc.config.json`],
    { stdin: JSON.stringify({ session_id: session, verb, ...detail }) });
  return JSON.parse(decode(result, `Trace Memory ${verb}`)).allowed === true;
}

async function stopNativeFork($: any, session: string, agent: string): Promise<void> {
  if (await $.session.id() !== session) throw new Error("native session changed before fork stop");
  const live = (await $.agent.list()).find((item: any) => item.id === agent && item.type === "fork" && item.status === "running");
  if (!live) throw new Error(`exact native fork ${agent} is not proven live`);
  const stopped = await $.tool.call({ tool: "TaskStop", task_id: agent });
  if (stopped?.result?.task_id !== agent || !String(stopped.result.message).startsWith("Successfully stopped task:"))
    throw new Error(`TaskStop did not confirm exact native fork ${agent}: ${JSON.stringify(stopped)}`);
}

// A single Hook-owned stream outlives main turn.complete; the helper only relays the executor's
// typed decision. Neither stream EOF nor a local authority revoke proves physical termination.
function watchNativeFork($: any, session: string, agent: string): void {
  $.clock.after(0, async () => {
    try {
      const stream = $.process.spawn({ argv: ["node", `${$.plugin.root}/dist/cc.cjs`, "hook-fork-watch", "--config",
        `${$.plugin.root}/cc.config.json`, "--session", session, agent] });
      let output = "", stderr = "", code: number | undefined;
      const iterator = stream[Symbol.asyncIterator]();
      while (true) {
        const step = await iterator.next();
        if (step.done) { code = step.value?.code; break; }
        if (step.value.stream === "stdout") output += step.value.text;
        if (step.value.stream === "stderr") stderr += step.value.text;
      }
      if (code !== 0) throw new Error(`fork stop helper exited ${code}: ${stderr}`);
      const instruction = JSON.parse(output.trim());
      if (instruction.agent !== agent || instruction.session !== session || !["done", "stop"].includes(instruction.kind))
        throw new Error("fork stop instruction has wrong native identity");
      if (instruction.kind === "stop") {
        await stopNativeFork($, session, agent);
        console.error(`Trace Memory native fork ${agent} physically stopped by TaskStop`);
      }
    } catch (error) {
      // Fence held writes first even if the helper never connected and TaskStop fails.
      try { await forkEvent($, session, "fork-disconnect", { agentId: agent }); }
      catch (fenceError) { console.error(`Trace Memory fork write fence failed (${agent}): ${String(fenceError)}`); }
      try { await stopNativeFork($, session, agent); }
      catch (stopError) { console.error(`Trace Memory fork physical stop unknown (${agent}): ${String(error)}; ${String(stopError)}`); }
      console.error(`Trace Memory fork stop listener failed (${agent}): ${String(error)}`);
    }
  });
}

export const register = (on: any) => {
  // 101: Read, Grep and Glob under /tm are Trace Memory's read-only files; every other path reaches the
  // real tool through `next` untouched. Edit, Write and NotebookEdit under /tm are refused.
  on("tool.call", { tool: "Read" }, async ($: any, e: any, next: any) => {
    const path = memoryPath(e.file_path);
    if (path === null) return next(e);
    try {
      const page = await memoryFiles($, ["read", path, String(e.offset ?? 1), ...(e.limit === undefined ? [] : [String(e.limit)])]);
      const lines = listed(page);
      return { result: { type: "text", file: { filePath: e.file_path, content: lines.join("\n"), numLines: lines.length,
        startLine: page.startLine, totalLines: page.totalLines } } };
    } catch (error) { return failure(error); }
  });
  on("tool.call", { tool: "Grep" }, async ($: any, e: any, next: any) => {
    const path = memoryPath(e.path);
    if (path === null) return next(e);
    const mode = e.output_mode === "content" || e.output_mode === "count" ? e.output_mode : "files_with_matches";
    const context = e["-C"] ?? e.context;
    try {
      const listing = await memoryFiles($, ["grep", mode === "content" ? "-n" : mode === "count" ? "-c" : "-l", ...(e["-i"] ? ["-i"] : []),
        ...(context !== undefined ? ["-C", String(context)] : []), ...(e["-A"] !== undefined ? ["-A", String(e["-A"])] : []),
        ...(e["-B"] !== undefined ? ["-B", String(e["-B"])] : []), ...(e.glob ? ["--glob", e.glob] : []),
        ...(e.offset ? ["--offset", String(e.offset)] : []), ...(e.head_limit ? ["--limit", String(e.head_limit)] : []), "--", e.pattern, path]);
      const lines = listed(listing);
      return { result: mode === "files_with_matches" ? { mode, numFiles: listing.lines.length, filenames: lines }
        : { mode, numFiles: 0, filenames: [], content: lines.join("\n"), numLines: lines.length } };
    } catch (error) { return failure(error); }
  });
  on("tool.call", { tool: "Glob" }, async ($: any, e: any, next: any) => {
    const pattern = memoryGlob(e.pattern, e.path);
    if (pattern === null) return next(e);
    try {
      const listing = await memoryFiles($, ["glob", pattern]);
      return { result: { durationMs: 0, numFiles: listing.lines.length, filenames: listed(listing), truncated: !!listing.cut } };
    } catch (error) { return failure(error); }
  });
  on("tool.call", { tool: "Edit" }, ($: any, e: any, next: any) => memoryPath(e.file_path) === null ? next(e) : { deny: MEMORY_READ_ONLY });
  on("tool.call", { tool: "Write" }, ($: any, e: any, next: any) => memoryPath(e.file_path) === null ? next(e) : { deny: MEMORY_READ_ONLY });
  on("tool.call", { tool: "NotebookEdit" }, ($: any, e: any, next: any) => memoryPath(e.notebook_path) === null ? next(e) : { deny: MEMORY_READ_ONLY });

  on("session.compact", async ($: any, e: any, next: any) => {
    // A plugin's or a precomputed compaction, and a subagent's or fork's own, stay Claude Code's.
    if (e.trigger === "precompute" || e.trigger === "plugin" || e.agentId) return next(e);
    let session: string;
    try { session = await $.session.id(); }
    catch (error) {
      console.error(`Trace Memory compact identity: ${String(error)}`);
      return next(e);
    }
    // 102: Trace Memory's compaction replaces Claude Code's summary, with no model call. Like Pi's, it
    // keeps no original message: the trigger is the newest Raw in the block. An unbound or disabled
    // session, or a build that fails for any reason, keeps native compaction and its supplement.
    try {
      const built = JSON.parse(decode(await $.process.run(["node", `${$.plugin.root}/dist/cc.cjs`, "hook-compact", "--config", `${$.plugin.root}/cc.config.json`],
        // The newest message's handle is its transcript row's uuid: the trigger the build waits for.
        // `auto` (requirement 14, ruled) tells the build whether to end the block with Claude Code's
        // own native continue sentence, after its framing; a manual `/compact` gets none.
        { stdin: JSON.stringify({ session_id: session, trigger: e.messages.at(-1)?.handle, auto: e.trigger === "auto" }) }), "Trace Memory compaction"));
      if (!built.passThrough) {
        if (typeof built.text !== "string" || !built.text) throw new Error("compaction returned no block");
        if (session !== await $.session.id()) throw new Error("native session changed during compaction");
        // 73: omitted unprocessed material is announced in the foreground, never sent to the model.
        if (typeof built.warning === "string") try { $.ui.log(built.warning); }
        catch (error) { console.error(`Trace Memory compaction warning: ${String(error)}`); }
        return { messages: [{ role: "user", text: built.text, toolUses: [] }] };
      }
    } catch (error) {
      console.error(`Trace Memory compaction: ${String(error)}`);
    }
    return nativeCompaction($, e, next, session);
  });

  on("session.start", async ($: any, e: any, next: any) => {
    try {
      pluginRoot = $.plugin.root;
      if (!pluginRoot) throw new Error("Claude Code plugin root is unavailable");
      const output = await $.process.run(["claude", "--version"]);
      const seen = decode(output, "Claude Code version").split(/\s+/)[0];
      if (seen !== PINNED_VERSION) throw new Error(`version mismatch, pinned ${PINNED_VERSION}, running ${seen}`);
    } catch (error) {
      versionError = `Trace Memory: ${String(error)} — /trace disabled`;
      await $.ui.status(versionError);
    }
    if (!versionError) {
      try { await $.command.register({ name: "trace", description: "Open the local Trace Memory menu" }); }
      catch (error) { await $.ui.status(`Trace Memory: /trace registration failed: ${String(error)}`); }
    }
    return next(e);
  });

  // Unlike session.start, this handler is awaited before the main model request. Command SessionStart
  // has already published the binding by then; re-read the live identity on every step (also after /clear).
  on("turn.step", async function* ($: any, e: any, next: any) {
    if (e.agentId || versionError) return yield* next(e);
    const session = await $.session.id();
    const root = $.plugin.root;
    if (!root) throw new Error("Trace Memory: Claude Code plugin root is unavailable");
    const result = await $.process.run(["node", `${root}/dist/cc.cjs`, "hook-capable", "--config", `${root}/cc.config.json`],
      { stdin: JSON.stringify({ session_id: session }) });
    if (result.exitCode !== 0) throw new Error(`Trace Memory function hook registration: ${String(result.stderr || `exit ${result.exitCode}`)}`);
    if (session !== await $.session.id()) throw new Error("Trace Memory: native session changed during function hook registration");
    return yield* next(e);
  });

  on("tool.call", async ($: any, e: any, next: any) => {
    const name = String(e.tool).match(/^mcp__(?:traceMemory|plugin_trace-memory_traceMemory)__(note|memory)$/)?.[1];
    if (!name || !e.agentId || versionError) return next(e);
    const allowed = await forkEvent($, await $.session.id(), "fork-call", { agentId: e.agentId, callId: e.tool_use_id, name });
    return allowed ? next(e) : { deny: "CC Noter fork identity is not registered for this call" };
  });
  on("tool.check", async ($: any, e: any, next: any) => {
    const name = String(e.tool).match(/^mcp__(?:traceMemory|plugin_trace-memory_traceMemory)__(note|memory)$/)?.[1];
    if (!name || versionError) return next(e);
    const allowed = await forkEvent($, await $.session.id(), "fork-check", { callId: e.tool_use_id, name });
    return allowed ? { decision: "allow" } : next(e);
  });

  on("turn.complete", async ($: any, e: any, next: any) => {
    if (e.agentId && !versionError) {
      try { await forkEvent($, await $.session.id(), "fork-terminal", { agentId: e.agentId, reason: e.reason, answer: e.answer ?? "" }); }
      catch (error) { console.error(`Trace Memory fork terminal: ${String(error)}`); }
    }
    if (!e.agentId && !versionError) {
      try {
        const session = await $.session.id();
        let observation: any = { refused: "CC fork source coverage or native capacity is unavailable" };
        let sources: any;
        try {
          const view = await $.process.run(["node", `${$.plugin.root}/dist/cc.cjs`, "hook-sources", "--config", `${$.plugin.root}/cc.config.json`],
            { stdin: JSON.stringify({ session_id: session, turnId: e.turnId }) });
          if (view.exitCode !== 0) throw new Error(String(view.stderr || `exit ${view.exitCode}`));
          sources = JSON.parse(view.stdout);
        } catch (error) { observation = { failed: `CC fork source read failed: ${String(error)}` }; }
        if (sources && !observation.failed) {
          observation = {};
          let api: unknown, usage: any;
          try { [api, usage] = await Promise.all([$.session.messages({ as: "api" }), $.session.usage({ breakdown: "summary" })]); }
          catch (error) { observation = { refused: `CC native parent view unavailable: ${String(error)}` }; }
          if (!observation.refused) {
            if (session !== await $.session.id()) observation = { refused: "native session changed during fork source check" };
            else {
              try {
                const raw = ccOriginalRaw(sources.selected, api);
                const measure = usage?.context?.breakdown;
                if (typeof measure?.model !== "string" || !Number.isSafeInteger(measure.maxTokens) ||
                    !Number.isSafeInteger(measure.totalTokens) || measure.maxTokens <= 0 || measure.totalTokens < 0)
                  observation = { refused: "native parent model, window or prefix usage is unavailable" };
                else {
                  observation = { checkpoint: { sessionId: sources.sessionId, branch: sources.branch,
                    headTurnId: sources.headTurnId, tailId: sources.tailId },
                    batch: sources.selected.map((source: any) => source.nativeId), raw: [...raw.keys()],
                    model: measure.model, window: measure.maxTokens, prefix: measure.totalTokens };
                  if (new TextEncoder().encode(JSON.stringify(observation)).length > 12_000)
                    observation = { refused: "CC fork source identities exceed the control request bound" };
                }
              } catch (error) { observation = { failed: `CC fork source matching failed: ${String(error)}` }; }
            }
          }
        }
        if (observation.failed) $.ui.log(`Trace Memory: ${observation.failed}; Noting was not started`);
        const result = await $.process.run(["node", `${$.plugin.root}/dist/cc.cjs`, "hook-turn", "--config", `${$.plugin.root}/cc.config.json`],
          { stdin: JSON.stringify({ session_id: session, turnId: e.turnId, reason: e.reason, observation }) });
        const directive = JSON.parse(decode(result, "Trace Memory turn-end check"));
        if (directive && typeof directive.prompt === "string" && directive.turnId === e.turnId) {
          let spawnedId: string | undefined;
          try {
            const spawn = await $.agent.spawn({ subagentType: "fork", prompt: directive.prompt, description: "Trace Memory Noter" });
            if (typeof spawn?.agentId === "string" && spawn.agentId) {
              spawnedId = spawn.agentId;
              if (!await forkEvent($, session, "fork-register", { turnId: e.turnId, agentId: spawn.agentId }))
                throw new Error("CC fork registration was not acknowledged");
              watchNativeFork($, session, spawn.agentId);
            } else if (spawn?.deny) {
              await forkEvent($, session, "fork-no-start", { turnId: e.turnId, reason: String(spawn.deny), confirmed: true });
            } else throw new Error("CC fork spawn did not return a registered native agent identity");
          } catch (error) {
            const reason = String(error);
            const confirmed = reason.includes("Agent type 'fork' not found");
            // A spawned agent whose registration failed is not a no-start fallback. Stop it here
            // while the original hook still owns native tools; Core must see a failed fork attempt.
            if (spawnedId) {
              try { await stopNativeFork($, session, spawnedId); }
              catch (stopError) { console.error(`Trace Memory fork physical stop unknown: ${String(stopError)}`); }
            }
            try {
              if (spawnedId) await forkEvent($, session, "fork-terminal", { agentId: spawnedId, reason: "error", answer: reason });
              else await forkEvent($, session, "fork-no-start", { turnId: e.turnId, reason, confirmed });
            }
            catch (settlement) { console.error(`Trace Memory fork launch settlement failed: ${String(settlement)}`); }
            if (!confirmed) throw error;
          }
        }
      } catch (error) {
        const message = `Trace Memory: this turn memory check failed: ${String(error)}`;
        console.error(message);
        try { $.ui.log(message); }
        catch (logError) { console.error(`Trace Memory turn-end notification failed: ${String(logError)}`); }
      }
    }
    return next(e);
  });

  on("command.run", { command: "trace" }, async ($: any, e: any, next: any) => {
    if (versionError) return { text: versionError };
    try {
      screen = "main";
      notice = "";
      const loaded = await load($);
      reply = loaded.data;
      activeSession = loaded.session;
      // Classification and display use the same summary's model and category estimates.
      breakdown = loaded.breakdown;
      const text = renderTraceMenuText(renderCurrent());
      await $.ui.open({ id, title: "Trace Memory", focus: true, closeOnEscape: true, rows: 45, columns: DOCK_COLUMNS });
      return { text };
    } catch (error) {
      return { text: `Trace Memory: ${String(error)}` };
    }
  });

  on("ui.render", { component: "Pane" }, ($: any, e: any, next: any) => {
    if (e.requestId !== id) return next(e);
    const { Box, Text, Select, Input } = $.ui.resolve(e);
    if (Number.isFinite(e.props?.bodyColumns) && e.props.bodyColumns > 0) {
      paneWidth = e.props.bodyColumns;
      if (breakdown) breakdown = { ...breakdown, terminalWidth: paneWidth };
    }
    if (!reply) return <Text>{notice || "Trace Memory: unavailable"}</Text>;
    const menu = renderCurrent();
    const reload = async () => {
      const loaded = await load($);
      reply = loaded.data;
      activeSession = loaded.session;
      breakdown = loaded.breakdown;
      $.ui.invalidate("ui.render");
    };
    const run = async (verb: string, args: string[] = []) => {
      const session = await $.session.id();
      if (session !== activeSession) throw new Error("native session changed; reopen /trace");
      const result = await $.process.run(["node", `${pluginRoot}/dist/cc.cjs`, "cli", "--config", `${pluginRoot}/cc.config.json`, "--session", session, verb, ...args]);
      return decode(result, `Trace Memory ${verb}`);
    };
    const act = async (verb: string, args: string[] = []) => {
      try { notice = await run(verb, args); await reload(); }
      catch (error) { notice = String(error); $.ui.invalidate("ui.render"); }
    };
    const actions = menu.actions;
    const back = { value: "back", label: "Back" };
    const chooseAction = (value: string) => {
      if (value === "settings" || value === "project") {
        screen = value; $.ui.invalidate("ui.render"); return;
      }
      if (value === "runs") {
        void (async () => {
          try {
            const rows = JSON.parse(await run("runs", ["--json", String(runsLimit)])) as { runs: Reply["runs"] };
            reply!.runs = rows.runs;
            screen = "runs"; $.ui.invalidate("ui.render");
          } catch (error) { notice = String(error); $.ui.invalidate("ui.render"); }
        })();
        return;
      }
      if (value === "turn-on" || value === "turn-off") {
        selectedAction = value; screen = "confirm"; $.ui.invalidate("ui.render"); return;
      }
      if (value === "catch-up") void act("catchup");
      else if (value === "stop") void act("stop");
    };
    const message = notice ? <Text>{notice}</Text> : null;
    if (screen === "main") {
      const ctx = menu.context;
      return <Box flexDirection="column">
        <Text>{menu.header}</Text><Text> </Text>
        {ctx ? <Box flexDirection={ctx.sideBySide ? "row" : "column"}>
          <Box flexDirection="column">{ctx.gridRows.map((row, i) =>
            <Box flexDirection="row" key={`grid-${i}`}>{row.map((cell, j) => <Text key={`cell-${i}-${j}`} color={cell.color}>{`${cell.glyph} `}</Text>)}</Box>)}</Box>
          <Box flexDirection="column" marginLeft={ctx.sideBySide ? 2 : 0}>
            {ctx.headerLines.map((line, i) => <Text key={`heading-${i}`}>{line}</Text>)}
            <Text> </Text><Text>{ctx.legendHeading}</Text>
            {ctx.legend.map((row, i) => <Text key={`legend-${i}`}><Text color={row.color}>{row.glyph}</Text>{" "}<Text bold>{`${row.label}:`}</Text>{` ${row.tokensLabel}${row.suffix} (${row.percent})`}</Text>)}
            {ctx.memoryUnavailable ? <Text>{ctx.memoryUnavailable}</Text> : null}
          </Box>
        </Box> : <Text>{menu.contextUnavailable}</Text>}
        <Text> </Text><Text>{menu.pendingHeading}</Text>
        {menu.pendingLines.map((line, i) => <Text key={`pending-${i}`}>{line}</Text>)}
        <Text> </Text>{menu.spendLines.map((line, i) => <Text key={`spend-${i}`}>{line}</Text>)}
        {menu.notices.map((line, i) => <Text key={`notice-${i}`}>{`! ${line}`}</Text>)}
        {message}<Select key="actions" label="Action" options={actions} autoFocus onSelect={chooseAction} />
      </Box>;
    }
    if (screen === "settings") {
      const settings = renderTraceSettings(reply.settings);
      return <Box flexDirection="column"><Text>{settings.header}</Text><Text> </Text>
        <Text>Knowledge budgets</Text>{settings.budgetLines.map((line, i) => <Text key={`budget-${i}`}>{line}</Text>)}
        <Text>{settings.derivedLine}</Text><Text> </Text><Text>{settings.workerHeader}</Text>
        {settings.workerLines.map((line, i) => <Text key={`worker-${i}`}>{line}</Text>)}
        <Text>{settings.closedSessionsLine}</Text>{message}
        <Select key="setting-rows" label="Edit" options={[...buildSettingsChoices(reply.settings).map(row => ({ value: row.id, label: row.label })), back]}
          autoFocus onSelect={(value: SettingsRowId | "back") => {
            if (value === "back") screen = "main";
            else { selectedSetting = value; screen = "edit"; }
            $.ui.invalidate("ui.render");
          }} />
      </Box>;
    }
    if (screen === "runs") return <Box flexDirection="column"><Text>Trace Memory · Runs</Text>
      {reply.runs.map((run, i) => <Text key={`run-${i}`}>{`R${run.id} ${run.phase} ${run.status} $${run.cost.toFixed(2)} ${run.at}`}</Text>)}
      <Input key="run-count" label={MENU_INPUTS.runs} onSubmit={(value: string) => {
        try { runsLimit = parseRunsCount(value); }
        catch (error) { notice = String(error); $.ui.invalidate("ui.render"); return; }
        void (async () => {
          try {
            const rows = JSON.parse(await run("runs", ["--json", String(runsLimit)])) as { runs: Reply["runs"] };
            reply!.runs = rows.runs;
            notice = `Showing ${rows.runs.length} recent runs`;
          } catch (error) { notice = String(error); }
          $.ui.invalidate("ui.render");
        })();
      }} />{message}<Select key="runs-back" label="Action" options={[back]} onSelect={() => { screen = "main"; $.ui.invalidate("ui.render"); }} />
    </Box>;
    if (screen === "project") return <Box flexDirection="column"><Text>{MENU_INPUTS.project}</Text>
      <Input key="project-name" label="Project" autoFocus onSubmit={(name: string) => {
        if (!name.trim()) { screen = "main"; $.ui.invalidate("ui.render"); return; }
        screen = "main"; void act("project", [name.trim()]);
      }} />{message}<Select key="project-back" label="Action" options={[back]} onSelect={() => { screen = "main"; $.ui.invalidate("ui.render"); }} />
    </Box>;
    if (screen === "confirm") {
      const confirmation = toggleConfirmation(selectedAction === "turn-on", !!reply.menu.notices.find(n => n.includes("Shared identity")));
      return <Box flexDirection="column"><Text>{confirmation.title}</Text><Text>{confirmation.message}</Text>
        <Select key="confirm" label="Confirm" autoFocus options={[{ value: "yes", label: "Yes" }, { value: "no", label: "No" }]}
          onSelect={(value: string) => { screen = "main"; if (value === "yes") void act(selectedAction === "turn-on" ? "on" : "off"); else $.ui.invalidate("ui.render"); }} />
      </Box>;
    }
    const row = selectedSetting;
    if (!row) throw new Error("Trace Memory: no setting selected");
    const label = buildSettingsChoices(reply.settings).find(choice => choice.id === row)?.label ?? row;
    if (row === "noting.mode") return <Box flexDirection="column"><Text>{label}</Text>
      <Select key="noting-mode" label="Noter mode" autoFocus
        options={["subagent", "fork"].map(value => ({ value, label: value }))}
        onSelect={(value: string) => {
          void (async () => {
            try {
              const result = JSON.parse(await run("setting", [row, value])) as { saved: boolean; applied: boolean; diagnostic?: string };
              notice = `Setting ${result.saved ? "saved" : "not saved"}; ${result.applied ? "applied" : "not applied"}${result.diagnostic ? `: ${result.diagnostic}` : ""}`;
              if (result.saved && result.applied) await reload(); else $.ui.invalidate("ui.render");
            } catch (error) { notice = String(error); $.ui.invalidate("ui.render"); }
            screen = "settings"; $.ui.invalidate("ui.render");
          })();
        }} />
      <Select key="mode-back" label="Action" options={[back]} onSelect={() => { screen = "settings"; $.ui.invalidate("ui.render"); }} />
    </Box>;
    if (row === "closedSessionScope") return <Box flexDirection="column"><Text>{label}</Text>
      <Select key="scope-choice" label="Closed sessions" autoFocus
        options={["off", "project", "global"].map(value => ({ value, label: value }))}
        onSelect={(value: string) => {
          void (async () => {
            try {
              const output = await run("setting", [row, value]);
              const result = JSON.parse(output) as { saved: boolean; applied: boolean; diagnostic?: string };
              notice = `Setting ${result.saved ? "saved" : "not saved"}; ${result.applied ? "applied" : "not applied"}${result.diagnostic ? `: ${result.diagnostic}` : ""}`;
              if (result.saved && result.applied) await reload(); else $.ui.invalidate("ui.render");
            } catch (error) { notice = String(error); $.ui.invalidate("ui.render"); }
            screen = "settings"; $.ui.invalidate("ui.render");
          })();
        }} />
      <Select key="scope-back" label="Action" options={[back]} onSelect={() => { screen = "settings"; $.ui.invalidate("ui.render"); }} />
    </Box>;
    return <Box flexDirection="column"><Text>{label}</Text>
      <Input key={`edit-${row}`} label={row.endsWith(".model") ? "Model and optional capacity (model capacity)" : "New value"} autoFocus
        onSubmit={(value: string) => {
          const parts = row.endsWith(".model") ? value.trim().split(/\s+/) : [value.trim()];
          if (!parts[0]) { screen = "settings"; $.ui.invalidate("ui.render"); return; }
          void (async () => {
            try {
              const output = await run("setting", [row, ...parts]);
              const result = JSON.parse(output) as { saved: boolean; applied: boolean; diagnostic?: string };
              notice = `Setting ${result.saved ? "saved" : "not saved"}; ${result.applied ? "applied" : "not applied"}${result.diagnostic ? `: ${result.diagnostic}` : ""}`;
              if (result.saved && result.applied) await reload(); else $.ui.invalidate("ui.render");
            } catch (error) { notice = String(error); $.ui.invalidate("ui.render"); }
            screen = "settings"; $.ui.invalidate("ui.render");
          })();
        }} />{message}<Select key="edit-back" label="Action" options={[back]} onSelect={() => { screen = "settings"; $.ui.invalidate("ui.render"); }} />
    </Box>;
  });
};
