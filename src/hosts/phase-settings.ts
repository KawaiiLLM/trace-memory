export const MEMORY_PHASES = ["noting", "dreaming"] as const;
export type MemoryPhase = typeof MEMORY_PHASES[number];

export const PHASE_SETTING_KEYS = {
  noting: { model: "notingModel", thinking: "notingThinking" },
  dreaming: { model: "dreaming.model", thinking: "dreaming.thinking" },
} as const satisfies Record<MemoryPhase, { model: string; thinking: string }>;

/** The Dreamer's classify task has its own model and thinking (ticket 144 stage 4 §1.2). It is not a phase: it has no seat and no claim. */
export const CLASSIFY_SETTING_KEYS = { model: "dreaming.classifyModel", thinking: "dreaming.classifyThinking" } as const;

/** Pi's native thinking vocabulary. Hosts may reject values they cannot faithfully execute. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = typeof THINKING_LEVELS[number];
