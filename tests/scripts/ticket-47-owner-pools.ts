import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { Store, type KnowledgePath, type KnowledgeWithRevision } from "../../src/core/store/index.ts";
import { placementOwner, processedBlock } from "../../src/core/store/processing.ts";
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
      JOIN source_entries e ON e.id = p.tail_entry_id
      WHERE p.session_id = ? ORDER BY e.turn_id DESC, e.id DESC LIMIT 1`).get(sessionId)?.branch ?? "main");
    const path: KnowledgePath = store.knowledgePath(sessionId, branch);
    if (path.headTurnId === null) throw new Error(`S${sessionId}/${branch} has no selected head`);
    const measured = (values: Iterable<KnowledgeWithRevision>) => {
      const items = [...values];
      return { versions: items.length, tokens: tokens(processedBlock(items)) };
    };
    const owners = ["global", `project:${store.getSession(sessionId)!.projectId}`, `session:${sessionId}`];
    const active = store.currentKnowledge(path);
    const activePools = new Map(owners.map(owner => [owner, new Map<number, KnowledgeWithRevision>()]));
    for (const value of active) activePools.get(placementOwner(store, value))!.set(value.revision.id, value);
    const report = {
      source: resolvedSource,
      workingCopy: workingPath,
      path,
      pools: store.poolSizes(path),
      pending: Object.fromEntries(owners.map(owner => [owner, store.pendingVersions(owner, path).length])),
      due: store.duePools(path).map(value => ({ pool: value.pool, reason: value.reason, pending: value.pending.length })),
      activePath: {
        owners: Object.fromEntries(owners.map(owner => [owner, measured(activePools.get(owner)!.values())])),
        applicable: measured(active),
      },
      activeApplicableVersions: active.length,
      handledCurrentVersions: store.processedCurrentVersions(active).size,
      ownerCheck: Object.fromEntries(active.map(value => [value.revision.id, placementOwner(store, value)])),
      note: "Current owner pools include every visible non-archived current version. Pending uses per-pool/version processing records; handling does not change validity. This replaces the old processed-only path/union comparison.",
    };
    console.log(JSON.stringify(report, null, 2));
  } finally {
    store.close();
  }
} finally {
  if (ownedDir !== undefined) rmSync(ownedDir, { recursive: true, force: true });
}
