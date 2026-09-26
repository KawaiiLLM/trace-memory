import { expect, test } from "vitest";
import { suppliedHandles } from "./dreaming-skips.ts";

test("92: scripted Dreamer skips only exact supplied header versions, never body tags or diff history", () => {
  const changed = [
    "New K1@v3:",
    "[K1#abcd] current body",
    "Changed K2@v4 (from K2@v2):",
    "- New K7@v1:",
    "+ Archived K8@v2 (reason: quoted change):",
    "Archived K3@v5 (reason: retired):",
    "[K3#efgh] archived predecessor",
    "  archive evidence: F9",
    "  Changed K3@v4 (from K3@v1):",
  ].join("\n");
  expect(suppliedHandles(changed)).toEqual(["K1@v3", "K2@v4", "K3@v5"]);
});

test("92: skip fixture does not silently translate legacy commit addresses", () => {
  expect(suppliedHandles("New:\n[K1@123] old body\nArchived:\nK2@456 archived\nNew K3@789:\n[K4#abcd] body"))
    .toEqual([]);
});
