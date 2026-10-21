import type { KnowledgeRevision } from "../model/index.ts";
import { knowledgeTitle, renderKnowledgeDiff } from "../render/index.ts";
import type { Store } from "../store/index.ts";

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
  // Every whole body carries its title, as the views do; a legacy untitled version shows the derived one.
  const whole = (revision: KnowledgeRevision, mark: "+" | "-") =>
    `${knowledgeTitle(revision, store.writing.titleTokens)}\n${mark === "+" ? `{+${revision.text}+}` : `[-${revision.text}-]`}`;
  const latest = (knowledgeId: number) => address(own.get(knowledgeId)!.at(-1)!);
  const blocks = [...own].flatMap(([knowledgeId, revisions]) => {
    const gone = replaced.get(knowledgeId);
    const first = revisions[0], parent = first?.parentId == null ? undefined : store.knowledgeRevision(first.parentId);
    // The version this run started from; the item's last version when the run had no revision of it.
    const start = first === undefined ? gone?.last : parent?.knowledgeId === knowledgeId ? parent : undefined;
    const last = revisions.at(-1) ?? gone!.last;
    // What leaves the pool is the body the run started from, not a later rewrite of it.
    const removed = whole(start ?? last, "-");
    if (gone) return [`${address(gone.last)} (${gone.op === "merge" ? "merged into" : "split into"} ${[...gone.by].map(latest).join(", ")}):\n${removed}`];
    if (last.op === "archive")
      return [`${address(last)} (archive: ${last.archiveKind}; reason: ${last.reason}):\n${last.archiveKind === "budget" ? removed
        : `${start ? `${removed}\n` : ""}archive text: ${last.text}`}`];
    if (start?.op === "archive") return [`${address(last)} (restored from archive):\n${whole(last, "+")}`];
    if (!start) return [`${address(last)} (${parent ? `split from K${parent.knowledgeId}` : "new"}):\n${whole(last, "+")}`];
    const bodyChanged = start.text !== last.text || start.title !== last.title;
    if (!bodyChanged && start.category === last.category && start.scope === last.scope &&
        JSON.stringify(start.topics) === JSON.stringify(last.topics)) return [];
    return [renderKnowledgeDiff(start, last, [], Infinity, new Set([...bodyChanged ? ["text"] : [], "status", "topics"]),
      undefined, address(last), false)];
  });
  return `Before this run ends, review it once.\n\nBlockers:\n${blockers.join("\n") || "None."}\n\nKnowledge changes committed in this run:\n${blocks.join("\n\n") || "None."}\n\nCheck each change against your Principles: a removed line must be redundant or reliably retrievable, and no ruling, condition, confirmed next step or execution boundary may be lost. These changes are already committed; correct one with a further operation on its current version. Resolve every blocker. Leave compliant changes as they are. Then end.`;
}
