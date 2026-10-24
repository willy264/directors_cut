import { tally } from "./tally.js";
import { validate } from "./validate.js";
import type {
  Action, Command, Confirmation, ConfirmationExpectation, CoreEvent, EngineState,
  Execution, JsonValue, Round, RoundId, TransitionResult, ValidationContext,
} from "./types.js";

const EVENT_HISTORY_LIMIT = 2_048;
const terminal = (round: Round) => ["confirmed", "failed", "vetoed"].includes(round.state);
const reversible = (action: Action) => action.kind === "set_title" || action.kind === "set_category";

export function createInitialState(context: ValidationContext): EngineState {
  return { round: null, context: copyContext(context), processedEventIds: [] };
}

function copyContext(context: ValidationContext): ValidationContext {
  return {
    ...context,
    config: { ...context.config, actionCooldownMs: { ...context.config.actionCooldownMs } },
    allowedActions: new Set(context.allowedActions), resolvedCategoryIds: new Set(context.resolvedCategoryIds),
    blockedTerms: [...context.blockedTerms], textVerdicts: { ...context.textVerdicts },
    cooldowns: { ...context.cooldowns, byActionUntil: { ...context.cooldowns.byActionUntil }, shoutoutTargetUntil: { ...context.cooldowns.shoutoutTargetUntil } },
    rateLimit: { ...context.rateLimit }, channel: context.channel ? { ...context.channel } : null,
    predictionOutcomeIds: [...context.predictionOutcomeIds],
    ...(context.approval ? { approval: { ...context.approval } } : {}),
  };
}

/** Public projection has no Set objects, account tokens, moderation data or secrets. */
export function toPublicState(state: EngineState): JsonValue {
  return {
    round: state.round ? {
      ...state.round,
      votes: Object.fromEntries(Object.entries(state.round.votes).map(([key, voters]) => [key, [...voters]])),
    } : null,
    now: state.context.now,
    config: state.context.config,
    allowedActions: [...state.context.allowedActions],
    isLive: state.context.isLive,
    broadcasterId: state.context.broadcasterId,
    cooldowns: state.context.cooldowns,
  } as unknown as JsonValue;
}

function result(state: EngineState, commands: readonly Command[] = [], render = true): TransitionResult {
  return { state, commands: render ? [...commands, { t: "render", payload: toPublicState(state) }] : commands };
}

function refund(state: EngineState, ids: readonly string[]): TransitionResult {
  const round = state.round;
  if (!round) return result(state, [], false);
  const fresh = ids.filter((id) => !round.refundedProposalIds?.includes(id));
  if (!fresh.length) return result(state, [], false);
  return {
    state: { ...state, round: { ...round, refundedProposalIds: [...(round.refundedProposalIds ?? []), ...fresh] } },
    commands: [{ t: "refund", roundId: round.id, losingProposalIds: fresh }],
  };
}

function undo(state: EngineState): TransitionResult {
  const round = state.round;
  if (!round?.execution?.mayHaveApplied || !round.revert || round.rollback) return result(state, [], false);
  const rollback: Execution = {
    id: `${round.execution.id}:revert`, purpose: "revert", startedAt: state.context.now, phase: "request_pending",
  };
  return {
    state: { ...state, round: { ...round, rollback } },
    commands: [{ t: "helix", action: round.revert, roundId: round.id, executionId: rollback.id, purpose: "revert" }],
  };
}

function fail(state: EngineState, message: string, mayHaveApplied = false): TransitionResult {
  const round = state.round;
  if (!round) return result(state, [], false);
  const updated: EngineState = {
    ...state, round: {
      ...round, state: round.state === "vetoed" ? "vetoed" : "failed", error: message, awaitingApproval: false,
      ...(round.execution ? { execution: { ...round.execution, phase: "failed", mayHaveApplied: mayHaveApplied || round.execution.mayHaveApplied === true, error: message } } : {}),
    },
  };
  const refunded = refund(updated, round.proposals.map((proposal) => proposal.id));
  const reverted = undo(refunded.state);
  return result(reverted.state, [...refunded.commands, ...reverted.commands]);
}

