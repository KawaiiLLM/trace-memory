import { describe, expect, test } from "vitest";
import { validateNoteOutput, validateSettleOutput } from "./index.ts";

describe("validateNoteOutput", () => {
  const validFact = {
    category: "observation",
    actor: "user",
    text: "The build script uses pnpm, not npm.",
    timestamp: "2026-01-01 10:00",
    source: ["T1#user"],
  };

  test("accepts a well-formed batch", () => {
    const { problems, value } = validateNoteOutput([
      { turn: "S1/T1", title: "pnpm ruling", topic: "tooling", facts: [validFact] },
    ]);
    expect(problems).toEqual([]);
    expect(value).not.toBeNull();
    expect(value![0]!.facts).toHaveLength(1);
  });

  test("rejects a non-array top level", () => {
    const { problems, value } = validateNoteOutput({ not: "an array" });
    expect(value).toBeNull();
    expect(problems.length).toBeGreaterThan(0);
  });

  test("rejects an unknown category", () => {
    const { problems } = validateNoteOutput([
      { turn: "S1/T1", title: "t", topic: "x", facts: [{ ...validFact, category: "guess" }] },
    ]);
    expect(problems.some((p) => p.includes("category"))).toBe(true);
  });

  test("rejects an unknown actor", () => {
    const { problems } = validateNoteOutput([
      { turn: "S1/T1", title: "t", topic: "x", facts: [{ ...validFact, actor: "bot" }] },
    ]);
    expect(problems.some((p) => p.includes("actor"))).toBe(true);
  });

  test("requires an event fact to carry a completion prefix", () => {
    const { problems } = validateNoteOutput([
      { turn: "S1/T1", title: "t", topic: "x", facts: [{ ...validFact, category: "event", text: "ran the migration" }] },
    ]);
    expect(problems.some((p) => p.includes("must start with"))).toBe(true);
  });

  test("accepts an event fact with a completion prefix", () => {
    const { problems } = validateNoteOutput([
      {
        turn: "S1/T1",
        title: "t",
        topic: "x",
        facts: [{ ...validFact, category: "event", text: "completed: ran the migration, tests pass" }],
      },
    ]);
    expect(problems).toEqual([]);
  });

  test("rejects a fact id embedded in fact text", () => {
    const { problems } = validateNoteOutput([
      { turn: "S1/T1", title: "t", topic: "x", facts: [{ ...validFact, text: "See F12 for the earlier ruling." }] },
    ]);
    expect(problems.some((p) => p.includes("embed"))).toBe(true);
  });

  test("rejects an entry id embedded in fact text", () => {
    const { problems } = validateNoteOutput([
      { turn: "S1/T1", title: "t", topic: "x", facts: [{ ...validFact, text: "Confirms E7's constraint." }] },
    ]);
    expect(problems.some((p) => p.includes("embed"))).toBe(true);
  });

  test("accepts a local handle $n as a relation target", () => {
    const { problems } = validateNoteOutput([
      {
        turn: "S1/T1",
        title: "t",
        topic: "x",
        facts: [{ ...validFact, support: [["$1", "weak"]] }],
      },
    ]);
    expect(problems).toEqual([]);
  });

  test("accepts an existing fact id F<n> as a relation target", () => {
    const { problems } = validateNoteOutput([
      {
        turn: "S1/T1",
        title: "t",
        topic: "x",
        facts: [{ ...validFact, negate: [["F101", "strong"]] }],
      },
    ]);
    expect(problems).toEqual([]);
  });

  test("rejects a malformed relation target", () => {
    const { problems } = validateNoteOutput([
      {
        turn: "S1/T1",
        title: "t",
        topic: "x",
        facts: [{ ...validFact, support: [["E7", "weak"]] }],
      },
    ]);
    expect(problems.some((p) => p.includes("target"))).toBe(true);
  });

  test("rejects an unknown relation strength", () => {
    const { problems } = validateNoteOutput([
      {
        turn: "S1/T1",
        title: "t",
        topic: "x",
        facts: [{ ...validFact, support: [["$1", "medium"]] }],
      },
    ]);
    expect(problems.some((p) => p.includes("strength"))).toBe(true);
  });

  test("rejects a malformed turn address", () => {
    const { problems } = validateNoteOutput([{ turn: "T1", title: "t", topic: "x", facts: [] }]);
    expect(problems.some((p) => p.includes("turn"))).toBe(true);
  });

  test("rejects a fact with an empty source", () => {
    const { problems } = validateNoteOutput([
      { turn: "S1/T1", title: "t", topic: "x", facts: [{ ...validFact, source: [] }] },
    ]);
    expect(problems.some((p) => p.includes("source"))).toBe(true);
  });
});

