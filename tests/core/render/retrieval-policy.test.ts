import { expect, test } from "vitest";
import { canonicalToolNames, tokens } from "../../../src/core/api/index.ts";
import { readingGuide } from "../../../src/core/render/reading-guide.ts";
import { retrievalPolicy } from "../../../src/core/render/retrieval-policy.ts";
import { ccPluginToolNames, ccWorkerToolNames } from "../../../src/hosts/cc/tool-names.ts";

// 137 ruling 1: the reading guide's 200 tokens cover format; the retrieval policy is counted apart; together
// they stay within 500, whichever tool names a host fills in.
test("137: the retrieval policy and the reading guide together stay within 500 tokens for every host's tool names", () => {
  for (const [host, names] of [["pi", canonicalToolNames], ["cc plugin", ccPluginToolNames], ["cc worker", ccWorkerToolNames]] as const) {
    const policy = retrievalPolicy(names);
    expect(policy, host).not.toContain("{{tool.");
    expect(policy, host).toContain(`${names.search};`);
    for (const session of [undefined, 99_999]) expect(tokens(policy) + tokens(readingGuide(session, names)), host).toBeLessThanOrEqual(500);
  }
});
