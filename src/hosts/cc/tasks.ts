import type { RunningTask } from "../../core/render/material.ts";

/** 133: malformed live agent records are omitted individually, not a native-compaction trigger. */
export function ccRunningTasks(value: unknown): RunningTask[] {
  if (!Array.isArray(value)) return [];
  const tasks: RunningTask[] = [];
  for (const agent of value) {
    if (agent === null || typeof agent !== "object" || Array.isArray(agent)) continue;
    const record = agent as Record<string, unknown>;
    if (typeof record.id !== "string" || !record.id || typeof record.kind !== "string" ||
        typeof record.description !== "string" || (record.status !== "running" && record.status !== "waiting")) continue;
    tasks.push({ id: record.id, kind: record.kind, description: record.description, status: record.status });
  }
  return tasks;
}
