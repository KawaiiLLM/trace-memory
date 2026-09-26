export const MEMORY_PHASES = ["noting", "dreaming"] as const;
export type MemoryPhase = typeof MEMORY_PHASES[number];

export const PHASE_SETTING_KEYS = {
  noting: { model: "notingModel", thinking: "notingThinking" },
  dreaming: { model: "dreaming.model", thinking: "dreaming.thinking" },
} as const satisfies Record<MemoryPhase, { model: string; thinking: string }>;

/** Pi's native thinking vocabulary. Hosts may reject values they cannot faithfully execute. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = typeof THINKING_LEVELS[number];
