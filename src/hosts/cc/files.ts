// Claude Code renders trace:// through the native session's bound reader. No conversation is imported
// and no delivery is recorded. Each virtual-path Read renders anew for native pagination.
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { TraceMemory, memoryFiles, memoryPath, MEMORY_ROOT, type MemoryGrepFile, type MemoryGrepOptions, type MemoryReader } from "../../core/api/index.ts";
import { readBinding, validateNativeSessionId } from "./binding.ts";
import type { ResolvedCcHostConfig } from "./config.ts";
import { ccResultText, ccHumanUser } from "./transcript.ts";
import { ccPluginToolNames, ccWorkerToolNames } from "./tool-names.ts";

const usage = "fs read <path> | fs materialize <path> | fs grep [-i] [-n|--no-line-numbers] [-c] [-F] [-A|-B|-C <n>] [--glob <g>] [--offset <n>] [--limit <n>] [--] <pattern> [path] | fs glob <pattern>";
type CcGrepOptions = MemoryGrepOptions & { mode?: "content" | "count" | "files_with_matches"; before?: number; after?: number; offset?: number; limit?: number; lineNumbers?: boolean };
const integer = (value: string | undefined, name: string) => {
  const number = Number(value);
  if (value === undefined || !Number.isSafeInteger(number) || number < 0) throw new Error(`${name} must be a non-negative integer`);
  return number;
};

/** Grep's command line, short flags combinable (`-in`, `-inC2`): -i ignore case, -n matching lines,
 * -c counts, -F literal, -A/-B/-C context lines. The default lists matching files. */
export function parseGrepArgs(args: readonly string[]): { pattern: string; path: string; options: CcGrepOptions } {
  const options: CcGrepOptions = {}, rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") { rest.push(...args.slice(i + 1)); break; }
    if (arg === "--no-line-numbers") { options.mode = "content"; options.lineNumbers = false; continue; }
    if (arg === "--glob" || arg === "--offset" || arg === "--limit") {
      const value = args[++i];
      if (arg === "--glob") { if (!value) throw new Error("--glob needs a pattern"); options.glob = value; }
      else options[arg === "--offset" ? "offset" : "limit"] = integer(value, arg);
      continue;
    }
    if (!/^-[A-Za-z]/.test(arg)) { rest.push(arg); continue; }
    for (let j = 1; j < arg.length; j++) {
      const flag = arg[j]!;
      if (flag === "i") options.ignoreCase = true;
      else if (flag === "n") { options.mode = "content"; options.lineNumbers = true; }
      else if (flag === "c") options.mode = "count";
      else if (flag === "l") options.mode = "files_with_matches";
      else if (flag === "F") options.literal = true;
      else if (flag === "A" || flag === "B" || flag === "C") {
        const value = integer(arg.slice(j + 1) || args[++i], `-${flag}`);
        if (flag !== "A") options.before = value;
        if (flag !== "B") options.after = value;
        break;
      } else throw new Error(`unknown grep flag -${flag}; ${usage}`);
    }
  }
  const [pattern, path = MEMORY_ROOT, ...extra] = rest;
  if (pattern === undefined || extra.length) throw new Error(usage);
  if (options.lineNumbers === false && options.mode !== "content") throw new Error("--no-line-numbers requires content mode");
  return { pattern, path, options };
}

// CC 2.1.284: hOn passes --json in content mode, then SOn replaces >500 JS-code-unit
// match/context lines with these placeholders. Gwe applies offset and head_limit afterwards.
function ccGrep(files: Iterable<MemoryGrepFile>, path: string, options: CcGrepOptions) {
  const mode = options.mode ?? "files_with_matches", offset = options.offset ?? 0, limit = options.limit ?? 250;
  const all: string[] = [];
  let matches = 0, countFiles = 0;
  for (const file of files) {
    if (mode === "files_with_matches") { all.push(file.path + (file.mark ?? "")); continue; }
    if (mode === "count") {
      all.push(`${file.path}:${file.hits.length}`);
      matches += file.hits.length; countFiles++;
      continue;
    }
    const selected = new Set<number>(), hits = new Set(file.hits);
    for (const hit of file.hits)
      for (let line = Math.max(0, hit - (options.before ?? 0)); line <= Math.min(file.lines.length - 1, hit + (options.after ?? 0)); line++) selected.add(line);
    let previous = -1;
    for (const line of [...selected].sort((a, b) => a - b)) {
      if ((options.before || options.after) && (previous < 0 ? all.length > 0 : line > previous + 1)) all.push("--");
      previous = line;
      const isHit = hits.has(line), text = file.lines[line]!;
      const value = text.length > 500 ? isHit ? "[Omitted long matching line]" : "[Omitted long context line]" : text;
      const prefix = file.path === path ? "" : `${file.path}${isHit ? ":" : "-"}`;
      all.push(`${prefix}${options.lineNumbers === false ? "" : `${line + 1}${isHit ? ":" : "-"}`}${value}`);
    }
  }
  // Native Grep's file mode uses mtime, with lexicographic paths on ties. trace:// has no mtime.
  if (mode === "files_with_matches") all.sort((a, b) => a.localeCompare(b));
  const lines = limit === 0 ? all.slice(offset) : all.slice(offset, offset + limit);
  const appliedLimit = limit > 0 && all.length - offset > limit ? limit : undefined;
  const pagination = [appliedLimit === undefined ? "" : `limit: ${appliedLimit}`, offset ? `offset: ${offset}` : ""].filter(Boolean).join(", ");
  return { lines, total: all.length, matches, countFiles, pagination, appliedLimit, offset };
}

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

/** One `trace://` operation for a native session, as JSON: a read page, or grep/glob listing lines. */
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
    if (op === "grep") {
      const { pattern, path, options } = parseGrepArgs(args);
      const { mode: _mode, before: _before, after: _after, offset: _offset, limit: _limit, lineNumbers: _lineNumbers, ...coreOptions } = options;
      return ccGrep(files.grep(pattern, path, coreOptions), path, options);
    }
    if (op === "glob") { if (args.length !== 1) throw new Error(usage); return files.glob(args[0]!); }
    throw new Error(`${op === "write" || op === "edit" ? `${op}: trace:// is read-only` : `unknown operation ${String(op)}`}; ${usage}`);
  } finally {
    // A reader owns no executor or claim: close the Store alone, so reading writes nothing.
    memory.store.close();
  }
}
