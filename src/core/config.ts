import type { EngineConfig } from "./types.js";

/** The effects/service layer parses env overrides and injects the final config. */
export const DEFAULT_ENGINE_CONFIG: EngineConfig = Object.freeze({
  roundWindowMs: 25_000,
  quorum: 3,
  cooldownMs: 10_000,
  confirmTimeoutMs: 8_000,
  minRateLimitRemaining: 5,
  actionCooldownMs: Object.freeze({ shoutout: 120_000 }),
  shoutoutTargetCooldownMs: 3_600_000,
});
