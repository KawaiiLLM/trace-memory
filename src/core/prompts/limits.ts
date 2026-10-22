import { DEFAULT_WRITING_LIMITS, type WritingLimits } from "../model/index.ts";

export { DEFAULT_WRITING_LIMITS };

/** The configured title and body targets (units), filled in like tool names so the writer sees the numbers it is held to. */
export function renderLimits(text: string, limits: WritingLimits): string {
  return text.replace(/\{\{limit\.(title|body)\}\}/g, (_, field: "title" | "body") => String(limits[`${field}Words`]));
}
