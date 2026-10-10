import type { Store } from "../../core/store/index.ts";
import type { CcSessionBinding } from "./binding.ts";

// A module of its own so the function-hooks bundle (no Node, no database) can use the rule too (137).
/** Whether memory is on for this native session. The binding's enrollment is the record only while
 * no core session exists (a provisional session); once one does, the Store's enrollment decides —
 * automatic off (executions.ts) changes it there and never touches the binding. */
export function sessionEnabled(binding: Pick<CcSessionBinding, "coreSessionId" | "enrollment">, store: Pick<Store, "enabled">): boolean {
  return binding.coreSessionId === null ? binding.enrollment.choice ?? binding.enrollment.defaultEnabled
    : store.enabled(binding.coreSessionId);
}
