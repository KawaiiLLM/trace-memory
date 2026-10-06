import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { memoryPath, type MemoryFile } from "../../core/api/index.ts";

/** Delegate ordinary reads to Pi, and render only `trace://` addresses from the bound reader. */
export function memoryReadTool(cwd: string, read: (path: string) => MemoryFile, options: {
  autoResizeImages?: boolean; memoryOnly?: boolean;
} = {}) {
  const native = createReadToolDefinition(cwd, { autoResizeImages: options.autoResizeImages });
  const execute = native.execute;
  const adapted: ReturnType<typeof createReadToolDefinition> = { ...native, async execute(id, input, signal, update, context) {
    const path = memoryPath(input.path);
    if (path === null) {
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
