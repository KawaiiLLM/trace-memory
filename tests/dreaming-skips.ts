import type { DreamingAgentInput } from "../src/core/api/index.ts";

/** Exact frozen versions are named by New/Changed/Archived item headers. Body tags,
 * change baselines and archive predecessors are history, not supplied skip targets. */
export function suppliedHandles(changed: string): string[] {
  const handles: string[] = [];
  for (const line of changed.split("\n")) {
    const match = /^(?:New|Changed|Archived) (K[1-9][0-9]*@v[1-9][0-9]*)(?=:| \()/.exec(line);
    if (match) handles.push(match[1]!);
  }
  return handles;
}

/** A scripted Dreamer's explicit skip of every supplied handle it did not operate on. */
export function skipRest(task: DreamingAgentInput, except: readonly string[] = [], because = "reviewed; no operation needed in this run"): string {
  const skipped = suppliedHandles(task.material.changed).filter(handle => !except.includes(handle)).map(knowledge => ({ knowledge, because }));
  return task.tools.find(tool => tool.name === "memory")!.execute({ operations: [], skipped });
}