function dispatch(state: EngineState): TransitionResult {
  const round = state.round;
  if (!round?.winner || !round.execution) return result(state, [], false);
  const checked = validate(round.winner.action, {
    ...state.context, roundId: round.id, proposalId: round.winner.id, mode: "execution",
  });
  if (!checked.ok) return fail(state, checked.error.message);
  const action = checked.value;
  const now = state.context.now;
  const cooldowns = state.context.cooldowns;
  const updated: EngineState = {
    ...state,
    context: {
      ...state.context,
      cooldowns: {
        globalUntil: now + state.context.config.cooldownMs,
        byActionUntil: { ...cooldowns.byActionUntil, [action.kind]: now + (state.context.config.actionCooldownMs[action.kind] ?? 0) },
        shoutoutTargetUntil: action.kind === "shoutout"
          ? { ...cooldowns.shoutoutTargetUntil, [action.params.toBroadcasterId]: now + state.context.config.shoutoutTargetCooldownMs }
          : { ...cooldowns.shoutoutTargetUntil },
      },
    },
    round: { ...round, state: "executing", awaitingApproval: false, execution: { ...round.execution, phase: "request_pending" } },
  };
  return result(updated, [{ t: "helix", action, roundId: round.id, executionId: round.execution.id, purpose: "execute" }]);
}

function start(state: EngineState, executionId: string): TransitionResult {
  const round = state.round;
  if (!round?.winner) return result(state, [], false);
  const checked = validate(round.winner.action, { ...state.context, roundId: round.id, proposalId: round.winner.id, mode: "execution" });
  if (!checked.ok) {
    if (checked.error.code === "streamer_confirmation_required") return result({ ...state, round: { ...round, state: "resolving", awaitingApproval: true, pendingExecutionId: executionId } });
    return fail(state, checked.error.message);
  }
  const needsSnapshot = reversible(checked.value);
  const next: EngineState = {
    ...state,
    round: {
      ...round, state: "executing", awaitingApproval: false,
      execution: { id: executionId, purpose: "execute", startedAt: state.context.now, phase: needsSnapshot ? "snapshot_pending" : "request_pending" },
    },
  };
  return needsSnapshot
    ? result(next, [{ t: "snapshot", roundId: round.id, executionId }])
    : dispatch(next);
}

function equalJson(expected: JsonValue, actual: JsonValue | undefined): boolean {
  if (expected === actual) return true;
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.length === actual.length && expected.every((value, index) => equalJson(value, actual[index]));
  if (expected !== null && typeof expected === "object" && actual !== null && typeof actual === "object" && !Array.isArray(actual)) {
    return Object.entries(expected).every(([key, value]) => equalJson(value, (actual as Record<string, JsonValue>)[key]));
  }
  return false;
}

/** A matching read may recover a missed EventSub event; a write response may not. */
function matches(expect: ConfirmationExpectation, confirmation: Confirmation): boolean {
  const viaMatches = expect.via === confirmation.via || (expect.via === "eventsub" && confirmation.via === "helix_read");
  return viaMatches && expect.resource === confirmation.resource && expect.broadcasterId === confirmation.broadcasterId
    && (expect.resourceId === undefined || expect.resourceId === confirmation.resourceId)
    && Object.entries(expect.expected).every(([key, value]) => equalJson(value, confirmation.observed[key]));
}

function pending(round: Round): boolean {
  if (!terminal(round)) return true;
  // Do not replace the round while a veto is waiting on an in-flight write or undo.
  if (round.execution?.phase === "request_pending") return true;
  if (round.rollback && !["reverted", "failed"].includes(round.rollback.phase)) return true;
  return false;
}

