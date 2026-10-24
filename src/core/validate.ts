import type { Action, ActionKind, Result, ValidationContext, ValidationError, ValidationErrorCode } from "./types.js";

const KEYS: Record<ActionKind, readonly string[]> = {
  set_title: ["title"], set_category: ["categoryId"],
  create_poll: ["title", "choices", "durationSeconds"],
  create_prediction: ["title", "outcomes", "predictionWindowSeconds"],
  create_clip: ["hasDelay"], create_marker: ["description"],
  shoutout: ["toBroadcasterId"], snooze_ad: [],
  resolve_prediction: ["predictionId", "winningOutcomeId"], raid: ["toBroadcasterId"],
};
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: unknown, maximum: number, allowEmpty = false): value is string {
  return typeof value === "string" && (allowEmpty || value.trim().length > 0) && [...value].length <= maximum;
}
function integer(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum;
}
function identifier(value: unknown): value is string { return typeof value === "string" && /^\d+$/.test(value); }
function resourceId(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= 256; }
function strings(value: unknown, minimum: number, maximum: number, length: number): value is string[] {
  return Array.isArray(value) && value.length >= minimum && value.length <= maximum && value.every((item) => text(item, length));
}
function error(code: ValidationErrorCode, message: string, field?: string, retryAt?: number): Result<never, ValidationError> {
  return { ok: false, error: { code, message, ...(field === undefined ? {} : { field }), ...(retryAt === undefined ? {} : { retryAt }) } };
}

/**
 * Validate unknown input, Helix limits, eligibility, supplied moderation,
 * category resolution, cooldowns, budget, snapshots and trusted approval.
 * No fetch, env reads, clock reads or mutation of the provided context.
 */
export function validate(
  input: unknown,
  ctx: ValidationContext,
): Result<Action, ValidationError> {
  if (!record(input) || typeof input.kind !== "string" || !Object.hasOwn(KEYS, input.kind) || !record(input.params)) return error("invalid_action", "Expected a supported action and parameter object.");
  const kind = input.kind as ActionKind;
  const params = input.params;
  if (Object.keys(input).some((key) => key !== "kind" && key !== "params") || Object.keys(params).some((key) => !KEYS[kind].includes(key))) return error("invalid_params", "Unknown action parameters are not accepted.");
  let valid = false;
  const publicText: string[] = [];
  switch (kind) {
    case "set_title": valid = text(params.title, 140); if (valid) publicText.push(params.title as string); break;
    case "set_category": valid = identifier(params.categoryId); break;
    case "create_poll":
      valid = text(params.title, 60) && strings(params.choices, 2, 5, 25) && integer(params.durationSeconds, 15, 1800);
      if (valid) publicText.push(params.title as string, ...params.choices as string[]);
      break;
    case "create_prediction":
      valid = text(params.title, 45) && strings(params.outcomes, 2, 10, 25) && integer(params.predictionWindowSeconds, 30, 1800);
      if (valid) publicText.push(params.title as string, ...params.outcomes as string[]);
      break;
    case "create_clip": valid = params.hasDelay === undefined || params.hasDelay === false; break;
    case "create_marker": valid = text(params.description, 140, true); if (valid) publicText.push(params.description as string); break;
    case "shoutout": case "raid": valid = identifier(params.toBroadcasterId) && params.toBroadcasterId !== ctx.broadcasterId; break;
    case "snooze_ad": valid = true; break;
    case "resolve_prediction": valid = resourceId(params.predictionId) && resourceId(params.winningOutcomeId); break;
  }
  if (!valid) return error("invalid_params", `Invalid parameters for ${kind}.`);
  if (!ctx.allowedActions.has(kind)) return error("action_unavailable", "The channel, granted scopes, or provider capabilities do not allow this action.");
  for (const value of publicText) {
    const normalized = value.normalize("NFKC").toLowerCase();
    if (ctx.blockedTerms.some((term) => term.trim() !== "" && normalized.includes(term.normalize("NFKC").toLowerCase())) || ctx.textVerdicts[value] === "blocked") return error("text_blocked", "Submitted text was blocked by moderation.");
    if (ctx.textVerdicts[value] === "pending") return error("moderation_pending", "Submitted text is awaiting moderation.");
  }
  if (kind === "set_category" && !ctx.resolvedCategoryIds.has(params.categoryId as string)) return error("category_not_found", "Resolve the category before proposing it.", "categoryId");
  if ((kind === "set_title" || kind === "set_category") && (!ctx.channel || ctx.channel.broadcasterId !== ctx.broadcasterId)) return error("snapshot_required", "A same-channel snapshot is required for reversible changes.");
  if (["create_clip", "create_marker", "shoutout", "snooze_ad", "raid"].includes(kind) && !ctx.isLive) return error("stream_offline", "This action requires a live stream.");
  if (kind === "create_poll" && ctx.activePollId !== null) return error("resource_conflict", "There is already an active poll.");
  if (kind === "create_prediction" && ctx.activePredictionId !== null) return error("resource_conflict", "There is already an active prediction.");
  if (kind === "resolve_prediction" && (ctx.activePredictionId !== params.predictionId || !ctx.predictionOutcomeIds.includes(params.winningOutcomeId as string))) return error("resource_conflict", "The prediction or winning outcome does not match the active prediction.");
  if (kind === "snooze_ad" && ctx.adSnoozesRemaining < 1) return error("resource_conflict", "No ad snoozes remain.");
  const until = Math.max(ctx.cooldowns.globalUntil, ctx.cooldowns.byActionUntil[kind] ?? 0, kind === "shoutout" ? ctx.cooldowns.shoutoutTargetUntil[params.toBroadcasterId as string] ?? 0 : 0);
  if (until > ctx.now) return error("cooldown_active", "This action is still cooling down.", undefined, until);
  if (!Number.isFinite(ctx.rateLimit.remaining) || ctx.rateLimit.remaining < ctx.config.minRateLimitRemaining) return error("rate_limit_exhausted", "The known provider rate limit budget is too low.", undefined, ctx.rateLimit.resetsAt);
  if ((kind === "raid" || kind === "resolve_prediction") && ctx.mode !== "proposal") {
    const approval = ctx.approval;
    if (!approval || !ctx.roundId || !ctx.proposalId || approval.roundId !== ctx.roundId || approval.proposalId !== ctx.proposalId || approval.actionKind !== kind || approval.approvedBy !== ctx.broadcasterId || approval.approvedAt > ctx.now) return error("streamer_confirmation_required", "The broadcaster must approve this specific winning proposal in the control panel.");
  }
  // Own nested arrays so subsequent adapter mutation cannot revise accepted actions.
  const action = { kind, params: { ...params } } as Action;
  if (action.kind === "create_poll") return { ok: true, value: { ...action, params: { ...action.params, choices: [...action.params.choices] } } };
  if (action.kind === "create_prediction") return { ok: true, value: { ...action, params: { ...action.params, outcomes: [...action.params.outcomes] } } };
  return { ok: true, value: action };
}
