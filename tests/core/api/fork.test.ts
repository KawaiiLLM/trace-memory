import { describe, expect, it } from "vitest";
import { selectNotingMode } from "../../../src/core/api/fork.ts";
import { noVisibility } from "../../../src/core/api/visible.ts";

const entry = (id: number) => ({ id, turnId: 1, nativeId: `native-${id}` });
const select = (options: Partial<Parameters<typeof selectNotingMode>[0]> = {}) =>
  selectNotingMode({ requested: "fork", publicationPending: false,
    visible: { ...noVisibility(), raw: new Map([["native-1", "source" as const]]) },
    pending: () => [entry(1)], batch: () => [entry(1)], ...options });

describe("shared Noter execution mode", () => {
  it("preserves explicit fresh mode and refuses suppression or unlanded exact-node publication", () => {
    expect(select({ requested: "subagent" }).effectiveMode).toBe("subagent");
    expect(select({ suppression: "fork disabled" }).fallbackReason).toBe("fork disabled");
    expect(select({ publicationPending: true }).fallbackReason).toContain("Knowledge publication");
  });
  it("requires proven source or bounded-carrier coverage of the frozen oldest batch", () => {
    expect(select({ pending: () => [entry(1), entry(2)], batch: () => [entry(1)] }).effectiveMode).toBe("fork");
    expect(select({ pending: () => [entry(1), entry(2)], batch: () => [entry(1), entry(2)] }).fallbackReason)
      .toContain("Raw availability: entry 2");
    expect(select({ visible: noVisibility() }).fallbackReason).toContain("no conversation entry");
    expect(select({ visible: { ...noVisibility(), raw: new Map([["native-1", "view"]]) } }).effectiveMode).toBe("fork");
  });
});
