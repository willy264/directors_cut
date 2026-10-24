import { NotImplementedError } from "./errors.js";
import type { Action, Result, ValidationContext, ValidationError } from "./types.js";

/**
 * TODO: Validate unknown input, Helix limits, eligibility, supplied moderation,
 * category resolution, cooldowns, budget, snapshots and trusted approval.
 * No fetch, env reads, clock reads or mutation of the provided context.
 */
export function validate(
  _action: unknown,
  _ctx: ValidationContext,
): Result<Action, ValidationError> {
  throw new NotImplementedError("validate");
}
