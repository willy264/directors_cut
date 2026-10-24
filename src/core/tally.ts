import type { Proposal, Round } from "./types.js";

/**
 * Filter by round.quorum, rank distinct voter counts descending, then at
 * ascending, then id using a fixed lexical comparison (not localeCompare).
 * Return null if no proposal qualifies; never mutate proposals or voter sets.
 */
export function tally(round: Round): Proposal | null {
  let winner: Proposal | null = null;
  let count = -1;
  for (const proposal of round.proposals) {
    const votes = round.votes[proposal.id]?.size ?? 0;
    if (proposal.roundId !== round.id || votes < round.quorum) continue;
    if (winner === null || votes > count || (votes === count && (proposal.at < winner.at || (proposal.at === winner.at && proposal.id < winner.id)))) {
      winner = proposal;
      count = votes;
    }
  }
  return winner;
}
