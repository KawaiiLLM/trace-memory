import type { DreamingAgentInput } from "../src/core/api/index.ts";

/** 59: the handles a frozen Dreamer block supplies — every `New:`/`Changed:` item line and every
 * `Archived:` line; an archive predecessor is history, not a supplied item. */
export function suppliedHandles(changed: string): string[] {
  const handles: string[] = [];
  let group = "";
  for (const line of changed.split("\n")) {
    if (/^(New|Changed|Archived):$/.test(line)) { group = line; continue; }
    const match = group === "Archived:" ? /^K(\d+@\d+) archived/.exec(line) : group ? /^\[K(\d+@\d+)\]/.exec(line) : null;
    if (match) handles.push(`K${match[1]}`);
  }
  return handles;
}

/** A scripted Dreamer's explicit skip of every supplied handle it did not operate on. */
export function skipRest(task: DreamingAgentInput, except: readonly string[] = [], because = "reviewed; no operation needed in this run"): string {
  const skipped = suppliedHandles(task.material.changed).filter(handle => !except.includes(handle)).map(knowledge => ({ knowledge, because }));
  return task.tools.find(tool => tool.name === "memory")!.execute({ operations: [], skipped });
}
