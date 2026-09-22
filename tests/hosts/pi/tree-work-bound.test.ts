import { expect, test, vi } from "vitest";
import { Store } from "../../../src/core/store/index.ts";
import { host, reply } from "./test-host.ts";

// Exercise both host event boundaries, not merely the standalone branch renderer.
test("67: a long before-tree carry and after-tree restore have bounded projection work and start no phase", async () => {
  const h = host({ "noting.triggerTokens": 1, "consolidation.triggerTokens": 1 });
  try {
    h.persist({ role: "user", content: "evidence", timestamp: 1 });
    for (let i = 0; i < 1_200; i++) h.persist(reply(`history ${i} ` + "word ".repeat(30)));
    await h.emit("session_start");
    const store = h.memory.store, head = store.listTurns(1).at(-1)!.id;
    for (const lineage of ["sibling-open", "closed-retained"]) store.setCurrentPath(1, "main", head, lineage);
    const facts = store.commitNotingRun({ run: { kind: "manual", sessionId: 1, createdAt: "now" }, facts: [
      { turnId: head, source: [`T${head}#user`], actor: "user", category: "decision", text: "retain evidence", createdAt: "now" },
    ] });
    if (!facts.ok) throw new Error(facts.problems.join("; "));
    const written = store.commitConsolidationRun({ run: { kind: "manual", sessionId: 1, createdAt: "now" }, operations:
      Array.from({ length: 80 }, (_, i) => ({ op: "create" as const, handle: `$k${i}`, author: "test", text: `rule ${i}`,
        category: "constraint" as const, scope: "session" as const, supports: [facts.facts[0]!.id], topics: [], reason: "fixture", createdAt: "now" })) });
    if (!written.ok) throw new Error(written.problems.join("; "));
    const projection = vi.spyOn(Store.prototype, "commitGraphInput");
    const publication = vi.spyOn(Store.prototype, "publishSourcePath");
    const eligibility = vi.spyOn(Store.prototype, "duePools");
    const cursorOnly = vi.spyOn(Store.prototype, "setCurrentPath");
    try {
      await h.emit("session_before_tree");
      expect(projection.mock.calls.length).toBeLessThanOrEqual(2);
      expect(publication.mock.calls.length).toBeLessThanOrEqual(1);
      process.stdout.write(`67 before-tree ${JSON.stringify({ graphInputs: projection.mock.calls.length, publications: publication.mock.calls.length })}\n`);
      expect(cursorOnly).not.toHaveBeenCalled(); // No second full-path validation just to end the Turn.
      projection.mockClear(); publication.mockClear();
      await h.emit("session_tree");
      expect(publication).toHaveBeenCalledTimes(1);
      expect(publication.mock.calls[0]![2]).toHaveLength(1_201);
      expect(projection.mock.calls.length).toBeLessThanOrEqual(2);
      process.stdout.write(`67 after-tree ${JSON.stringify({ graphInputs: projection.mock.calls.length, publications: publication.mock.calls.length,
        entries: publication.mock.calls[0]![2].length, dueChecks: eligibility.mock.calls.length })}\n`);
      expect(eligibility).not.toHaveBeenCalled();
      await h.drain(); expect(h.requests).toEqual([]);
      expect(store.listSourceEntries(1)).toHaveLength(1_201);
    } finally { projection.mockRestore(); publication.mockRestore(); eligibility.mockRestore(); cursorOnly.mockRestore(); }
  } finally { await h.dispose(); }
}, 30000);

