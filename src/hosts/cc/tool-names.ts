import { canonicalToolNames, type ToolNames } from "../../core/api/index.ts";

/** These are the MCP server identities used by the registered worker and plugin. */
export const CC_WORKER_SERVER_NAME = "trace_memory";
export const CC_PLUGIN_NAME = "trace-memory";
export const CC_MCP_SERVER_NAME = "traceMemory";

const exposed = (prefix: string): ToolNames => Object.fromEntries(
  Object.entries(canonicalToolNames).map(([role, name]) => [role, `${prefix}${name}`]),
) as unknown as ToolNames;

export const ccWorkerToolNames = exposed(`mcp__${CC_WORKER_SERVER_NAME}__`);
export const ccPluginToolNames = exposed(`mcp__plugin_${CC_PLUGIN_NAME}_${CC_MCP_SERVER_NAME}__`);
