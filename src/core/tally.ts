import { NotImplementedError } from "./errors.js";
import type { Proposal, Round } from "./types.js";

/**
 * TODO: Filter by round.quorum, rank distinct voter counts descending, then at
 * ascending, then id using a fixed lexical comparison (not localeCompare).
 * Return null if no proposal qualifies; never mutate proposals or voter sets.
 */
export function tally(_round: Round): Proposal | null {
  throw new NotImplementedError("tally");
}
