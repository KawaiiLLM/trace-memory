export const TOOL_ROLES = ["trace", "search", "note", "memory", "check"] as const;
export type ToolRole = typeof TOOL_ROLES[number];
export type ToolNames = Readonly<Record<ToolRole, string>>;

/** Canonical names are the actual public Core/Pi registration names. Hosted workers pass their
 * own exposed names at admission; the map never changes internal routing or authorization. */
export const canonicalToolNames: ToolNames = { trace: "trace", search: "search", note: "note", memory: "memory", check: "check" };

export function validateToolNames(names: ToolNames): ToolNames {
  if (!names || TOOL_ROLES.some(role => typeof names[role] !== "string" || !/^[a-zA-Z][\w-]*$/.test(names[role])))
    throw new Error("Missing or invalid exposed tool name for worker launch");
  if (new Set(TOOL_ROLES.map(role => names[role])).size !== TOOL_ROLES.length)
    throw new Error("Worker exposed tool names must be distinct");
  return Object.freeze({ ...names });
}

/** Only explicit model-facing tool references are interpolated; ordinary prose and evidence are not. */
export function renderToolNames(text: string, names: ToolNames): string {
  return text.replace(/\{\{tool\.(trace|search|note|memory|check)\}\}/g, (_, role: ToolRole) => names[role]);
}
