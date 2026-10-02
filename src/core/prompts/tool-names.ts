export const TOOL_ROLES = ["search", "note", "memory", "check"] as const;
export type ToolRole = typeof TOOL_ROLES[number];
export type ToolNames = Readonly<Record<ToolRole | "read" | "grep", string>>;

/** Canonical names are the actual public Core/Pi registration names. Hosted workers pass their
 * own exposed names at admission; the map never changes internal routing or authorization. */
export const canonicalToolNames: ToolNames = { search: "search", note: "note", memory: "memory", check: "check", read: "read", grep: "grep" };
const NAME_ROLES = [...TOOL_ROLES, "read", "grep"] as const;

export function validateToolNames(names: ToolNames): ToolNames {
  if (!names || NAME_ROLES.some(role => typeof names[role] !== "string" || !/^[a-zA-Z][\w-]*$/.test(names[role])))
    throw new Error("Missing or invalid exposed tool name for worker launch");
  if (new Set(NAME_ROLES.map(role => names[role])).size !== NAME_ROLES.length)
    throw new Error("Worker exposed tool names must be distinct");
  return Object.freeze({ ...names });
}

/** Only explicit model-facing tool references are interpolated; ordinary prose and evidence are not. */
export function renderToolNames(text: string, names: ToolNames): string {
  return text.replace(/\{\{tool\.(search|note|memory|check|read|grep)\}\}/g, (_, role: keyof ToolNames) => names[role]);
}
