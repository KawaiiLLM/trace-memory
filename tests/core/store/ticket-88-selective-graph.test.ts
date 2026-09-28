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
    store.setCurrentPath(session.id, "main", turn.id, "native");
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
    let oldRevisionReads = 0, aggregates = 0;
    const results = store as unknown as { graphResults: WeakMap<object, unknown> };
    const originalSet = results.graphResults.set.bind(results.graphResults);
    results.graphResults.set = ((key: object, value: unknown) => { aggregates++; return originalSet(key, value); }) as typeof results.graphResults.set;
    store.db.prepare = ((sql: string) => {
      if (/SELECT \* FROM knowledge_revisions ORDER BY id/.test(sql)) oldRevisionReads++;
      return original(sql);
    }) as typeof store.db.prepare;
    const assertNeutral = (event: string) => {
      expect(store.visibleKnowledgeVersions(path), event).toEqual(new Set([revisionId]));
      expect({ oldRevisionReads, components, examinedRevisions, examinedFacts, aggregates }, event)
        .toEqual({ oldRevisionReads: 0, components: 0, examinedRevisions: 0, examinedFacts: 0, aggregates: 0 });
    };
    const emptyFact = store.appendTurn({ sessionId: session.id, parentTurnId: turn.id, kind: "turn", userPrompt: "new", startedAt: at });
    const nextEntry = store.appendSourceEntry({ sessionId: session.id, turnId: emptyFact.id, nativeLineage: "native", nativeId: "next",
      role: "user", text: "next", raw: "next", calls: [] });
    assertNeutral("append and source entry");
    const newFact = store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, createdAt: at },
      entryIds: [nextEntry.id], facts: [{ turnId: emptyFact.id, entryIds: [nextEntry.id],
        category: "observation", actor: "user", text: "uncited", source: [`T${emptyFact.id}#E1`], createdAt: at }] });
    if (!newFact.ok) throw Error(newFact.problems.join("; "));
    assertNeutral("N processing and new uncited fact");
    const historical = store.recordRun({ kind: "consolidation", sessionId: session.id, branch: "main", createdAt: at, outcome: "success" });
    store.markConsolidated(fact.id, historical.id, project.id);
    assertNeutral("C processing mark");
    const claim = store.acquireClaim(path, "dreaming", "88-neutral")!;
    const range = store.retainKnowledgePoolRange(path, `session:${session.id}`, claim);
    const executionId = store.beginExecution({ sessionId: session.id, phase: "dreaming", pool: range.pool!, origin: range.origin });
    const dream = store.bindDreamingRun({ kind: "dreaming", sessionId: session.id, branch: "main",
      dreamingRangeId: range.id, executionId, claim, createdAt: at });
    store.completeKnowledgePoolRange(dream, "success", range.eventIds);
    store.releaseClaim(claim);
    // Claim/range setup performs fresh writer validation; measure the committed reader only.
    oldRevisionReads = components = examinedRevisions = examinedFacts = 0;
    assertNeutral("D processing mark");
    store.setKnowledgeBudget("session", 1500);
    assertNeutral("budget edit");
    monitored.graphComponent = originalComponent;
    monitored.revisionApplies = originalRevision;
    monitored.factOnCurrentPath = originalFact;
    results.graphResults.set = originalSet;
  } finally { store.close(); }
});