// Each switch uses native selected ancestry, while support owners have independently
// published divergent lineages. No cursor is fabricated as an alias of the reader's head.
test("67: real ancestor rewind and sibling switch preserve evidence carry with diverse support owners", async () => {
  const h = host({ "noting.triggerTokens": 1, "consolidation.triggerTokens": 1 });
  try {
    h.persist({ role: "user", content: "ROOT EVIDENCE", timestamp: 1 });
    for (let i = 0; i < 600; i++) h.persist(reply(`root history ${i}`));
    await h.emit("session_start");
    const ancestor = [...h.entries], store = h.memory.store;
    const root = store.listTurns(1).at(-1)!.id;
    const fact = (sessionId: number, turnId: number, entryId: number, text: string) => {
      const result = store.commitNotingRun({ run: { kind: "manual", sessionId, createdAt: "seed" }, facts: [
        { turnId, entryIds: [entryId], source: [`T${turnId}#user`], actor: "user", category: "decision", text, createdAt: "seed" },
      ] });
      if (!result.ok) throw new Error(result.problems.join("; "));
      return result.facts[0]!.id;
    };
    const rootFact = fact(1, root, store.listSourceEntries(1, root)[0]!.id, "ROOT FACT");
    h.persist({ role: "user", content: "LEFT EVIDENCE", timestamp: 1 });
    for (let i = 0; i < 600; i++) h.persist(reply(`left history ${i}`));
    await h.emit("session_tree");
    const left = [...h.entries], leftHead = store.listTurns(1).at(-1)!.id;
    const leftFact = fact(1, leftHead, store.listSourceEntries(1, leftHead)[0]!.id, "LEFT FACT");
    const owners: { sessionId: number; root: number; rootEntry: number; leftFact: number; rightFact: number }[] = [];
    for (let i = 0; i < 4; i++) {
      const session = store.createSession({ host: `support-owner-${i}`, projectId: store.getSession(1)!.projectId,
        enrollmentChoice: true, startedAt: "seed", firstReplyAt: "seed" });
      const base = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: `owner ${i} root`, startedAt: "seed" });
      const append = (turnId: number, nativeId: string, role: "user" | "assistant") => store.appendSourceEntry({
        sessionId: session.id, turnId, nativeLineage: `owner-${i}`, nativeId, role, text: nativeId,
        raw: JSON.stringify({ role, content: nativeId }), calls: [],
      });
      const baseEntry = append(base.id, "root", "user");
      const branches = ["left", "right"].map(branch => {
        const turn = store.appendTurn({ sessionId: session.id, parentTurnId: base.id, kind: "turn", userPrompt: branch, startedAt: "seed" });
        const entries = [append(turn.id, `${branch}-user`, "user")];
        for (let j = 0; j < 200 + i * 50; j++) entries.push(append(turn.id, `${branch}-${j}`, "assistant"));
        store.publishSourcePath(session.id, branch, [baseEntry.id, ...entries.map(e => e.id)], turn.id, `${branch}-cursor`);
        return fact(session.id, turn.id, entries[0]!.id, `OWNER ${i} ${branch}`);
      });
      owners.push({ sessionId: session.id, root: base.id, rootEntry: baseEntry.id, leftFact: branches[0]!, rightFact: branches[1]! });
    }
    const create = (text: string, supports: number[]) => {
      const result = store.commitConsolidationRun({ run: { kind: "manual", sessionId: 1, createdAt: "seed" }, operations: [
        { op: "create", handle: "$k", author: "test", text, category: "constraint", scope: "global", supports,
          topics: [], reason: "carry fixture", createdAt: "seed" },
      ] });
      if (!result.ok) throw new Error(result.problems.join("; "));
    };
    create("ROOT RULE", [rootFact]); create("LEFT RULE", [leftFact]);
    for (let i = 0; i < 80; i++) {
      const owner = owners[i % owners.length]!;
      create(`FOREIGN ONLY ${i}`, [owner.rightFact]);
      create(`MIXED LEFT ${i}`, [leftFact, owner.leftFact]);
    }
    const graph = vi.spyOn(Store.prototype, "commitGraphInput");
    const publish = vi.spyOn(Store.prototype, "publishSourcePath");
    const due = vi.spyOn(Store.prototype, "duePools");
    const measureCarry = async () => {
      graph.mockClear(); publish.mockClear();
      const result = await h.emit("session_before_tree");
      expect(graph.mock.calls.length).toBeLessThanOrEqual(2);
      expect(publish.mock.calls.length).toBeLessThanOrEqual(1);
      return result.summary.summary as string;
    };
    const select = async (entries: typeof h.entries) => {
      h.entries.splice(0, h.entries.length, ...entries);
      graph.mockClear(); publish.mockClear();
      await h.emit("session_tree");
      expect(publish).toHaveBeenCalledTimes(1);
      expect(graph.mock.calls.length).toBeLessThanOrEqual(2);
      expect(due).not.toHaveBeenCalled();
    };
    try {
      const carry = await measureCarry();
      expect(carry).toContain("ROOT RULE"); expect(carry).toContain("LEFT RULE");
      expect(carry).toContain("MIXED LEFT 0"); expect(carry).not.toContain("FOREIGN ONLY");
      // Moving one owner's left cursor must affect the very next operation. Its right
      // cursor stays on a sibling; paths cannot be stitched together to revive left facts.
      const owner = owners[0]!;
      store.publishSourcePath(owner.sessionId, "root", [owner.rootEntry], owner.root, "left-cursor");
      const changed = await measureCarry();
      expect(changed).not.toContain("MIXED LEFT 0"); expect(changed).toContain("MIXED LEFT 1");
      await select(ancestor);
      const rewound = await measureCarry();
      expect(rewound).toContain("ROOT RULE"); expect(rewound).not.toContain("LEFT FACT");
      expect(rewound).not.toContain("LEFT RULE"); expect(rewound).not.toContain("MIXED LEFT");
      h.persist({ role: "user", content: "RIGHT EVIDENCE", timestamp: 1 });
      for (let i = 0; i < 600; i++) h.persist(reply(`right history ${i}`));
      await select([...h.entries]);
      const rightHead = store.listTurns(1).at(-1)!.id;
      create("RIGHT RULE", [fact(1, rightHead, store.listSourceEntries(1, rightHead)[0]!.id, "RIGHT FACT")]);
      const right = [...h.entries];
      expect(await measureCarry()).toContain("RIGHT RULE");
      await select(left);
      const backLeft = await measureCarry();
      expect(backLeft).toContain("LEFT RULE"); expect(backLeft).not.toContain("RIGHT RULE");
      await select(right);
      const backRight = await measureCarry();
      expect(backRight).toContain("RIGHT RULE"); expect(backRight).not.toContain("LEFT RULE");
      expect(due).not.toHaveBeenCalled(); await h.drain(); expect(h.requests).toEqual([]);
      expect(store.listSourceEntries(1)).toHaveLength(1803);
    } finally { graph.mockRestore(); publish.mockRestore(); due.mockRestore(); }
  } finally { await h.dispose(); }
}, 30000);
