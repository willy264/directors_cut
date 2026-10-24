import { describe, expect, it } from "vitest";
import { validate } from "../../src/core/validate.js";
import type { Action, ValidationContext, ValidationErrorCode } from "../../src/core/types.js";
import { context, title } from "./fixtures.js";

function rejects(action: unknown, code: ValidationErrorCode, ctx = context()): void {
  expect(validate(action, ctx)).toMatchObject({ ok: false, error: { code } });
}
const ordinary: Action[] = [title, { kind: "set_category", params: { categoryId: "200" } },
  { kind: "create_poll", params: { title: "Next?", choices: ["One", "Two"], durationSeconds: 15 } },
  { kind: "create_prediction", params: { title: "Win?", outcomes: ["Yes", "No"], predictionWindowSeconds: 30 } },
  { kind: "create_clip", params: {} }, { kind: "create_marker", params: { description: "Great moment" } },
  { kind: "shoutout", params: { toBroadcasterId: "300" } }, { kind: "snooze_ad", params: {} }];

describe("validate", () => {
  it.each(ordinary)("accepts available valid $kind", (action) => expect(validate(action, context())).toEqual({ ok: true, value: action }));
  it.each([null, [], {}, { kind: "surprise", params: {} }, { kind: "set_title" }])("rejects malformed/unknown actions %j", (action) => rejects(action, "invalid_action"));
  it.each([
    { kind: "set_title", params: { title: "ok", streamerConfirmed: true } },
    { kind: "set_title", params: { title: "ok" }, extra: true },
    { kind: "create_clip", params: { hasDelay: "false" } },
    { kind: "create_clip", params: { hasDelay: true } },
    { kind: "snooze_ad", params: { anything: true } },
    { kind: "raid", params: { toBroadcasterId: "abc" } },
  ])("rejects unknown keys and incorrect parameter types %j", (action) => rejects(action, "invalid_params"));
  it.each(["", "   ", "a".repeat(141)])("rejects invalid title %j", (value) => rejects({ kind: "set_title", params: { title: value } }, "invalid_params"));
  it("accepts title length boundary", () => expect(validate({ kind: "set_title", params: { title: "a".repeat(140) } }, context()).ok).toBe(true));
  it.each([
    { title: "a".repeat(61), choices: ["a", "b"], durationSeconds: 15 },
    { title: "Q", choices: ["a"], durationSeconds: 15 },
    { title: "Q", choices: ["a", "b", "c", "d", "e", "f"], durationSeconds: 15 },
    { title: "Q", choices: ["a".repeat(26), "b"], durationSeconds: 15 },
    { title: "Q", choices: ["a", "b"], durationSeconds: 14 },
    { title: "Q", choices: ["a", "b"], durationSeconds: 1801 },
    { title: "Q", choices: ["a", "b"], durationSeconds: 15.5 },
  ])("rejects poll limits %j", (params) => rejects({ kind: "create_poll", params }, "invalid_params"));
  it.each([
    { title: "a".repeat(46), outcomes: ["a", "b"], predictionWindowSeconds: 30 },
    { title: "Q", outcomes: ["a"], predictionWindowSeconds: 30 },
    { title: "Q", outcomes: Array.from({ length: 11 }, (_, i) => `${i}`), predictionWindowSeconds: 30 },
    { title: "Q", outcomes: ["a", "b".repeat(26)], predictionWindowSeconds: 30 },
    { title: "Q", outcomes: ["a", "b"], predictionWindowSeconds: 29 },
    { title: "Q", outcomes: ["a", "b"], predictionWindowSeconds: 1801 },
  ])("rejects prediction limits %j", (params) => rejects({ kind: "create_prediction", params }, "invalid_params"));
  it("accepts all upper poll and prediction boundaries", () => {
    expect(validate({ kind: "create_poll", params: { title: "a".repeat(60), choices: ["a", "b", "c", "d", "e".repeat(25)], durationSeconds: 1800 } }, context()).ok).toBe(true);
    expect(validate({ kind: "create_prediction", params: { title: "a".repeat(45), outcomes: Array.from({ length: 10 }, (_, i) => `${i}`.repeat(25)), predictionWindowSeconds: 1800 } }, context()).ok).toBe(true);
  });
  it("enforces marker length and live constraints", () => {
    rejects({ kind: "create_marker", params: { description: "a".repeat(141) } }, "invalid_params");
    for (const kind of ["create_clip", "create_marker", "shoutout", "snooze_ad"] as const) {
      const action = ordinary.find((item) => item.kind === kind)!;
      rejects(action, "stream_offline", context({ isLive: false }));
    }
  });
  it("requires real resolved category and a same-channel snapshot", () => {
    rejects({ kind: "set_category", params: { categoryId: "404" } }, "category_not_found");
    rejects(title, "snapshot_required", context({ channel: null }));
    rejects(title, "snapshot_required", context({ channel: { ...context().channel!, broadcasterId: "other" } }));
  });
  it("checks availability, active resources and ad inventory", () => {
    rejects(title, "action_unavailable", context({ allowedActions: new Set() }));
    rejects(ordinary[2], "resource_conflict", context({ activePollId: "poll" }));
    rejects(ordinary[3], "resource_conflict", context({ activePredictionId: "prediction" }));
    rejects({ kind: "snooze_ad", params: {} }, "resource_conflict", context({ adSnoozesRemaining: 0 }));
    rejects({ kind: "shoutout", params: { toBroadcasterId: "100" } }, "invalid_params");
  });
  it("screens every user-facing string including nested choices", () => {
    rejects({ kind: "set_title", params: { title: "A BLOCKED WORD appears" } }, "text_blocked");
    rejects({ kind: "create_poll", params: { title: "Q", choices: ["A", "blocked word"], durationSeconds: 30 } }, "text_blocked");
    rejects(title, "text_blocked", context({ textVerdicts: { "Chat directs the show": "blocked" } }));
    rejects(title, "moderation_pending", context({ textVerdicts: { "Chat directs the show": "pending" } }));
  });
  it("enforces global/action/target cooldown and rate budget conservatively", () => {
    for (const cooldowns of [
      { globalUntil: 1_001, byActionUntil: {}, shoutoutTargetUntil: {} },
      { globalUntil: 0, byActionUntil: { set_title: 1_001 }, shoutoutTargetUntil: {} },
    ]) rejects(title, "cooldown_active", context({ cooldowns }));
    rejects(ordinary[6], "cooldown_active", context({ cooldowns: { globalUntil: 0, byActionUntil: {}, shoutoutTargetUntil: { "300": 1_001 } } }));
    rejects(title, "rate_limit_exhausted", context({ rateLimit: { remaining: 4, resetsAt: 0 } }));
    expect(validate(title, context({ rateLimit: { remaining: 5, resetsAt: 1_001 } })).ok).toBe(true);
  });
  it.each(["raid", "resolve_prediction"] as const)("requires exact authenticated approval for %s", (kind) => {
    const action: Action = kind === "raid" ? { kind, params: { toBroadcasterId: "300" } } : { kind, params: { predictionId: "prediction", winningOutcomeId: "winner" } };
    const base: Partial<ValidationContext> = { roundId: "r1", proposalId: "p1", activePredictionId: "prediction", predictionOutcomeIds: ["winner"] };
    rejects(action, "streamer_confirmation_required", context(base));
    const approval = { roundId: "r1", proposalId: "p1", actionKind: kind, approvedBy: "100", approvedAt: 999 };
    expect(validate(action, context({ ...base, approval })).ok).toBe(true);
    rejects(action, "streamer_confirmation_required", context({ ...base, approval: { ...approval, approvedBy: "intruder" } }));
    rejects(action, "streamer_confirmation_required", context({ ...base, approval: { ...approval, proposalId: "p2" } }));
    rejects(action, "streamer_confirmation_required", context({ ...base, approval: { ...approval, approvedAt: 1_001 } }));
  });
  it("cannot resolve another prediction or an unknown outcome", () => {
    rejects({ kind: "resolve_prediction", params: { predictionId: "wrong", winningOutcomeId: "winner" } }, "resource_conflict");
    rejects({ kind: "resolve_prediction", params: { predictionId: "prediction", winningOutcomeId: "wrong" } }, "resource_conflict", context({ activePredictionId: "prediction", predictionOutcomeIds: ["winner"] }));
  });
  it("copies validated choice arrays instead of retaining caller-owned mutations", () => {
    const choices = ["A", "B"];
    const result = validate({ kind: "create_poll", params: { title: "Question", choices, durationSeconds: 30 } }, context());
    choices[0] = "blocked word";
    expect(result).toMatchObject({ ok: true, value: { params: { choices: ["A", "B"] } } });
  });
  it("proposal mode still checks resources and treats approval as a control concern", () => {
    expect(validate({ kind: "raid", params: { toBroadcasterId: "300" } }, context({ mode: "proposal" })).ok).toBe(true);
    rejects({ kind: "resolve_prediction", params: { predictionId: "unknown", winningOutcomeId: "unknown" } }, "resource_conflict", context({ mode: "proposal" }));
  });
});