test("88: a mixed-owner global revision refreshes only the moved owner's membership", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-memory-88-owners-"));
  const writer = new Store(join(dir, "trace.db")), reader = new Store(join(dir, "trace.db"));
  try {
    const project = writer.createProject({ name: "owners", declaredBy: "mark" });
    const nodes = ["A", "B"].map(host => {
      const session = writer.createSession({ host, projectId: project.id, enrollmentChoice: true, startedAt: at, firstReplyAt: at });
      const first = writer.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "first", startedAt: at });
      const tail = writer.appendTurn({ sessionId: session.id, parentTurnId: first.id, kind: "turn", userPrompt: "tail", startedAt: at });
      const entries = [first, tail].map((turn, i) => writer.appendSourceEntry({ sessionId: session.id, turnId: turn.id,
        nativeLineage: "native", nativeId: `${host}-${i}`, role: "user", text: host, raw: host, calls: [] }));
      writer.selectSourcePath(session.id, "main", entries.map(e => e.id));
      writer.selectSourcePath(session.id, "root", [entries[0]!.id]);
      const noted = writer.commitNotingRun({ run: { kind: "manual", sessionId: session.id, createdAt: at },
        entryIds: [entries[1]!.id], facts: [{ turnId: tail.id, entryIds: [entries[1]!.id], category: "decision",
          actor: "user", text: host, source: [`T${tail.id}#E1`], createdAt: at }] });
      if (!noted.ok) throw Error(noted.problems.join("; "));
      writer.setCurrentPath(session.id, "main", tail.id, "native");
      return { session, first, tail, entries, fact: noted.facts[0]! };
    });
    const [a, b] = nodes as [typeof nodes[number], typeof nodes[number]];
    const path = { sessionId: a.session.id, branch: "main", headTurnId: a.tail.id };
    const result = writer.commitConsolidationRun({ path, run: { kind: "manual", sessionId: a.session.id, branch: "main", createdAt: at },
      operations: [{ op: "create", handle: "$mixed", author: "test", text: "both", category: "constraint", scope: "global",
        supports: [a.fact.id, b.fact.id], topics: [], reason: "both owners", createdAt: at }] });
    if (!result.ok) throw Error(result.problems.join("; "));
    expect(reader.visibleKnowledgeVersions(path)).toEqual(new Set([result.committed[0]!.commit]));
    const original = reader.selectedSourceEntryIds.bind(reader);
    const selectedOwners: number[] = [], membershipOwners: number[][] = [], sourceEntryRowInputs: number[][] = [];
    const tracked = reader as unknown as { prepareCurrentMembership: (input: { facts: Map<number, { sessionId: number }> }, paths: Map<string, unknown>) => void };
    const originalMembership = tracked.prepareCurrentMembership;
    tracked.prepareCurrentMembership = (input, paths) => {
      membershipOwners.push([...new Set([...input.facts.values()].map(fact => fact.sessionId))]);
      sourceEntryRowInputs.push([...new Set([...paths.values()].flatMap(ids => ids as number[]))]);
      return originalMembership.call(reader, input, paths);
    };
    reader.selectedSourceEntryIds = ((sessionId: number, branch: string) => {
      selectedOwners.push(sessionId); return original(sessionId, branch);
    }) as typeof reader.selectedSourceEntryIds;
    writer.setCurrentPath(a.session.id, "root", a.first.id, "native");
    expect(reader.visibleKnowledgeVersions(path)).toEqual(new Set());
    expect(selectedOwners).toEqual([a.session.id]);
    expect(membershipOwners).toEqual([[a.session.id]]);
    expect(sourceEntryRowInputs).toEqual([[a.entries[0]!.id]]);
    tracked.prepareCurrentMembership = originalMembership;
    const fresh = reader.commitGraph(path, undefined, undefined, reader.commitGraphInput());
    expect(fresh.resolved.map(r => r.id)).toEqual(reader.commitGraph(path, undefined, undefined,
      reader.commitGraphInput(undefined, a.session.id)).resolved.map(r => r.id));
    // Another commit reusing previously cited B evidence must not reread B's path either.
    selectedOwners.length = 0;
    writer.setCurrentPath(a.session.id, "main", a.tail.id, "native");
    const added = writer.commitConsolidationRun({ path, run: { kind: "manual", sessionId: a.session.id, branch: "main", createdAt: at },
      operations: [{ op: "create", handle: "$second", author: "test", text: "second claim", category: "constraint",
        scope: "global", supports: [a.fact.id, b.fact.id], topics: [], reason: "same evidence", createdAt: at }] });
    if (!added.ok) throw Error(added.problems.join("; "));
    expect(reader.visibleKnowledgeVersions(path)).toEqual(new Set([result.committed[0]!.commit, added.committed[0]!.commit]));
    expect(selectedOwners).toEqual([a.session.id]);
  } finally { reader.close(); writer.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("88: unchanged committed input reuses the aggregate, not just component results", () => {
  const store = new Store(":memory:");
  try {
    const session = store.createSession({ host: "88", projectId: store.createProject({ name: "aggregate", declaredBy: "mark" }).id,
      enrollmentChoice: true, startedAt: at, firstReplyAt: at });
    store.commitGraphInput(undefined, session.id);
    const results = store as unknown as { graphResults: WeakMap<object, unknown> };
    const original = results.graphResults.set.bind(results.graphResults);
    let aggregates = 0;
    results.graphResults.set = ((key: object, value: unknown) => { aggregates++; return original(key, value); }) as typeof results.graphResults.set;
    try {
      for (let i = 0; i < 3; i++) store.commitGraphInput(undefined, session.id);
      expect(aggregates).toBe(0);
    } finally { results.graphResults.set = original; }
  } finally { store.close(); }
});

test("88: every external commit, foreground move and rollback agrees with a fresh graph", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-memory-88-"));
  let reader = new Store(join(dir, "trace.db"));
  const writer = new Store(join(dir, "trace.db"));
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
    const measureRefresh = (sessionId: number) => {
      const tracked = reader as unknown as { graphComponent: (input: unknown, ids: Set<number>) => unknown;
        factOnCurrentPath: (...args: unknown[]) => unknown };
      const originalPart = tracked.graphComponent, originalLiveness = tracked.factOnCurrentPath;
      const parts: Set<number>[] = [], owners: number[] = [];
      tracked.graphComponent = (input, ids) => { parts.push(new Set(ids)); return originalPart.call(reader, input, ids); };
      tracked.factOnCurrentPath = (...args) => { owners.push(args[1] as number); return originalLiveness.apply(reader, args); };
      try { reader.commitGraph(paths[0]!, undefined, undefined, reader.commitGraphInput(undefined, sessionId)); }
      finally { tracked.graphComponent = originalPart; tracked.factOnCurrentPath = originalLiveness; }
      return { parts, owners };
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
    expect(components).toBe(1); expect(aFacts).toBe(0); expect(bFacts).toBe(2); // B fact refresh + one resolver grounding
    check(); // first cursor ends the all-path compatibility, touching B's one component.
    writer.setCurrentPath(b.session.id, "main", b.second.id, "two"); check(); // second complete path restores B
    writer.setCurrentPath(a.session.id, "main", a.second.id, "one"); check();
    const updated = writer.commitConsolidationRun({ path: paths[0]!,
      run: { kind: "manual", sessionId: a.session.id, branch: "main", createdAt: at },
      operations: [{ op: "archive", kind: "budget", knowledgeId: base.knowledgeId, baseCommit: base.commit,
        supports: [a.facts[1]!.id], reason: "new evidence", createdAt: at }] });
    if (!updated.ok) throw Error(updated.problems.join("; "));
    const archiveRefresh = measureRefresh(a.session.id);
    expect(archiveRefresh.parts).toEqual([new Set([base.commit, updated.committed[0]!.commit])]);
    expect(archiveRefresh.owners.length).toBeGreaterThan(0); // newly cited support may need grounding
    expect(new Set(archiveRefresh.owners)).toEqual(new Set([a.session.id]));
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
    writer.mergeProject(project.id, other.id);
    expect(measureRefresh(a.session.id)).toEqual({ parts: [], owners: [] });
    check();
    const moved = writer.createProject({ name: "88-isolated", declaredBy: "mark" });
    writer.declareProject(b.session.id, moved.name, "mark", { path: paths[1]!, atTrigger: () => false });
    expect(measureRefresh(a.session.id)).toEqual({ parts: [], owners: [] });
    check();
    // An uncommitted savepoint must not escape into the committed read projection.
    writer.db.exec("SAVEPOINT probe88");
    writer.setKnowledgeBudget("session", 987);
    writer.db.exec("ROLLBACK TO probe88; RELEASE probe88"); check();
    create(a, a.facts[0]!.id, "session"); check();
    // Deterministic mixed operations; assert against the uncached resolver after every step.
    let cursorSeed = 0x8801;
    for (let step = 0; step < 36; step++) {
      cursorSeed = (Math.imul(cursorSeed, 1664525) + 1013904223) >>> 0;
      switch (cursorSeed % 6) {
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
        pool: range.pool!, origin: range.origin }), createdAt: at });
    const commitComponents: Set<number>[][] = [];
    const maintain = (operation: Parameters<typeof writer.commitConsolidationRun>[0]["operations"][number]) => {
      const result = writer.commitConsolidationRun({ path: target, run, operations: [operation] });
      if (!result.ok) throw Error(result.problems.join("; "));
      const tracked = reader as unknown as { graphComponent: (input: unknown, ids: Set<number>) => unknown };
      const original = tracked.graphComponent, inspected: Set<number>[] = [];
      tracked.graphComponent = (input, ids) => { inspected.push(new Set(ids)); return original.call(reader, input, ids); };
      try { check(); } finally { tracked.graphComponent = original; }
      commitComponents.push(inspected);
      return result.committed;
    };
    const merged = maintain({ op: "merge", intoKnowledgeId: members[0]!.knowledgeId,
      intoBaseCommit: members[0]!.commit, absorb: [{ knowledgeId: members[1]!.knowledgeId, baseCommit: members[1]!.commit }],
      text: "joined", category: "constraint", scope: "global", supports: [a.facts[1]!.id],
      topics: [], reason: "real merge", createdAt: at })[0]!;
    const children = maintain({ op: "split", knowledgeId: merged.knowledgeId, baseCommit: merged.commit,
      children: [{ text: "left", category: "constraint", topics: [] }, { text: "right", category: "constraint", topics: [] }],
      supports: [a.facts[0]!.id], reason: "real split", createdAt: at });
    const transitive = maintain({ op: "merge", intoKnowledgeId: members[2]!.knowledgeId, intoBaseCommit: members[2]!.commit,
      absorb: [{ knowledgeId: children[0]!.knowledgeId, baseCommit: children[0]!.commit }],
      text: "transitive", category: "constraint", scope: "global", supports: [a.facts[0]!.id],
      topics: [], reason: "transitive merge", createdAt: at })[0]!;
    // Actual resolver invocations, not a cache hit or an invalidation signal: each commit
    // recomputes exactly the component it joined, without B's independent revision.
    expect(commitComponents).toHaveLength(3);
    expect(commitComponents.every(parts => parts.length === 1 && !parts[0]!.has(unrelated.commit))).toBe(true);
    expect(commitComponents[0]![0]).toEqual(new Set([members[0]!.commit, members[1]!.commit, merged.commit]));
    expect(commitComponents[1]![0]).toEqual(new Set([members[0]!.commit, members[1]!.commit, merged.commit,
      ...children.map(child => child.commit)]));
    expect(commitComponents[2]![0]).toEqual(new Set([members[0]!.commit, members[1]!.commit, merged.commit,
      ...children.map(child => child.commit), members[2]!.commit, transitive.commit]));
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
    expect(ownerA).toBe(6); // A's two cited facts plus grounding by the two affected components
    expect(ownerB).toBe(0);
    check();
    // Seeded mixed *operation* schedule (not just random cursor values). Each cycle shuffles
    // legal operations, then selects live bases from the independent authoritative graph.
    const operations = ["create", "update", "archive", "merge", "split", "rewind", "revisit",
      "project", "projectMerge", "rollback", "outerRollback", "restart"] as const;
    const schedule: string[] = [];
    let seed = 0x8802, sequence = 0;
    const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    for (let cycle = 0; cycle < 2; cycle++) {
      const shuffled = [...operations];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = random() % (i + 1);
        [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
      }
      for (const op of shuffled) {
        sequence++;
        const active = () => writer.commitGraph(paths[0]!, undefined, undefined, writer.commitGraphInput())
          .current.filter(r => r.scope === "global" && r.op !== "archive");
        const runOp = (operation: Parameters<typeof writer.commitConsolidationRun>[0]["operations"][number]) => {
          // An authorized Dreamer range can operate on existing global identities.
          const result = writer.commitConsolidationRun({ path: target, run, operations: [operation] });
          if (!result.ok) throw Error(`${op} step ${sequence}: ${result.problems.join('; ')}`);
          return result.committed;
        };
        switch (op) {
          case "create": create(a, a.facts[0]!.id, "global"); break;
          case "update": {
            const base = active().at(random() % active().length)!;
            runOp({ op: "update", knowledgeId: base.knowledgeId, baseCommit: base.id, text: `updated ${sequence}`,
              category: "constraint", scope: "global", supports: [a.facts[0]!.id], topics: [], reason: "random update", createdAt: at });
            break;
          }
          case "archive": {
            const base = active().at(random() % active().length)!;
            runOp({ op: "archive", kind: "budget", knowledgeId: base.knowledgeId, baseCommit: base.id,
              supports: [a.facts[0]!.id], reason: "random archive", createdAt: at });
            break;
          }
          case "merge": {
            const choices = active();
            const index = random() % choices.length;
            const pair = [choices[index]!, choices[(index + 1) % choices.length]!].sort((x, y) => x.knowledgeId - y.knowledgeId);
            const [left, right] = pair as [typeof choices[number], typeof choices[number]];
            runOp({ op: "merge", intoKnowledgeId: left.knowledgeId, intoBaseCommit: left.id,
              absorb: [{ knowledgeId: right.knowledgeId, baseCommit: right.id }], text: `merged ${sequence}`,
              category: "constraint", scope: "global", supports: [a.facts[0]!.id], topics: [], reason: "random merge", createdAt: at });
            break;
          }
          case "split": {
            const base = active().at(random() % active().length)!;
            runOp({ op: "split", knowledgeId: base.knowledgeId, baseCommit: base.id,
              children: [{ text: `left ${sequence}`, category: "constraint", topics: [] },
                { text: `right ${sequence}`, category: "constraint", topics: [] }],
              supports: [a.facts[0]!.id], reason: "random split", createdAt: at });
            break;
          }
          case "rewind": writer.setCurrentPath(a.session.id, "root", a.first.id, "one"); break;
          case "revisit": writer.setCurrentPath(a.session.id, "main", a.second.id, "one"); break;
          case "project": {
            const p = writer.createProject({ name: `88-move-${sequence}`, declaredBy: "mark" });
            writer.declareProject(b.session.id, p.name, "mark", { path: paths[1]!, atTrigger: () => false });
            break;
          }
          case "projectMerge": {
            const p = writer.createProject({ name: `88-join-${sequence}`, declaredBy: "mark" });
            writer.mergeProject(writer.getSession(b.session.id)!.projectId, p.id);
            break;
          }
          case "rollback":
            writer.db.exec("SAVEPOINT random88");
            writer.setCurrentPath(b.session.id, "root", b.first.id, "two");
            writer.setKnowledgeBudget("session", 1800 + sequence);
            writer.db.exec("ROLLBACK TO random88; RELEASE random88");
            break;
          case "outerRollback":
            writer.db.exec("BEGIN IMMEDIATE");
            writer.setCurrentPath(a.session.id, "root", a.first.id, "one");
            writer.db.exec("ROLLBACK");
            break;
          case "restart": reader.close(); reader = new Store(join(dir, "trace.db")); break;
        }
        schedule.push(op);
        check();
        if (op === "restart") expect(reader.commitGraphInput(undefined, a.session.id).revisions.length).toBeGreaterThan(0);
      }
    }
    expect(schedule).toEqual([
      "create", "project", "archive", "projectMerge", "update", "restart", "split", "rewind", "revisit", "outerRollback", "merge", "rollback",
      "update", "create", "merge", "restart", "rewind", "outerRollback", "project", "rollback", "revisit", "projectMerge", "split", "archive",
    ]);
    reader.close();
    const restarted = new Store(join(dir, "trace.db"));
    try {
      for (const path of paths) expect(restarted.visibleKnowledgeVersions(path))
        .toEqual(new Set(restarted.commitGraph(path).current.filter(r => r.op !== "archive").map(r => r.id)));
    } finally { restarted.close(); }
  } finally { if (!reader.closed) reader.close(); writer.close(); rmSync(dir, { recursive: true, force: true }); }
});
