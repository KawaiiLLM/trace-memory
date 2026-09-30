import { ccPluginToolNames } from "./tool-names.ts";
import { toolDefinitions, renderToolDefinitions, toolRejected, validateReadInput, type SearchScope, type ToolDefinition } from "../../core/api/index.ts";
import type { CcCoordinator, CcReadProjection, CcToolProjection } from "./lifecycle.ts";

export interface CcMcpToolResult {
  content: { type: "text"; text: string }[];
  isError?: true;
}

const FOREGROUND = new Set<ToolDefinition["name"]>(["trace", "search", "note", "memory"]);
/** Claude Code 2.1.257 applies this metadata limit to JavaScript UTF-16 string length. */
export const CC_MAX_RESULT_CHARS = 500_000;
const RESULT_SIZE_META = { "anthropic/maxResultSizeChars": CC_MAX_RESULT_CHARS } as const;
const writeTool = (name: string): name is "note" | "memory" => name === "note" || name === "memory";

/** The CC adapter is deliberately shallow: core owns schemas, read state and every write rule. */
export class CcForegroundTools {
  private readonly coordinator: CcCoordinator;
  constructor(coordinator: CcCoordinator) { this.coordinator = coordinator; }

  list(): { name: string; description: string; inputSchema: Record<string, unknown>; _meta: typeof RESULT_SIZE_META }[] {
    return renderToolDefinitions(toolDefinitions.filter(tool => FOREGROUND.has(tool.name)), ccPluginToolNames).map(tool => ({
      name: tool.name, description: tool.description, inputSchema: structuredClone(tool.parameters), _meta: RESULT_SIZE_META,
    }));
  }

  private toolUseId(meta: unknown): string {
    if (!meta || typeof meta !== "object" || Array.isArray(meta))
      throw new Error("source-not-ready: missing claudecode/toolUseId metadata; retry this write");
    const value = (meta as Record<string, unknown>)["claudecode/toolUseId"];
    if (typeof value !== "string" || !value)
      throw new Error("source-not-ready: missing or invalid claudecode/toolUseId metadata; retry this write");
    return value;
  }

  private boundTools(projection: CcToolProjection): ToolDefinition[] {
    return projection.memory.tools({ kind: "manual", sessionId: projection.coreSessionId, branch: projection.branch,
      currentTurnId: projection.headTurnId, triggerEntryId: projection.triggerEntryId, entryIds: projection.entryIds,
      maxReadChars: CC_MAX_RESULT_CHARS, toolNames: ccPluginToolNames });
  }

  private read(projection: CcReadProjection, name: "trace" | "search", input: unknown): string {
    if (projection.binding) return this.boundTools({ memory: projection.memory, ...projection.binding })
      .find(candidate => candidate.name === name)!.execute(input);
    const value = validateReadInput(name, input);
    const options = { ...value, modelFacing: true, toolNames: ccPluginToolNames, maxChars: CC_MAX_RESULT_CHARS };
    return name === "trace" ? projection.memory.trace(value.address as string, options)
      : projection.memory.search(value.query as string, value.layer as SearchScope | undefined, options);
  }

  async call(name: unknown, input: unknown, meta: unknown, signal?: AbortSignal): Promise<CcMcpToolResult> {
    try {
      if (typeof name !== "string" || !FOREGROUND.has(name as ToolDefinition["name"])) throw new Error(`unknown foreground tool ${String(name)}`);
      signal?.throwIfAborted();
      const callId = writeTool(name) ? this.toolUseId(meta) : null;
      const fork = callId === null ? null : this.coordinator.forkToolCall(callId, name as "note" | "memory");
      if (fork === "retired") throw new Error("CC Noter fork call has expired or already been dispatched");
      const projection = fork ? null : writeTool(name)
        ? await this.coordinator.waitForToolCall(callId!, name, signal)
        : await this.coordinator.toolProjection();
      signal?.throwIfAborted();
      fork?.signal?.throwIfAborted();
      const text = fork ? fork.tools.find(candidate => candidate.name === name)!.execute(input)
        : writeTool(name) ? this.boundTools(projection as CcToolProjection).find(candidate => candidate.name === name)!.execute(input)
        : this.read(projection as CcReadProjection, name as "trace" | "search", input);
      return { content: [{ type: "text", text }], ...(toolRejected(name, text) ? { isError: true as const } : {}) };
    } catch (error) {
      const message = (error as { name?: string }).name === "AbortError" ? "tool call cancelled"
        : error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text: `rejected: ${message}` }], isError: true };
    }
  }
}
