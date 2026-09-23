"use strict";

// src/hosts/cc/status-entry.ts
var import_node_fs2 = require("node:fs");
var import_node_path2 = require("node:path");

// src/hosts/phase-settings.ts
var MEMORY_PHASES = ["noting", "consolidation", "dreaming"];

// src/hosts/status-line.ts
var INDICATOR_ROLE = { noting: "accent", consolidation: "success", dreaming: "customMessageLabel" };
function memoryStatusLine(input) {
  if (!input.enabled) return [{ role: "dim", text: "\u25CB off" }];
  const runningPhase = MEMORY_PHASES.find((phase) => input.running[phase]);
  const role = runningPhase ? INDICATOR_ROLE[runningPhase] : "dim";
  const glyph = runningPhase ? "\u25CF" : "\u25CB";
  const value = (count) => count === void 0 ? "?" : String(count);
  const c = input.counts ?? {};
  const text = `notes: ${value(c.entries)}->${value(c.facts)} memory: ${value(c.unconsolidated)}->${value(c.changedKnowledge)}/${value(c.knowledge)} cost: ${input.cost === void 0 ? "$?" : `$${input.cost.toFixed(2)}`}`;
  return [{ role, text: glyph }, { role: "dim", text }];
}

// src/hosts/cc/status.ts
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");
function statusPath(stateDir, nativeSessionId) {
  return (0, import_node_path.join)(stateDir, "status", `${nativeSessionId}.json`);
}
function readCcStatus(stateDir, nativeSessionId) {
  try {
    return JSON.parse((0, import_node_fs.readFileSync)(statusPath(stateDir, nativeSessionId), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

// src/hosts/cc/status-entry.ts
var ANSI = { accent: "\x1B[36m", success: "\x1B[32m", customMessageLabel: "\x1B[35m", dim: "\x1B[2m" };
var RESET = "\x1B[0m";
var paint = (role, text) => `${ANSI[role]}${text}${RESET}`;
function executorAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function readStdin() {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  return input;
}
function resolveStateDir(configPath) {
  const raw = JSON.parse((0, import_node_fs2.readFileSync)(configPath, "utf8"));
  if (typeof raw.stateDir !== "string" || !(0, import_node_path2.isAbsolute)(raw.stateDir)) throw new Error("CC configuration stateDir must be an absolute path");
  return raw.stateDir;
}
function currentBindingExecutorToken(stateDir, nativeSessionId) {
  try {
    const binding = JSON.parse((0, import_node_fs2.readFileSync)((0, import_node_path2.join)(stateDir, "bindings", `${nativeSessionId}.json`), "utf8"));
    return typeof binding.executor?.token === "string" ? binding.executor.token : void 0;
  } catch {
    return void 0;
  }
}
async function runCcStatusCommand(io = {}) {
  const { argv = process.argv.slice(2), readStdin: read = readStdin, write = (line) => {
    process.stdout.write(line);
  } } = io;
  try {
    const [configFlag, configPath] = argv;
    if (configFlag !== "--config" || typeof configPath !== "string" || !(0, import_node_path2.isAbsolute)(configPath)) return;
    const stateDir = resolveStateDir(configPath);
    const input = JSON.parse(await read());
    if (typeof input.session_id !== "string" || !input.session_id) return;
    const status = readCcStatus(stateDir, input.session_id);
    if (!status) return;
    const owned = currentBindingExecutorToken(stateDir, input.session_id) === status.token;
    const alive = owned && executorAlive(status.pid);
    const segments = memoryStatusLine({
      enabled: status.enabled,
      running: alive ? status.running : { noting: false, consolidation: false, dreaming: false },
      counts: alive ? status.counts : void 0,
      cost: alive ? status.cost : void 0
    });
    write(`\u{1F9E0} ${segments.map((segment) => paint(segment.role, segment.text)).join(" ")}
`);
  } catch {
  }
}

// src/hosts/cc/status-bundle-entry.ts
void runCcStatusCommand();
