import { expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type KnowledgePath } from "../../../src/core/store/index.ts";

const at = "2026-09-25T00:00:00Z";

test("88: neutral writes do not revisit existing knowledge revisions", () => {
  const store = new Store(":memory:");
  try {
    const project = store.createProject({ name: "88", declaredBy: "mark" });
    const session = store.createSession({ host: "88", projectId: project.id, enrollmentChoice: true,
      startedAt: at, firstReplyAt: at });
    const turn = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "first", startedAt: at });
    const entry = store.appendSourceEntry({ sessionId: session.id, turnId: turn.id, nativeLineage: "native", nativeId: "first",
      role: "user", text: "first", raw: "first", calls: [] });
    store.selectSourcePath(session.id, "main", [entry.id]);
    const recorded = store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, createdAt: at }, entryIds: [entry.id],
      facts: [{ turnId: turn.id, entryIds: [entry.id], category: "observation", actor: "user", text: "first",
        source: [`T${turn.id}#E1`], createdAt: at }] });
    if (!recorded.ok) throw Error(recorded.problems.join("; "));
    const fact = recorded.facts[0]!;
    const path = { sessionId: session.id, branch: "main", headTurnId: turn.id };
    const created = store.commitConsolidationRun({ path, run: { kind: "manual", sessionId: session.id, branch: "main", createdAt: at },
      operations: [{ op: "create", handle: "$k", author: "test", text: "knowledge", category: "constraint", scope: "session",
        supports: [fact.id], topics: [], reason: "evidence", createdAt: at }] });
    if (!created.ok) throw Error(created.problems.join("; "));
    const revisionId = created.committed[0]!.commit;
    expect(store.visibleKnowledgeVersions(path)).toEqual(new Set([revisionId]));
    const original = store.db.prepare.bind(store.db);
    const monitored = store as unknown as { graphComponent: (...args: unknown[]) => unknown;
      revisionApplies: (...args: unknown[]) => unknown; factOnCurrentPath: (...args: unknown[]) => unknown };
    const originalComponent = monitored.graphComponent, originalRevision = monitored.revisionApplies,
      originalFact = monitored.factOnCurrentPath;
    let components = 0, examinedRevisions = 0, examinedFacts = 0;
    monitored.graphComponent = (...args) => { components++; return originalComponent.apply(store, args); };
    monitored.revisionApplies = (...args) => { examinedRevisions++; return originalRevision.apply(store, args); };
    monitored.factOnCurrentPath = (...args) => { examinedFacts++; return originalFact.apply(store, args); };
    let oldRevisionReads = 0;
    store.db.prepare = ((sql: string) => {
      if (/SELECT \* FROM knowledge_revisions ORDER BY id/.test(sql)) oldRevisionReads++;
      return original(sql);
    }) as typeof store.db.prepare;
    const emptyFact = store.appendTurn({ sessionId: session.id, parentTurnId: turn.id, kind: "turn", userPrompt: "new", startedAt: at });
    const nextEntry = store.appendSourceEntry({ sessionId: session.id, turnId: emptyFact.id, nativeLineage: "native", nativeId: "next",
      role: "user", text: "next", raw: "next", calls: [] });
    const newFact = store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, createdAt: at },
      entryIds: [nextEntry.id], facts: [{ turnId: emptyFact.id, entryIds: [nextEntry.id],
        category: "observation", actor: "user", text: "uncited", source: [`T${emptyFact.id}#E1`], createdAt: at }] });
    if (!newFact.ok) throw Error(newFact.problems.join("; "));
    store.setKnowledgeBudget("session", 1500);
    expect(store.visibleKnowledgeVersions(path)).toEqual(new Set([revisionId]));
    expect({ oldRevisionReads, components, examinedRevisions, examinedFacts })
      .toEqual({ oldRevisionReads: 0, components: 0, examinedRevisions: 0, examinedFacts: 0 });
    monitored.graphComponent = originalComponent;
    monitored.revisionApplies = originalRevision;
    monitored.factOnCurrentPath = originalFact;
    store.setCurrentPath(session.id, "main", turn.id, "native");
    expect(store.visibleKnowledgeVersions(path)).toEqual(new Set([revisionId]));
  } finally { store.close(); }
});

