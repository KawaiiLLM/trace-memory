// 137: only the prompts module, so the function-hooks bundle (no Node) can import these names.
import { canonicalToolNames, TOOL_ROLES, type ToolNames } from "../../core/prompts/tool-names.ts";

/** These are the MCP server identities used by the registered worker and plugin. */
export const CC_WORKER_SERVER_NAME = "trace_memory";
export const CC_PLUGIN_NAME = "trace-memory";
export const CC_MCP_SERVER_NAME = "traceMemory";

const exposed = (prefix: string): ToolNames => ({ ...Object.fromEntries(
  TOOL_ROLES.map(role => [role, `${prefix}${canonicalToolNames[role]}`]),
), read: "Read" }) as ToolNames;

export const ccWorkerToolNames = exposed(`mcp__${CC_WORKER_SERVER_NAME}__`);
export const ccPluginToolNames = exposed(`mcp__plugin_${CC_PLUGIN_NAME}_${CC_MCP_SERVER_NAME}__`);
