import type { DreamingAgentInput, ToolDefinition } from "../src/core/api/index.ts";

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

/** 127: a scripted Dreamer's writes, one `memory` call per operation and then one per skip, each
 * committed or refused on its own. The receipts read back together: every call's result in order,
 * and `committed`/`diagnostics` only when every call committed. */
export function dreamerWrite(memory: { execute(input: unknown): string },
  { operations = [], skipped = [] }: { operations?: readonly unknown[]; skipped?: readonly { knowledge?: unknown; because?: unknown }[] }): string {
  const receipts = [...operations, ...skipped.map(({ knowledge, because }) => ({ skip: knowledge, because }))].map(input => {
    const text = memory.execute(input);
    try { return JSON.parse(text) as { results: string[]; committed?: unknown[]; diagnostics?: unknown[] }; }
    catch { return { results: [text] }; }
  });
  return JSON.stringify({ results: receipts.flatMap(receipt => receipt.results),
    ...(receipts.every(receipt => receipt.committed) ? { committed: receipts.flatMap(receipt => receipt.committed!),
      diagnostics: receipts.flatMap(receipt => receipt.diagnostics ?? []) } : {}) });
}

/** A scripted Dreamer's explicit skip of every supplied handle it did not operate on. */
export function skipRest(task: DreamingAgentInput, except: readonly string[] = [], because = "reviewed; no operation needed in this run"): string {
  const skipped = suppliedHandles(task.material.changed).filter(handle => !except.includes(handle)).map(knowledge => ({ knowledge, because }));
  return dreamerWrite(task.tools.find(tool => tool.name === "memory")!, { skipped });
}
