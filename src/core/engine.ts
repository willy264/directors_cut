import { NotImplementedError } from "./errors.js";
import type { CoreEvent, EngineState, RoundId, TransitionResult } from "./types.js";

/**
 * TODO: Advance one round from normalized events; ignore stale round/execution
 * IDs. Snapshot -> snapshot_ready -> Helix -> verified confirmation. A successful
 * HTTP request alone must not mark an action confirmed. Use event.at as time.
 * Polling clips and direct-response verification are handled by the adapter.
 */
export function reduce(_state: EngineState, _event: CoreEvent): TransitionResult {
  throw new NotImplementedError("reduce");
}

/**
 * TODO: Veto the named round. Restore a captured reversible action only if the
 * original execution may have applied; account for late results after veto.
 * Use state.context.now. Irreversible actions cannot be undone by this function.
 */
export function applyVeto(_state: EngineState, _roundId: RoundId): TransitionResult {
  throw new NotImplementedError("applyVeto");
}
