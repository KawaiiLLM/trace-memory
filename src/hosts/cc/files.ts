// 101: the `/tm` read-only files for Claude Code. The `tool.call` function hook answers Read, Grep and
// Glob on `/tm` by running `cc.cjs fs … <op> <args>` through `$.process.run` (`$.http.fetch` is refused
// when nonessential traffic is disabled), in a process of its own so a long search never holds the
// executor's event loop. The reader is the native session's bound core path; nothing is imported or
// recorded.
import { TraceMemory, memoryFiles, type MemoryGrepOptions, type MemoryReader } from "../../core/api/index.ts";
import { readBinding, validateNativeSessionId } from "./binding.ts";
import type { ResolvedCcHostConfig } from "./config.ts";
import { ccResultText } from "./transcript.ts";

const usage = "fs read <path> [offset] [limit] | fs grep [-i] [-n] [-c] [-F] [-A|-B|-C <n>] [--glob <g>] [--offset <n>] [--limit <n>] [--] <pattern> [path] | fs glob <pattern>";
const integer = (value: string | undefined, name: string) => {
  const number = Number(value);
  if (value === undefined || !Number.isSafeInteger(number) || number < 0) throw new Error(`${name} must be a non-negative integer`);
  return number;
};

/** Grep's command line, short flags combinable (`-in`, `-inC2`): -i ignore case, -n matching lines,
 * -c counts, -F literal, -A/-B/-C context lines. The default lists matching files. */
export function parseGrepArgs(args: readonly string[]): { pattern: string; path: string; options: MemoryGrepOptions } {
  const options: MemoryGrepOptions = {}, rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") { rest.push(...args.slice(i + 1)); break; }
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
      else if (flag === "n") options.mode = "content";
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
  const [pattern, path = "/tm", ...extra] = rest;
  if (pattern === undefined || extra.length) throw new Error(usage);
  return { pattern, path, options };
}

/** One `/tm` operation for a native session, as JSON: a read page, or grep/glob listing lines. */
export function runCcFiles(config: ResolvedCcHostConfig, nativeSessionId: string, [op, ...args]: readonly string[]): unknown {
  const binding = readBinding(config, validateNativeSessionId(nativeSessionId));
  const memory = TraceMemory(config.dbPath, async () => { throw new Error("/tm reads run no model work"); }, config.coreConfig, ccResultText);
  try {
    const core = binding?.dbPath === config.dbPath ? binding.coreSessionId : null;
    const reader: MemoryReader = core !== null && memory.store.getSession(core)
      ? { ...memory.store.knowledgePath(core, binding!.branch), projectId: memory.store.getSession(core)!.projectId }
      : { ...(binding?.dbPath === config.dbPath && binding.projectId !== null ? { projectId: binding.projectId } : {}) };
    const files = memoryFiles(memory, reader);
    if (op === "read") {
      const [path, offset, limit, ...extra] = args;
      if (!path || extra.length) throw new Error(usage);
      return files.read(path, offset === undefined ? undefined : integer(offset, "offset"), limit === undefined ? undefined : integer(limit, "limit"));
    }
    if (op === "grep") { const { pattern, path, options } = parseGrepArgs(args); return files.grep(pattern, path, options); }
    if (op === "glob") { if (args.length !== 1) throw new Error(usage); return files.glob(args[0]!); }
    throw new Error(`${op === "write" || op === "edit" ? `${op}: /tm is read-only` : `unknown operation ${String(op)}`}; ${usage}`);
  } finally {
    // A reader owns no executor or claim: close the Store alone, so reading writes nothing.
    memory.store.close();
  }
}
