import { Store } from "../../core/store/index.ts";
import { TraceMemory } from "../../core/api/index.ts";
import type { ResolvedCcHostConfig } from "./config.ts";
import { ccResultText } from "./transcript.ts";
import { assertOperatorBinding, coreHostOf, readBinding, updateBindingInStoreTransaction, validateNativeSessionId } from "./binding.ts";
import { controlSession, type OperatorControlResult } from "./control.ts";

export type CcOperatorResult =
  | { command: "on"; nativeSessionId: string; coreSessionId: number | null; enrollment: "enabled" }
  | { command: "off" | "stop" | "catchup"; nativeSessionId: string; control: OperatorControlResult }
  | { command: "project"; nativeSessionId: string; coreSessionId: number; result: string };

export async function enableCcSession(config: ResolvedCcHostConfig, nativeSessionId: string): Promise<CcOperatorResult> {
  const id = validateNativeSessionId(nativeSessionId);
  let coreSessionId: number | null = null;
  const store = new Store(config.dbPath);
  try {
    await updateBindingInStoreTransaction(config, id, store, current => {
      if (!current) throw new Error(`Claude Code session ${id} is not bound; run a SessionStart Hook first`);
      assertOperatorBinding(config, current, store);
      coreSessionId = current.coreSessionId;
      if (current.coreSessionId === null) return current.enrollment.choice === true ? current
        : { ...current, enrollment: { ...current.enrollment, choice: true } };
      store.setEnrollment(current.coreSessionId, true);
      return { ...current, enrollment: store.enrollment(current.coreSessionId) };
    });
  } finally { store.close(); }
  return { command: "on", nativeSessionId: id, coreSessionId, enrollment: "enabled" };
}

export async function operateCcSession(config: ResolvedCcHostConfig, nativeSessionId: string,
  command: "on" | "off" | "stop" | "catchup", timeoutMs?: number): Promise<CcOperatorResult> {
  const id = validateNativeSessionId(nativeSessionId);
  if (command === "on") return enableCcSession(config, id);
  return { command, nativeSessionId: id, control: await controlSession(config, id, command, timeoutMs) };
}

export async function declareCcProject(config: ResolvedCcHostConfig, nativeSessionId: string, name: string): Promise<CcOperatorResult> {
  const id = validateNativeSessionId(nativeSessionId);
  const unavailable = async () => ({ outcome: "failure" as const, output: "operator does not run workers" });
  const memory = TraceMemory(config.dbPath, unavailable, { closedSessionScope: config.closedSessionScope }, ccResultText);
  let result = "", coreSessionId = 0;
  try {
    await updateBindingInStoreTransaction(config, id, memory.store, current => {
      if (!current) throw new Error(`Claude Code session ${id} is not bound; run a SessionStart Hook first`);
      assertOperatorBinding(config, current, memory.store);
      if (current.coreSessionId === null || current.selectedLeafUuid === null)
        throw new Error(`Claude Code session ${id} has no persisted selected source path; project declaration is not ready`);
      const path = memory.store.knowledgePath(current.coreSessionId, current.branch);
      const leaf = memory.store.findSourceEntry(current.coreSessionId, current.nativeSessionId, current.selectedLeafUuid);
      if (path.headTurnId === null || !leaf || leaf.turnId !== path.headTurnId)
        throw new Error(`Claude Code session ${id} has no persisted selected source path; project declaration is not ready`);
      result = memory.declareProject(current.coreSessionId, name, "mark", path);
      const session = memory.store.getSession(current.coreSessionId);
      if (!session || session.host !== coreHostOf(current)) throw new Error("CC binding lost its authoritative core session during project declaration");
      coreSessionId = current.coreSessionId;
      return { ...current, projectId: session.projectId };
    });
    return { command: "project", nativeSessionId: id, coreSessionId, result };
  } finally { memory.close(); }
}