test("88: every external commit, foreground move and rollback agrees with a fresh graph", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-memory-88-"));
  const reader = new Store(join(dir, "trace.db")), writer = new Store(join(dir, "trace.db"));
  try {
    const project = writer.createProject({ name: "88-shared", declaredBy: "mark" });
    const sessions = ["A", "B"].map(host => writer.createSession({ host, projectId: project.id,
      enrollmentChoice: true, startedAt: at, firstReplyAt: at }));
    const nodes = sessions.map(session => {
      const first = writer.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "root", startedAt: at });
      const second = writer.appendTurn({ sessionId: session.id, parentTurnId: first.id, kind: "turn", userPrompt: "tail", startedAt: at });
      const entries = [first, second].map((turn, i) => writer.appendSourceEntry({ sessionId: session.id, turnId: turn.id,
        nativeLineage: "native", nativeId: `${session.id}-${i}`, role: "user", text: "text", raw: "text", calls: [] }));
      writer.selectSourcePath(session.id, "main", entries.map(e => e.id));
      writer.selectSourcePath(session.id, "root", [entries[0]!.id]);
      const noted = writer.commitNotingRun({ run: { kind: "manual", sessionId: session.id, createdAt: at },
        entryIds: entries.map(e => e.id), facts: [first, second].map((turn, i) => ({ turnId: turn.id,
          entryIds: [entries[i]!.id], category: "decision" as const, actor: "user" as const,
          text: `fact-${session.id}-${i}`, source: [`T${turn.id}#E1`], createdAt: at })) });
      if (!noted.ok) throw Error(noted.problems.join("; "));
      return { session, first, second, entries, facts: noted.facts };
    });
    const [a, b] = nodes as [typeof nodes[number], typeof nodes[number]];
    const paths: KnowledgePath[] = nodes.map(n => ({ sessionId: n.session.id, branch: "main", headTurnId: n.second.id }));
    const check = () => {
      for (const path of paths) {
        const cached = reader.commitGraph(path, undefined, undefined, reader.commitGraphInput(undefined, path.sessionId));
        const fresh = reader.commitGraph(path, undefined, undefined, reader.commitGraphInput());
        expect([...cached.applicable].sort()).toEqual([...fresh.applicable].sort());
        expect([...cached.effective].sort()).toEqual([...fresh.effective].sort());
        expect(cached.resolved.map(r => r.id)).toEqual(fresh.resolved.map(r => r.id));
        expect(cached.current.map(r => r.id)).toEqual(fresh.current.map(r => r.id));
        expect(reader.visibleKnowledgeVersions(path)).toEqual(new Set(fresh.current.filter(r => r.op !== "archive").map(r => r.id)));
      }
    };
    const create = (owner: typeof nodes[number], support: number, scope: "global" | "session" | "project") => {
      const result = writer.commitConsolidationRun({ path: { sessionId: owner.session.id, branch: "main", headTurnId: owner.second.id },
        run: { kind: "manual", sessionId: owner.session.id, branch: "main", createdAt: at },
        operations: [{ op: "create", handle: "$new", author: "test", text: `claim ${support}`,
          category: "constraint", scope, supports: [support], reason: "fixture", topics: [], createdAt: at }] });
      if (!result.ok) throw Error(result.problems.join("; "));
      return result.committed[0]!;
    };
    const base = create(a, a.facts[0]!.id, "global"); check();
    create(b, b.facts[1]!.id, "project"); check(); // B has no cursor: all stored paths active.
    writer.setCurrentPath(b.session.id, "root", b.first.id, "one");
    const monitored = reader as unknown as { graphComponent: (...args: unknown[]) => unknown;
      factOnCurrentPath: (...args: unknown[]) => unknown };
    const originalComponent = monitored.graphComponent, originalFact = monitored.factOnCurrentPath;
    let components = 0, bFacts = 0, aFacts = 0;
    monitored.graphComponent = (...args) => { components++; return originalComponent.apply(reader, args); };
    monitored.factOnCurrentPath = (...args) => {
      if (args[1] === a.session.id) aFacts++;
      if (args[1] === b.session.id) bFacts++;
      return originalFact.apply(reader, args);
    };
    try { reader.commitGraph(paths[0]!, undefined, undefined, reader.commitGraphInput(undefined, a.session.id)); }
    finally { monitored.graphComponent = originalComponent; monitored.factOnCurrentPath = originalFact; }
    expect(components).toBe(1); expect(aFacts).toBe(0); expect(bFacts).toBeGreaterThan(0);
    check(); // first cursor ends the all-path compatibility, touching B's one component.
    writer.setCurrentPath(b.session.id, "main", b.second.id, "two"); check(); // second complete path restores B
    writer.setCurrentPath(a.session.id, "main", a.second.id, "one"); check();
    const updated = writer.commitConsolidationRun({ path: paths[0]!,
      run: { kind: "manual", sessionId: a.session.id, branch: "main", createdAt: at },
      operations: [{ op: "archive", knowledgeId: base.knowledgeId, baseCommit: base.commit,
        supports: [a.facts[1]!.id], reason: "new evidence", createdAt: at }] });
    if (!updated.ok) throw Error(updated.problems.join("; "));
    check();
    // Global current selection includes the archive, but 92's body set must not deliver it
    // or fall back to the old body, even for the other reader.
    for (const path of paths) {
      expect(reader.commitGraph(path).current.some(revision => revision.id === updated.committed[0]!.commit)).toBe(true);
      expect(reader.visibleKnowledgeVersions(path).has(updated.committed[0]!.commit)).toBe(false);
      expect(reader.visibleKnowledgeVersions(path).has(base.commit)).toBe(false);
    }
    writer.setCurrentPath(a.session.id, "root", a.first.id, "one"); check();
    expect(reader.visibleKnowledgeVersions(paths[1]!).has(base.commit)).toBe(true);
    writer.setCurrentPath(a.session.id, "main", a.second.id, "one"); check();
    expect(reader.visibleKnowledgeVersions(paths[1]!).has(base.commit)).toBe(false);
    const other = writer.createProject({ name: "88-other", declaredBy: "mark" });
    writer.mergeProject(project.id, other.id); check();
    const moved = writer.createProject({ name: "88-isolated", declaredBy: "mark" });
    writer.declareProject(b.session.id, moved.name, "mark", { path: paths[1]!, atTrigger: () => false }); check();
    // An uncommitted savepoint must not escape into the committed read projection.
    writer.db.exec("SAVEPOINT probe88");
    writer.setKnowledgeBudget("session", 987);
    writer.db.exec("ROLLBACK TO probe88; RELEASE probe88"); check();
    create(a, a.facts[0]!.id, "session"); check();
    // Deterministic mixed operations; assert against the uncached resolver after every step.
    let random = 0x8801;
    for (let step = 0; step < 36; step++) {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      switch (random % 6) {
        case 0: create(a, a.facts[0]!.id, "global"); break;
        case 1: writer.setCurrentPath(a.session.id, "root", a.first.id, "one"); break;
        case 2: writer.setCurrentPath(a.session.id, "main", a.second.id, "one"); break;
        case 3: writer.setCurrentPath(b.session.id, "root", b.first.id, "two"); break;
        case 4: writer.setCurrentPath(b.session.id, "main", b.second.id, "two"); break;
        default: writer.setKnowledgeBudget("session", 1000 + step); break;
      }
      check();
    }
    // One actual Dreamer range joins three identities through merge -> split -> merge.
    // The reader stays on another connection and checks the fresh resolver after every commit.
    writer.setCurrentPath(a.session.id, "main", a.second.id, "one"); check();
    const members = [0, 1, 2].map(() => create(a, a.facts[0]!.id, "global"));
    const unrelated = create(b, b.facts[0]!.id, "global");
    check();
    const target = { ...paths[0]!, branch: "main", headTurnId: a.second.id, triggerEntryId: a.entries[1]!.id };
    const claim = writer.acquireClaim(target, "dreaming", "88-linked")!;
    const range = writer.retainKnowledgePoolRange(target, "global", claim);
    const run = writer.bindDreamingRun({ kind: "dreaming", sessionId: a.session.id, branch: "main", claim,
      dreamingRangeId: range.id, executionId: writer.beginExecution({ sessionId: a.session.id, phase: "dreaming",
        head: range.anchor, origin: range.origin }), createdAt: at });
    const maintain = (operation: Parameters<typeof writer.commitConsolidationRun>[0]["operations"][number]) => {
      const result = writer.commitConsolidationRun({ path: target, run, operations: [operation] });
      if (!result.ok) throw Error(result.problems.join("; "));
      check();
      return result.committed;
    };
    const merged = maintain({ op: "merge", intoKnowledgeId: members[0]!.knowledgeId,
      intoBaseCommit: members[0]!.commit, absorb: [{ knowledgeId: members[1]!.knowledgeId, baseCommit: members[1]!.commit }],
      text: "joined", category: "constraint", scope: "global", supports: [a.facts[1]!.id],
      topics: [], reason: "real merge", createdAt: at })[0]!;
    const children = maintain({ op: "split", knowledgeId: merged.knowledgeId, baseCommit: merged.commit,
      children: [{ text: "left", category: "constraint", topics: [] }, { text: "right", category: "constraint", topics: [] }],
      supports: [a.facts[0]!.id], reason: "real split", createdAt: at });
    maintain({ op: "merge", intoKnowledgeId: members[2]!.knowledgeId, intoBaseCommit: members[2]!.commit,
      absorb: [{ knowledgeId: children[0]!.knowledgeId, baseCommit: children[0]!.commit }],
      text: "transitive", category: "constraint", scope: "global", supports: [a.facts[0]!.id],
      topics: [], reason: "transitive merge", createdAt: at });
    const inspected = reader as unknown as { graphComponent: (input: unknown, ids: Set<number>) => unknown;
      factOnCurrentPath: (...args: unknown[]) => unknown };
    const component = inspected.graphComponent, factOnPath = inspected.factOnCurrentPath;
    const touched: Set<number>[] = [];
    let ownerA = 0, ownerB = 0;
    inspected.graphComponent = (input, ids) => { touched.push(new Set(ids)); return component.call(reader, input, ids); };
    inspected.factOnCurrentPath = (...args) => {
      if (args[1] === a.session.id) ownerA++;
      if (args[1] === b.session.id) ownerB++;
      return factOnPath.apply(reader, args);
    };
    try {
      writer.setCurrentPath(a.session.id, "root", a.first.id, "one");
      reader.commitGraph(paths[0]!, undefined, undefined, reader.commitGraphInput(undefined, a.session.id));
    } finally {
      inspected.graphComponent = component;
      inspected.factOnCurrentPath = factOnPath;
    }
    // Both linked hops belong to the same recomputation; the archived lineage is the
    // other affected component. B's unrelated chain and fact owner are untouched.
    expect(touched).toHaveLength(2);
    expect(touched.some(ids => [merged.commit, ...children.map(child => child.commit), members[2]!.commit]
      .every(id => ids.has(id)) && !ids.has(unrelated.commit))).toBe(true);
    expect(touched.every(ids => !ids.has(unrelated.commit))).toBe(true);
    expect(ownerA).toBeGreaterThan(0);
    expect(ownerB).toBe(0);
    check();
    let seed = 0x8802;
    for (let step = 0; step < 24; step++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      switch (seed % 4) {
        case 0: writer.setCurrentPath(a.session.id, "root", a.first.id, "one"); break;
        case 1: writer.setCurrentPath(a.session.id, "main", a.second.id, "one"); break;
        case 2: writer.setCurrentPath(b.session.id, "root", b.first.id, "two"); break;
        default: writer.setCurrentPath(b.session.id, "main", b.second.id, "two"); break;
      }
      check();
    }
    reader.close();
    const restarted = new Store(join(dir, "trace.db"));
    try {
      for (const path of paths) expect(restarted.visibleKnowledgeVersions(path))
        .toEqual(new Set(restarted.commitGraph(path).current.filter(r => r.op !== "archive").map(r => r.id)));
    } finally { restarted.close(); }
  } finally { if (!reader.closed) reader.close(); writer.close(); rmSync(dir, { recursive: true, force: true }); }
});