/** Deterministic event reduction. Every identifier and timestamp is supplied. */
export function reduce(input: EngineState, event: CoreEvent): TransitionResult {
  if (!event.id || !Number.isFinite(event.at) || input.processedEventIds?.includes(event.id)) return result(input, [], false);
  const state: EngineState = {
    ...input,
    context: { ...input.context, now: Math.max(input.context.now, event.at) },
    processedEventIds: [...(input.processedEventIds ?? []), event.id].slice(-EVENT_HISTORY_LIMIT),
  };
  const round = state.round;
  const ignore = () => result(state, [], false);
  if (event.t === "context_updated") {
    const context = copyContext(event.context);
    // External refreshes can tighten cooldowns but cannot erase guards already set by this engine.
    const byActionUntil = { ...context.cooldowns.byActionUntil };
    for (const [kind, until] of Object.entries(state.context.cooldowns.byActionUntil)) {
      const key = kind as keyof typeof byActionUntil;
      byActionUntil[key] = Math.max(byActionUntil[key] ?? 0, until);
    }
    const shoutoutTargetUntil = { ...context.cooldowns.shoutoutTargetUntil };
    for (const [key, until] of Object.entries(state.context.cooldowns.shoutoutTargetUntil)) shoutoutTargetUntil[key] = Math.max(shoutoutTargetUntil[key] ?? 0, until);
    return result({ ...state, context: { ...context, now: state.context.now, cooldowns: { globalUntil: Math.max(context.cooldowns.globalUntil, state.context.cooldowns.globalUntil), byActionUntil, shoutoutTargetUntil }, ...(state.context.approval ? { approval: state.context.approval } : {}) } });
  }
  if (event.t === "round_opened") {
    if (!event.roundId || (round && (pending(round) || round.id === event.roundId)) || state.context.cooldowns.globalUntil > event.at) return ignore();
    return result({ ...state, round: { id: event.roundId, state: "collecting", opensAt: event.at, closesAt: event.at + state.context.config.roundWindowMs, quorum: state.context.config.quorum, proposals: [], votes: {} } });
  }
  if (!round) return ignore();
  if (event.t === "proposal_submitted") {
    const proposal = event.proposal;
    if (round.state !== "collecting" || proposal.roundId !== round.id || !proposal.id || !proposal.proposedBy.userId || round.proposals.some((candidate) => candidate.id === proposal.id) || event.at < round.opensAt || state.context.now >= round.closesAt || proposal.at < round.opensAt || proposal.at >= round.closesAt || proposal.at > event.at) return ignore();
    const checked = validate(proposal.action, { ...state.context, roundId: round.id, proposalId: proposal.id, mode: "proposal" });
    if (!checked.ok) return ignore();
    const copy = { ...proposal, action: checked.value, proposedBy: { ...proposal.proposedBy }, ...(proposal.redemption ? { redemption: { ...proposal.redemption } } : {}) };
    return result({ ...state, round: { ...round, proposals: [...round.proposals, copy], votes: { ...round.votes, [proposal.id]: new Set<string>() } } });
  }
  if (event.t === "streamer_approved") {
    const approval = event.approval;
    const proposal = round.proposals.find((candidate) => candidate.id === approval.proposalId);
    if (terminal(round) || round.state === "executing" || approval.roundId !== round.id || approval.approvedBy !== state.context.broadcasterId || approval.approvedAt > event.at || approval.approvedAt < round.opensAt || !proposal || approval.actionKind !== proposal.action.kind || !["raid", "resolve_prediction"].includes(proposal.action.kind) || (round.winner && round.winner.id !== approval.proposalId)) return ignore();
    const approved = { ...state, context: { ...state.context, approval: { ...approval } } };
    return round.awaitingApproval && round.pendingExecutionId ? start(approved, round.pendingExecutionId) : result(approved);
  }
  if (event.roundId !== round.id) return ignore();
  switch (event.t) {
    case "vote_cast": {
      if (round.state !== "collecting" || event.at < round.opensAt || state.context.now >= round.closesAt || !event.userId || !round.proposals.some((proposal) => proposal.id === event.proposalId)) return ignore();
      const previous = round.votes[event.proposalId];
      if (previous?.has(event.userId)) return ignore();
      const voters = new Set(previous ?? []);
      voters.add(event.userId);
      return result({ ...state, round: { ...round, votes: { ...round.votes, [event.proposalId]: voters } } });
    }
    case "round_closed": {
      if (round.state !== "collecting" || (event.at < round.closesAt && event.force !== true) || event.at < round.opensAt || !event.executionId) return ignore();
      const winner = tally(round);
      if (!winner) return fail(state, "No proposal reached quorum.");
      const resolved: EngineState = { ...state, round: { ...round, state: "resolving", winner, pendingExecutionId: event.executionId } };
      const losers = refund(resolved, round.proposals.filter((proposal) => proposal.id !== winner.id).map((proposal) => proposal.id));
      const started = start(losers.state, event.executionId);
      return { state: started.state, commands: [...losers.commands, ...started.commands] };
    }
    case "snapshot_ready": {
      if (round.state !== "executing" || round.execution?.id !== event.executionId || round.execution.phase !== "snapshot_pending" || !round.winner) return ignore();
      const snapshot = event.snapshot;
      if (snapshot.broadcasterId !== state.context.broadcasterId || snapshot.capturedAt < round.execution.startedAt || snapshot.capturedAt > event.at || !Number.isFinite(snapshot.capturedAt)) return fail(state, "The pre-write channel snapshot is stale or belongs to another channel.");
      const action = round.winner.action;
      if (!reversible(action)) return fail(state, "This action does not use a channel snapshot.");
      return dispatch({
        ...state, context: { ...state.context, channel: { ...snapshot } },
        round: { ...round, snapshot: { ...snapshot }, revert: action.kind === "set_title" ? { kind: "set_title", params: { title: snapshot.title } } : { kind: "set_category", params: { categoryId: snapshot.categoryId } } },
      });
    }
    case "veto_requested": return applyVeto(state, round.id);
    case "execution_accepted": {
      const execution = event.purpose === "revert" ? round.rollback : round.execution;
      if (!execution || execution.id !== event.executionId || execution.purpose !== event.purpose || execution.phase !== "request_pending" || event.at < execution.startedAt || event.expect.broadcasterId !== state.context.broadcasterId) return ignore();
      const update: Execution = { ...execution, phase: "awaiting_confirmation", mayHaveApplied: true, expect: event.expect };
      const next = { ...state, round: { ...round, [event.purpose === "revert" ? "rollback" : "execution"]: update } };
      if (event.purpose === "execute" && (round.state === "vetoed" || round.state === "failed")) {
        const reverted = undo(next);
        return result(reverted.state, reverted.commands);
      }
      return result(next, [{ t: "await_confirm", roundId: round.id, executionId: execution.id, purpose: execution.purpose, expect: event.expect, timeoutMs: state.context.config.confirmTimeoutMs }]);
    }
    case "execution_confirmed": {
      const execution = event.purpose === "revert" ? round.rollback : round.execution;
      if (!execution || execution.id !== event.executionId || execution.purpose !== event.purpose || !execution.expect || execution.phase !== "awaiting_confirmation" || event.at < execution.startedAt || !matches(execution.expect, event.confirmation)) return ignore();
      const update: Execution = { ...execution, phase: event.purpose === "revert" ? "reverted" : "confirmed", mayHaveApplied: true };
      const next: EngineState = { ...state, round: { ...round, state: event.purpose === "execute" && round.state === "executing" ? "confirmed" : round.state, [event.purpose === "revert" ? "rollback" : "execution"]: update } };
      if (event.purpose === "execute" && (round.state === "vetoed" || round.state === "failed")) {
        const reverted = undo(next);
        return result(reverted.state, reverted.commands);
      }
      return result(next);
    }
    case "execution_failed": case "confirmation_timed_out": {
      const execution = event.purpose === "revert" ? round.rollback : round.execution;
      if (!execution || execution.id !== event.executionId || execution.purpose !== event.purpose || ["failed", "confirmed", "reverted"].includes(execution.phase) || event.at < execution.startedAt) return ignore();
      if (event.t === "confirmation_timed_out" && execution.phase !== "awaiting_confirmation") return ignore();
      const message = event.t === "execution_failed" ? event.message : "Timed out waiting for provider confirmation.";
      if (event.purpose === "revert") return result({ ...state, round: { ...round, rollback: { ...execution, phase: "failed", error: message }, error: `Undo failed: ${message}` } });
      return fail(state, message, event.t === "execution_failed" ? event.mayHaveApplied : execution.phase !== "snapshot_pending");
    }
  }
}

/** Veto cancels unsent writes; already sent writes require settled evidence before undo. */
export function applyVeto(state: EngineState, roundId: RoundId): TransitionResult {
  const round = state.round;
  if (!round || round.id !== roundId || round.state === "vetoed") return result(state, [], false);
  const updated: EngineState = { ...state, round: { ...round, state: "vetoed", awaitingApproval: false } };
  const refunded = refund(updated, round.proposals.map((proposal) => proposal.id));
  const reverted = undo(refunded.state);
  return result(reverted.state, [...refunded.commands, ...reverted.commands]);
}
