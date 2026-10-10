// Claude Code renders trace:// through the native session's bound reader. No conversation is imported
// and no delivery is recorded. Each virtual-path Read renders anew for native pagination.
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { TraceMemory, memoryFiles, memoryPath, MEMORY_ROOT, type MemoryReader } from "../../core/api/index.ts";
import { readBinding, validateNativeSessionId } from "./binding.ts";
import type { ResolvedCcHostConfig } from "./config.ts";
import { ccResultText, ccHumanUser } from "./transcript.ts";
import { ccPluginToolNames, ccWorkerToolNames } from "./tool-names.ts";

const usage = "fs read <path> | fs materialize <path>";

function materializeCcRead(directory: string, content: string, virtualPath?: string): string {
  // The directory may not exist yet: a session's first render, or a worker's first saved output.
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Main reads share one file per normalized virtual path; fresh workers keep their per-run files.
  const target = virtualPath === undefined ? join(mkdtempSync(join(directory, "read-")), "memory.txt")
    : join(directory, ...virtualPath.slice(MEMORY_ROOT.length).split("/").filter(Boolean), "memory.txt");
  const parent = dirname(target);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomUUID()}`;
  try {
    writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
    renameSync(temporary, target);
  } catch (error) { rmSync(temporary, { force: true }); throw error; }
  return target;
}

/** Ticket 136: an over-long `search` output, saved beside the native session's rendered `trace://` reads
 * (same directory, removed when the session closes) so the model can Read the rest of it. */
export function spillCcOutput(config: ResolvedCcHostConfig, nativeSessionId: string, text: string): string {
  return materializeCcRead(join(config.stateDir, "rendered", validateNativeSessionId(nativeSessionId)), text);
}

/** Ticket 136: an over-long `search` output of a fresh Noter or Dreamer, saved in that run's own render
 * directory, the only place its restricted Read reaches (worker.ts registers the returned path). */
export const saveCcWorkerOutput = (directory: string, text: string): string => materializeCcRead(directory, text);

/** A fresh worker reads with its frozen Core target, never a foreground native binding. */
export function materializeCcWorkerRead(config: ResolvedCcHostConfig, reader: MemoryReader, path: string, directory: string): string {
  const memory = TraceMemory(config.dbPath, async () => { throw new Error("trace:// reads run no model work"); }, config.coreConfig, ccResultText, undefined, ccHumanUser);
  try {
    return materializeCcRead(directory, memoryFiles(memory, { ...reader, toolNames: ccWorkerToolNames }).read(path).content);
  } finally {
    memory.store.close();
  }
}

/** One `trace://` operation for a native session, as JSON: a rendered read, or the path of its materialized file. */
export function runCcFiles(config: ResolvedCcHostConfig, nativeSessionId: string, [op, ...args]: readonly string[]): unknown {
  const binding = readBinding(config, validateNativeSessionId(nativeSessionId));
  const memory = TraceMemory(config.dbPath, async () => { throw new Error("trace:// reads run no model work"); }, config.coreConfig, ccResultText, undefined, ccHumanUser);
  try {
    const core = binding?.dbPath === config.dbPath ? binding.coreSessionId : null;
    const reader: MemoryReader = core !== null && memory.store.getSession(core)
      ? { ...memory.store.knowledgePath(core, binding!.branch), projectId: memory.store.getSession(core)!.projectId }
      : { ...(binding?.dbPath === config.dbPath && binding.projectId !== null ? { projectId: binding.projectId } : {}) };
    const files = memoryFiles(memory, { ...reader, toolNames: ccPluginToolNames });
    if (op === "read" || op === "materialize") {
      if (args.length !== 1) throw new Error(usage);
      const rendered = files.read(args[0]!);
      if (op === "read") return rendered;
      // Native Read receives a physical file for this call. A later trace:// call renders afresh,
      // including one made with offset/limit; no snapshot path is exposed to the model.
      const virtual = memoryPath(args[0]!);
      if (virtual === null) throw new Error("materialize requires a trace:// address");
      return { path: materializeCcRead(join(config.stateDir, "rendered", validateNativeSessionId(nativeSessionId)), rendered.content, virtual) };
    }
    throw new Error(`${op === "write" || op === "edit" ? `${op}: trace:// is read-only` : `unknown operation ${String(op)}`}; ${usage}`);
  } finally {
    // A reader owns no executor or claim: close the Store alone, so reading writes nothing.
    memory.store.close();
  }
}
