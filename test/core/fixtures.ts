import { DEFAULT_ENGINE_CONFIG } from "../../src/core/config.js";
import type { Action, EngineState, Proposal, Round, ValidationContext } from "../../src/core/types.js";

export const title: Action = { kind: "set_title", params: { title: "Chat directs the show" } };
export function context(overrides: Partial<ValidationContext> = {}): ValidationContext {
  return {
    now: 1_000,
    config: { ...DEFAULT_ENGINE_CONFIG, roundWindowMs: 100, quorum: 2 },
    broadcasterId: "100",
    isLive: true,
    allowedActions: new Set(["set_title", "set_category", "create_poll", "create_prediction", "create_clip", "create_marker", "shoutout", "snooze_ad", "resolve_prediction", "raid"]),
    resolvedCategoryIds: new Set(["200"]),
    blockedTerms: ["blocked word"],
    textVerdicts: {},
    cooldowns: { globalUntil: 0, byActionUntil: {}, shoutoutTargetUntil: {} },
    rateLimit: { remaining: 100, resetsAt: 10_000 },
    channel: { broadcasterId: "100", title: "Before", categoryId: "200", capturedAt: 1_000 },
    activePollId: null, activePredictionId: null, predictionOutcomeIds: [], adSnoozesRemaining: 2,
    ...overrides,
  };
}
export function proposal(id = "p1", action = title, at = 1_010): Proposal {
  return { id, roundId: "r1", action, at, proposedBy: { userId: `user-${id}`, userName: id } };
}
export function round(overrides: Partial<Round> = {}): Round {
  return { id: "r1", state: "collecting", opensAt: 1_000, closesAt: 1_100, quorum: 2, proposals: [proposal()], votes: { p1: new Set(["a", "b"]) }, ...overrides };
}
export function state(overrides: Partial<EngineState> = {}): EngineState {
  return { round: round(), context: context(), ...overrides };
}
