import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { Store, type KnowledgePath, type KnowledgeWithRevision } from "../../src/core/store/index.ts";
import { placementOwner, processedBlock, processedProjection } from "../../src/core/store/processing.ts";
import { tokens } from "../../src/core/render/index.ts";

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length);
}

const sourcePath = argument("db");
const sessionId = Number(argument("session") ?? "3");
const requestedBranch = argument("branch");
const auditDir = resolve(argument("audit-dir") ?? ".scratch/47-owner-pools-measured-on-the-run-path/audit");
if (!sourcePath) throw new Error("usage: node tests/scripts/ticket-47-owner-pools.ts --db=/path/to/read-only-backup [--session=3] [--branch=<selected-branch>] [--audit-dir=...]");
if (!Number.isSafeInteger(sessionId) || sessionId < 1) throw new Error("--session must be a positive safe integer");

const resolvedSource = resolve(sourcePath);
let ownedDir: string | undefined;
try {
  const source = new DatabaseSync(resolvedSource, { readOnly: true });
  let workingPath: string;
  try {
    mkdirSync(auditDir, { recursive: true });
    ownedDir = mkdtempSync(join(auditDir, "ticket-47-"));
    workingPath = join(ownedDir, "working-copy.sqlite");
    await backup(source, workingPath);
  } finally {
    source.close();
  }

  const store = new Store(workingPath);
  try {
    const branch = requestedBranch ?? String(store.db.prepare(`SELECT p.branch FROM source_paths p
      JOIN source_entries e ON e.id = (SELECT value FROM json_each(p.entry_ids) ORDER BY CAST(key AS INTEGER) DESC LIMIT 1)
      WHERE p.session_id = ? ORDER BY e.turn_id DESC, e.id DESC LIMIT 1`).get(sessionId)?.branch ?? "main");
    const path: KnowledgePath = store.knowledgePath(sessionId, branch);
    if (path.headTurnId === null) throw new Error(`S${sessionId}/${branch} has no selected head`);
    const all = processedProjection(store);
    const selected = processedProjection(store, [], undefined, undefined, path).paths[0];
    if (!selected) throw new Error(`S${sessionId}/${branch} has no projection`);

    const union = new Map<string, Map<number, KnowledgeWithRevision>>();
    for (const projectedPath of all.paths) for (const [owner, values] of projectedPath.pools) {
      if (!union.has(owner)) union.set(owner, new Map());
      for (const [commit, value] of values) union.get(owner)!.set(commit, value);
    }
    const measured = (values: Iterable<KnowledgeWithRevision>) => {
      const items = [...values];
      return { versions: items.length, tokens: tokens(processedBlock(items)) };
    };
    const owners = ["global", `project:${store.getSession(sessionId)!.projectId}`, `session:${sessionId}`];
    const active = store.listCurrentKnowledge(path);
    const activePools = new Map(owners.map(owner => [owner, new Map<number, KnowledgeWithRevision>()]));
    for (const value of active) activePools.get(placementOwner(store, value))!.set(value.revision.id, value);
    const report = {
      source: resolvedSource,
      workingCopy: workingPath,
      path,
      oldUnion: Object.fromEntries(owners.map(owner => [owner, measured(union.get(owner)?.values() ?? [])])),
      newPath: Object.fromEntries(owners.map(owner => [owner, measured(selected.pools.get(owner)?.values() ?? [])])),
      applicable: measured(selected.values),
      activePath: {
        owners: Object.fromEntries(owners.map(owner => [owner, measured(activePools.get(owner)!.values())])),
        applicable: measured(active),
      },
      activeApplicableVersions: active.length,
      processedApplicableVersions: selected.values.length,
      ownerCheck: Object.fromEntries(selected.values.map(value => [value.revision.id, placementOwner(store, value)])),
      note: "Active applicable versions include unprocessed current revisions; owner pools and applicable above include only current non-archived processed versions. Historical certificates remain stored but are counted only where that exact revision is current on the measured path.",
    };
    console.log(JSON.stringify(report, null, 2));
  } finally {
    store.close();
  }
} finally {
  if (ownedDir !== undefined) rmSync(ownedDir, { recursive: true, force: true });
}
