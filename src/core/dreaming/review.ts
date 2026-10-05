import type { KnowledgeRevision } from "../model/index.ts";
import { renderKnowledgeDiff } from "../render/index.ts";
import type { Store } from "../store/index.ts";

/** Unchanged characters kept beside each change, so a diff never reprints an unchanged body. */
const CONTEXT = 20;

/** 125: the one end review a Dreamer run gets: what still blocks success, and the net change this
 * run made to each knowledge item (from the version it started from to its latest version). */
export function renderDreamingReview(store: Store, runId: number | undefined, blockers: readonly string[]): string {
  const address = (revision: KnowledgeRevision) => `K${revision.knowledgeId}#${store.versionTag(revision.knowledgeId, revision.id)}`;
  // Items in first-touch order: the run's own revisions of each, and the items a merge or split replaced.
  const own = new Map<number, KnowledgeRevision[]>();
  const replaced = new Map<number, { last: KnowledgeRevision; by: Set<number>; op: "merge" | "split" }>();
  for (const commit of runId === undefined ? [] : store.listCommitsByRun(runId)) {
    // A split lists its parent before its children; a merge its survivor before the absorbed item.
    const record = () => own.set(commit.knowledgeId, [...own.get(commit.knowledgeId) ?? [], commit]);
    if (commit.op !== "split") record();
    if (commit.op === "merge" || commit.op === "split") for (const parent of store.commitParents(commit)) if (parent.knowledgeId !== commit.knowledgeId) {
      own.set(parent.knowledgeId, own.get(parent.knowledgeId) ?? []);
      const entry = replaced.get(parent.knowledgeId) ?? { last: parent, by: new Set<number>(), op: commit.op };
      entry.by.add(commit.knowledgeId); replaced.set(parent.knowledgeId, entry);
    }
    if (commit.op === "split") record();
  }
  const latest = (knowledgeId: number) => address(own.get(knowledgeId)!.at(-1)!);
  const blocks = [...own].flatMap(([knowledgeId, revisions]) => {
    const gone = replaced.get(knowledgeId);
    if (gone) return [`${address(gone.last)} (${gone.op === "merge" ? "merged into" : "split into"} ${[...gone.by].map(latest).join(", ")}):\n[-${gone.last.text}-]`];
    const last = revisions.at(-1)!;
    if (last.op === "archive")
      return [`${address(last)} (archive: ${last.archiveKind}; reason: ${last.reason}):\n${last.archiveKind === "budget" ? `[-${last.text}-]` : last.text}`];
    const start = revisions[0]!.parentId === null ? undefined : store.knowledgeRevision(revisions[0]!.parentId);
    if (start?.knowledgeId !== knowledgeId)
      return [`${address(last)} (${start ? `split from K${start.knowledgeId}` : "new"}):\n{+${last.text}+}`];
    const bodyChanged = start.text !== last.text;
    if (!bodyChanged && start.category === last.category && start.scope === last.scope &&
        JSON.stringify(start.topics) === JSON.stringify(last.topics)) return [];
    return [renderKnowledgeDiff(start, last, [], Infinity, new Set([...bodyChanged ? ["text"] : [], "status", "topics"]),
      undefined, address(last), CONTEXT)];
  });
  return `Before this run ends, review it once.\n\nBlockers:\n${blockers.join("\n") || "None."}\n\nKnowledge changes committed in this run:\n${blocks.join("\n\n") || "None."}\n\nCheck each change against your Principles: a removed line must be redundant or reliably retrievable, and no ruling, condition, confirmed next step or execution boundary may be lost. These changes are already committed; correct one with a further operation on its current version. Resolve every blocker. Leave compliant changes as they are. Then end.`;
}
