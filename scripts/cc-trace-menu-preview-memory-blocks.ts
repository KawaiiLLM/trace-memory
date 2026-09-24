// Ticket 82 requirement 1: the three real texts the Claude Code preview injects and measures, so the
// Knowledge/Facts/Raw amounts the preview shows come from actual injected content instead of a fixture
// number nobody put in context. This module has no other project import (data only) so it can be:
//   - imported by `cc-trace-menu-hooks-preview.tsx` (bundled by `build-cc-trace-menu-preview.mjs`) to
//     measure each block with the project's own `tokens()` estimator, and
//   - deployed verbatim (Node runs `.ts` directly, no build step needed for a plain `node <file>`
//     subprocess) alongside `cc-trace-menu-session-start-inject.ts`, which a classic SessionStart hook
//     runs to actually put the text into the session's context via `additionalContext`.
//
// Sizes (measured with this project's `tokens()`, `src/core/render/index.ts`): Knowledge ~2.0k, Facts
// ~1.2k, Raw ~1.2k — a few thousand tokens total, per requirement 1's "about 2k / 1.2k / 1.2k".
//
// Each block is kept under 10,000 characters and injected as its own separate SessionStart hook command
// (see `cc-trace-menu-session-start-inject.ts` and `hooks.json`): a live probe against the fenced
// sandbox (ticket 82 delegation report) found that a single SessionStart hook's `additionalContext` is
// silently truncated somewhere between 10,000 and 10,050 characters — content past that point is
// dropped, not merely counted differently — while three separate hook commands, each under the limit,
// are each injected and counted in full. One block per hook command keeps every block clear of that
// limit with room to spare (the largest here is ~9.6k characters).
function block(heading: string, phrase: string, lines: number): string {
  const rows: string[] = [];
  for (let i = 1; i <= lines; i++) rows.push(`${i}. ${phrase} (sample line ${i} of ${lines}).`);
  return `=== ${heading} ===\n${rows.join("\n")}`;
}

export const KNOWLEDGE_BLOCK = block(
  "TRACE-MEMORY TICKET 82 SAMPLE: KNOWLEDGE",
  "The sample project keeps design decisions and their rationale recorded here for the ticket 82 preview",
  74,
);
export const FACTS_BLOCK = block(
  "TRACE-MEMORY TICKET 82 SAMPLE: FACTS",
  "A recorded fact from the sample conversation, kept short and concrete for the ticket 82 preview",
  44,
);
export const RAW_BLOCK = block(
  "TRACE-MEMORY TICKET 82 SAMPLE: RAW",
  "Raw transcript excerpt retained verbatim from the sample conversation for the ticket 82 preview",
  48,
);
