// The workspace file contract (ticket 144, Stage 2): parse, check and apply the files that the Noter and the
// Dreaming tasks write instead of calling tools. No runner uses it yet.

import { plan, type CheckResult, type WorkspaceTask } from "./plan.ts";
import type { Store } from "../store/index.ts";

/** Check one file against its task: success, or readable problems; the host-measured length of every title
 * and body in the file is returned either way, so an agent never needs a counter of its own. */
export function checkWorkspace(store: Store, task: WorkspaceTask): CheckResult {
  const { problems, lengths } = plan(store, task);
  return { ok: !problems.length, problems, lengths };
}

export { applyWorkspace, type ApplyInput, type ApplyResult, type BlockResult } from "./apply.ts";
export { parseBlocks, parseScores, describeBlock, problem, type WorkspaceFile } from "./parse.ts";
export { plan } from "./plan.ts";
export type { CheckResult, Length, NotingScope, TaskKind, WorkspaceTask } from "./plan.ts";
