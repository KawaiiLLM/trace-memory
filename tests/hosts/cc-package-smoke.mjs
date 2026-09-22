import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
// Leave room for the control socket beneath macOS's long per-user temporary directory.
const temporary = mkdtempSync(join(tmpdir(), "tmcc-"));
try {
  execFileSync(process.execPath, [join(root, "scripts/build-cc.mjs")], { cwd: root, stdio: "pipe" });
  const builtOutput = join(root, "plugin/dist/cc.cjs"), lastGood = readFileSync(builtOutput, "utf8");
  const { buildCc } = await import(`${new URL("../../scripts/build-cc.mjs", import.meta.url).href}?failure-preservation=${Date.now()}`);
  await assert.rejects(buildCc(async options => {
    writeFileSync(options.outfile, "incomplete replacement");
    throw new Error("synthetic compile failure");
  }), /synthetic compile failure/);
  assert.equal(readFileSync(builtOutput, "utf8"), lastGood, "failed build must preserve the last good artifact");
  const plugin = join(temporary, "plugin"); cpSync(join(root, "plugin"), plugin, { recursive: true });
  assert.match(readFileSync(join(plugin, "README.md"), "utf8"), /Node >=24\.6\.0/);
  const defaults = JSON.parse(readFileSync(join(plugin, "cc.config.json"), "utf8"));
  for (const [modelKey, thinkingKey, model] of [
    ["notingModel", "notingThinking", "sonnet"],
    ["consolidationModel", "consolidationThinking", "opus"],
    ["dreaming.model", "dreaming.thinking", "opus"],
  ]) {
    assert.equal(defaults[modelKey], model);
    assert.equal(defaults[thinkingKey], "high");
    assert.equal(defaults.worker.contextWindows[model], null, "each model capacity requires explicit preparation");
  }
  for (const retired of ["model", "effort", "contextWindow"])
    assert.equal(Object.hasOwn(defaults.worker, retired), false, `retired shared worker.${retired} must not ship`);
  assert.equal(Object.hasOwn(defaults, "dbPath"), false, "CC shares Pi's default database without sharing model preferences");
  const skill = readFileSync(join(plugin, "skills/trace/SKILL.md"), "utf8");
  assert.match(skill, /^---\nname: trace\n/);
  assert.match(skill, /disable-model-invocation: true/);
  for (const parameter of ["${CLAUDE_PLUGIN_ROOT}", "${CLAUDE_SESSION_ID}", "$ARGUMENTS"])
    assert.ok(skill.includes(parameter), `operator skill must receive ${parameter} from the native host`);
  assert.ok(skill.includes("catchup"));
  assert.ok(skill.includes("dist/cc.cjs"));
  assert.equal(/^allowed-tools:/m.test(skill), false, "operator skill must retain normal native tool permissions");
  assert.match(readFileSync(join(plugin, "dist/cc.cjs"), "utf8"), /Trace Memory CC requires Node >=24\.6\.0/);
  assert.equal(readFileSync(join(plugin, "dist/cc.cjs"), "utf8").includes(root), false, "bundle must not contain a checkout path");
  for (const phrase of ["You are the Noter", "You are the Consolidator", "You are the Dreamer"])
    assert.ok(readFileSync(join(plugin, "dist/cc.cjs"), "utf8").includes(phrase), `missing bundled prompt: ${phrase}`);
  const hooks = JSON.parse(readFileSync(join(plugin, "hooks/hooks.json"), "utf8"));
  assert.equal(hooks.hooks.SessionStart[0].hooks.length, 1);
  assert.equal(hooks.hooks.SessionEnd[0].hooks.length, 1);
  const session = "packed-smoke", transcript = join(temporary, "transcript.jsonl"), database = join(temporary, "memory.sqlite");
  mkdirSync(join(temporary, "worker-cwd"));
  writeFileSync(join(plugin, "cc.config.json"), JSON.stringify({ dbPath: database, stateDir: join(temporary, "state"),
    baseline: "2025-01-01T00:00:00.000Z", pollIntervalMs: 20, finalSyncTimeoutMs: 100, finalSyncStablePolls: 1 }));
  writeFileSync(transcript, [
    { uuid: "u1", parentUuid: null, type: "user", timestamp: "2026-01-01T00:00:00.000Z", promptId: "p1", promptSource: "typed", userType: "external", message: { role: "user", content: "hello" } },
    { uuid: "a1", parentUuid: "u1", type: "assistant", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "answer" }] } },
    { type: "last-prompt", leafUuid: "a1" },
  ].map(value => `${JSON.stringify(value)}\n`).join(""));
  const entry = join(plugin, "dist/cc.cjs"), config = join(plugin, "cc.config.json");
  const hookInput = JSON.stringify({ hook_event_name: "SessionStart", source: "startup", session_id: session, transcript_path: transcript });
  const hookStarted = performance.now();
  execFileSync(process.execPath, [entry, "hook", "--config", config], { input: hookInput, env: { CLAUDE_PLUGIN_ROOT: plugin }, timeout: 10_000 });
  const hookLatencyMs = performance.now() - hookStarted;
  assert.match(execFileSync(process.execPath, [entry, "cli", "--config", config, "--session", session, "on"], { encoding: "utf8" }), /"enrollment":"enabled"/);
  const mcpStarted = performance.now();
  const child = spawn(process.execPath, [entry, "mcp", "--config", config], { env: { CLAUDE_PLUGIN_ROOT: plugin, CLAUDE_CODE_SESSION_ID: session }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = ""; child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", value => stdout += value); child.stderr.on("data", value => stderr += value);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } })}\n`);
  let mcpInitLatencyMs;
  try {
    await new Promise((resolveReady, reject) => {
      const deadline = setTimeout(() => { clearInterval(poll); reject(new Error(`packed MCP did not initialize: ${stderr}`)); }, 5_000);
      const poll = setInterval(() => { if (stdout.includes('"id":1')) { clearTimeout(deadline); clearInterval(poll); resolveReady(); } }, 10);
    });
    mcpInitLatencyMs = performance.now() - mcpStarted;
    // Initialization replies before executor attachment. Wait for the authoritative control socket,
    // not a fixed sleep, then exercise the copied CLI's new command without configuring a provider.
    const bindingPath = join(temporary, "state/bindings", `${session}.json`);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !JSON.parse(readFileSync(bindingPath, "utf8")).executor)
      await new Promise(resolveReady => setTimeout(resolveReady, 10));
    assert.ok(JSON.parse(readFileSync(bindingPath, "utf8")).executor, `packed MCP executor did not attach: ${stderr}`);
    const catchup = JSON.parse(execFileSync(process.execPath,
      [entry, "cli", "--config", config, "--session", session, "catchup"], { encoding: "utf8", timeout: 5_000 }));
    assert.equal(catchup.command, "catchup");
    assert.equal(catchup.control.state, "acknowledged");
    assert.equal(catchup.control.reply.verb, "catchup");
    assert.equal(catchup.control.reply.catchup.state, "failed");
    assert.match(catchup.control.reply.catchup.diagnostic, /not configured/);
  } finally {
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) await new Promise((resolveExit, reject) => {
      const deadline = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`packed MCP did not stop: ${stderr}`)); }, 5_000);
      child.once("exit", code => { clearTimeout(deadline); code === 0 || code === 1 ? resolveExit() : reject(new Error(`packed MCP exit ${code}: ${stderr}`)); });
    });
  }
  assert.match(stdout, /"serverInfo":\{"name":"trace-memory"/);
  assert.equal(readFileSync(join(plugin, "dist/cc.cjs"), "utf8").includes("@earendil-works/pi-coding-agent"), false);
  console.log(`Packed CC smoke passed: ${readFileSync(entry).byteLength} bytes, copied outside checkout, Hook/CLI/MCP loaded without node_modules; Hook ${hookLatencyMs.toFixed(1)} ms, MCP init ${mcpInitLatencyMs.toFixed(1)} ms.`);
} finally { rmSync(temporary, { recursive: true, force: true }); }
