import { convertToLlm, formatSkillsForPrompt, sessionEntryToContextMessages, type ExtensionAPI, type ExtensionContext, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { memoryBodyHash, tokens } from "../../core/api/index.ts";

export type ContextComposition = ReturnType<typeof contextComposition>;
const valid = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
const validPart = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};

/** One read-only snapshot of Pi's selected, rebuilt text, not provider wire or a tokenizer bill.
 * Coverage identities, project applicability and database contents have no role in this census. */
export function contextComposition(ctx: ExtensionContext & Partial<Pick<ExtensionCommandContext, "getSystemPromptOptions">>, pi: Pick<ExtensionAPI, "getActiveTools" | "getAllTools">) {
  const amounts = { System: 0, Tools: 0, Skills: 0, Memory: 0, Conversation: 0, Other: 0 };
  const memory = { Knowledge: 0, Facts: 0, Raw: 0, Unclassified: 0 };
  let complete = true;
  try {
    const system = ctx.getSystemPrompt();
    amounts.System = tokens(system);
    // Only an unambiguous, byte-exact occurrence establishes a catalog actually in this prompt.
    // Modified/removed catalogs remain System, rather than guessed or counted twice.
    let catalog = "";
    try {
      const options = ctx.getSystemPromptOptions?.();
      // Pi's native prompt builder prefers read, falls back to bash, and omits the
      // catalog if neither is selected. Missing selectedTools uses Pi's read default.
      const reader = (["read", "bash"] as const).find(tool => (options?.selectedTools ?? ["read", "bash", "edit", "write"]).includes(tool));
      if (reader) catalog = formatSkillsForPrompt(options?.skills ?? [], reader);
    } catch { /* Uncertain catalog stays System. */ }
    const at = catalog ? system.indexOf(catalog) : -1;
    if (at >= 0 && system.indexOf(catalog, at + catalog.length) < 0) {
      const skills = tokens(catalog);
      if (skills <= amounts.System) { amounts.Skills = skills; amounts.System -= skills; }
    }
  } catch { complete = false; }
  try {
    const active = new Set(pi.getActiveTools());
    for (const tool of pi.getAllTools()) if (active.has(tool.name))
      amounts.Tools += tokens(JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }));
  } catch { complete = false; }
  try {
    for (const entry of ctx.sessionManager.buildContextEntries()) {
      for (const message of sessionEntryToContextMessages(entry)) {
        const converted = convertToLlm([message]);
        if (!converted.length) continue; // !! executions are not context.
        const details = record(message.role === "custom" ? message.details : "details" in entry ? entry.details : undefined);
        const carrier = record(details.traceMemory);
        const isMemory = message.role === "custom" && message.customType === "trace-memory"
          || (message.role === "compactionSummary" || message.role === "branchSummary") && Object.keys(carrier).length > 0;
        let amount = 0;
        for (const m of converted) {
          if (typeof m.content === "string") amount += tokens(m.content);
          else for (const part of m.content) {
            if (part.type === "text") amount += tokens(part.text);
            else if (part.type === "thinking") amount += tokens(part.thinking);
            else if (part.type === "toolCall") amount += tokens(part.name + JSON.stringify(part.arguments));
            else complete = false; // Non-text capacity cannot be measured from a text census.
          }
        }
        if (!isMemory) { amounts[message.role === "custom" ? "Other" : "Conversation"] += amount; continue; }
        amounts.Memory += amount;
        const body = message.role === "compactionSummary" || message.role === "branchSummary" ? message.summary
          : message.role === "custom" && typeof message.content === "string" ? message.content : undefined;
        const parts = record(carrier.composition);
        const values = [parts.knowledge, parts.facts, parts.raw];
        const classified = values.every(validPart) ? (values as number[]).reduce((sum, n) => sum + n, 0) : Infinity;
        if (body !== undefined && parts.bodyHash === memoryBodyHash(body) && classified <= tokens(body)) {
          memory.Knowledge += parts.knowledge as number; memory.Facts += parts.facts as number; memory.Raw += parts.raw as number;
          memory.Unclassified += amount - classified;
        } else memory.Unclassified += amount;
      }
    }
  } catch { complete = false; }
  const measured = Object.values(amounts).reduce((sum, n) => sum + n, 0);
  let window = ctx.model?.contextWindow;
  let sdkTokens: number | undefined;
  try {
    const usage = ctx.getContextUsage();
    if (valid(usage?.contextWindow) && usage.contextWindow > 0) window = usage.contextWindow;
    if (valid(usage?.tokens)) sdkTokens = usage.tokens;
  } catch { /* Pi's usage is optional; the text census remains usable. */ }
  // Keep the signed SDK/text difference out of the local category total.
  return { amounts, memory, complete, sdkTokens,
    sdkDifference: sdkTokens === undefined ? undefined : sdkTokens - measured,
    window: valid(window) && window > 0 ? window : undefined, total: measured };
}
