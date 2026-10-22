import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { isAbsolute, resolve, sep } from "node:path";
import { memoryPath, type MemoryFile } from "../../core/api/index.ts";
import { resolveRepositoryPath } from "../../core/dreaming/roots.ts";

/** Delegate ordinary reads to Pi, and render only `trace://` addresses from the bound reader. */
export function memoryReadTool(cwd: string, read: (path: string) => MemoryFile, options: {
  autoResizeImages?: boolean; memoryOnly?: boolean;
  /** A memory-only reader may also open files under this directory (a run's saved search output), if it is set. */
  readableDirectory?: () => string | undefined;
  /** ...and exactly these files (the Noter's workspace files). */
  readableFiles?: () => readonly string[];
  /** ...and files under these repository roots, past the one deny list (curate and verify; stage 5 §3.7). */
  readableRoots?: () => readonly string[];
} = {}) {
  const native = createReadToolDefinition(cwd, { autoResizeImages: options.autoResizeImages });
  const execute = native.execute;
  const adapted: ReturnType<typeof createReadToolDefinition> = { ...native, async execute(id, input, signal, update, context) {
    const path = memoryPath(input.path);
    if (path === null) {
      const directory = options.readableDirectory?.();
      if (options.memoryOnly && directory && isAbsolute(input.path) && resolve(input.path).startsWith(directory + sep)) return execute(id, input, signal, update, context);
      if (options.memoryOnly && isAbsolute(input.path) && options.readableFiles?.().includes(input.path)) return execute(id, input, signal, update, context);
      const roots = options.readableRoots?.() ?? [];
      if (options.memoryOnly && roots.length && isAbsolute(input.path)) {
        const resolved = resolveRepositoryPath(input.path, roots);
        if ("reason" in resolved) throw new Error(resolved.reason);
        return execute(id, { ...input, path: resolved.path }, signal, update, context);
      }
      if (options.memoryOnly) throw new Error("Trace Memory child read is restricted to trace://");
      return execute(id, input, signal, update, context);
    }
    signal?.throwIfAborted();
    // The native Read calls access and readFile separately. Cache this invocation's single rendering
    // for paginated reads, while unbounded views bypass native truncation altogether.
    const file = read(path);
    signal?.throwIfAborted();
    if (file.unbounded) return { content: [{ type: "text" as const, text: file.content }], details: undefined };
    const snapshot = createReadToolDefinition(cwd, { operations: {
      access: async () => {},
      readFile: async () => Buffer.from(file.content),
    } });
    return snapshot.execute(id, input, signal, update, context);
  } };
  return adapted;
}
