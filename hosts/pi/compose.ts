// 19b: the Pi adapter's own layout of core's frozen task material. Core renders, budgets and freezes
// the parts (entry views, fact and knowledge lines, source index, reminders, receipts) and composes
// no message; this module is the only place that decides which parts an execution mode needs, which
// header introduces them, how they are separated and which model message carries them. Both runners
// — the request-copy runner in index.ts and the native runner in native.ts — use it, so an inherited
// fork and a fresh subagent see the same bytes for the same mode.
//
// Ruling 2026-09-06 08:53: an inherited-context run carries only its instruction, the range, the head
// reply and the frozen source index, because the raw turns, the facts delivered after earlier runs
// and the injected knowledge are already in that conversation. A fresh-context run carries the full
// rendered material.
import { finish, type ConsolidationAgentInput, type NotingAgentInput } from "../../core/api/index.ts";

export type AgentInput = NotingAgentInput | ConsolidationAgentInput;
const REMINDER = "Negated-evidence reminder (review cues only; no status derived):";

/** The task material as one text block, in the shape the given execution mode needs. */
export function composeMaterial(input: AgentInput, mode: "branch" | "subagent"): string {
  const range = `Range: ${input.range.from}..${input.range.to}`;
  if (input.kind === "noting") {
    const material = input.material;
    // The captured request precedes the head's final reply, so the fork appends that reply and the
    // source index; the index supplies addresses and previews, never a second copy of the raw.
    if (mode === "branch") return [range, ...(material.head ? [material.head] : []),
      `Sources:\n${material.sources.join("\n")}`].join("\n\n");
    return finish({ content: [range, "Active knowledge:", material.knowledge.join("\n"),
      "Recent facts (newest first):", material.facts.join("\n"),
      "Raw:", material.entries.map(entry => entry.view).join("\n\n")].join("\n\n"), receipts: material.receipts });
  }
  const material = input.material;
  if (mode === "branch") return [range, `Facts to integrate: ${material.factAddresses.join(", ")}`,
    `${REMINDER}\n${material.reminders.join("\n\n") || "none"}`].join("\n\n");
  return finish({ content: [range, "Active knowledge:", material.knowledge.join("\n"),
    "Already-consolidated facts (newest first):", material.consolidated.join("\n"),
    "Range facts:", material.rangeFacts.join("\n"),
    REMINDER, material.reminders.join("\n\n") || "none"].join("\n\n"), receipts: material.receipts });
}

/** The messages one run needs. An inherited-context run appends a single user message carrying the
 * domain instructions and the material, because the fork has no system slot of its own to replace.
 * A fresh-context run puts the instructions in the system prompt and the material in the first user
 * message. */
export function composeTask(input: AgentInput, mode: "branch" | "subagent"): { systemPrompt?: string; message: string } {
  const material = composeMaterial(input, mode);
  return mode === "branch" ? { message: `${input.prompt}\n\n${material}` }
    : { systemPrompt: input.prompt, message: material };
}
