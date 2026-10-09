import { z } from "zod";

/** 133: live agent state supplied by the function hook, not reconstructed from historical launches. */
export const ccRunningTasksSchema = z.array(z.object({ id: z.string().min(1), kind: z.string(),
  description: z.string(), status: z.enum(["running", "waiting"]) })).default([]);