describe("validateSettleOutput", () => {
  test("accepts a well-formed round with all sections", () => {
    const { problems, value } = validateSettleOutput({
      new: [{ handle: "$e1", text: "Use pnpm, not npm.", scope: "project", category: "constraint", supports: ["F1"] }],
      edit: [{ id: "E5", text: "Updated wording.", scope: "project", category: "constraint", supports: ["F2"], because: ["F3"] }],
      merge: [{ into: "E5", absorb: ["E6"], text: "Merged text.", scope: "project", category: "constraint", supports: ["F2", "F3"], because: ["F4"] }],
      delete: [{ id: "E9", because: ["F5"] }],
      not_admitted: [{ id: "F6", because: "duplicate of F2" }],
      near_ack: [{ candidate: "$e1", entry: "E10", because: "different object" }],
      over_budget: false,
    });
    expect(problems).toEqual([]);
    expect(value!.new).toHaveLength(1);
    expect(value!.merge[0]!.absorb).toEqual(["E6"]);
  });

  test("accepts a round with sections omitted", () => {
    const { problems, value } = validateSettleOutput({});
    expect(problems).toEqual([]);
    expect(value).toEqual({ new: [], edit: [], merge: [], delete: [], not_admitted: [], near_ack: [], over_budget: false });
  });

  test("rejects a non-object top level", () => {
    const { problems, value } = validateSettleOutput([]);
    expect(value).toBeNull();
    expect(problems.length).toBeGreaterThan(0);
  });

  test("rejects a malformed new-entry handle", () => {
    const { problems } = validateSettleOutput({ new: [{ handle: "e1", text: "x", scope: "project", category: "term", supports: ["F1"] }] });
    expect(problems.some((p) => p.includes("handle"))).toBe(true);
  });

  test("rejects an unknown scope", () => {
    const { problems } = validateSettleOutput({ new: [{ handle: "$e1", text: "x", scope: "team", category: "term", supports: ["F1"] }] });
    expect(problems.some((p) => p.includes("scope"))).toBe(true);
  });

  test("rejects an unknown category", () => {
    const { problems } = validateSettleOutput({ new: [{ handle: "$e1", text: "x", scope: "project", category: "note", supports: ["F1"] }] });
    expect(problems.some((p) => p.includes("category"))).toBe(true);
  });

  test("rejects a supports entry that is not a fact id", () => {
    const { problems } = validateSettleOutput({ new: [{ handle: "$e1", text: "x", scope: "project", category: "term", supports: ["E1"] }] });
    expect(problems.some((p) => p.includes("supports"))).toBe(true);
  });

  test("rejects an entry id embedded in entry text", () => {
    const { problems } = validateSettleOutput({ new: [{ handle: "$e1", text: "Supersedes E3.", scope: "project", category: "term", supports: ["F1"] }] });
    expect(problems.some((p) => p.includes("embed"))).toBe(true);
  });

  test("rejects a malformed edit id", () => {
    const { problems } = validateSettleOutput({ edit: [{ id: "5", text: "x", scope: "project", category: "term", supports: ["F1"], because: ["F1"] }] });
    expect(problems.some((p) => p.includes("id"))).toBe(true);
  });

  test("rejects a merge whose absorb list holds a non-entry-id", () => {
    const { problems } = validateSettleOutput({
      merge: [{ into: "E1", absorb: ["not-an-id"], text: "x", scope: "project", category: "term", supports: ["F1"], because: ["F1"] }],
    });
    expect(problems.some((p) => p.includes("absorb"))).toBe(true);
  });

  test("accepts a near_ack naming a candidate handle and an entry", () => {
    const { problems } = validateSettleOutput({ near_ack: [{ candidate: "$e2", entry: "E4", because: "different conditions" }] });
    expect(problems).toEqual([]);
  });

  test("rejects a near_ack with a malformed candidate", () => {
    const { problems } = validateSettleOutput({ near_ack: [{ candidate: "e2", entry: "E4", because: "x" }] });
    expect(problems.some((p) => p.includes("candidate"))).toBe(true);
  });
});
