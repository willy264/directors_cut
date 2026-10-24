import { describe, expect, it } from "vitest";
import { applyVeto, createInitialState, reduce, toPublicState } from "../../src/core/engine.js";
import type { Action, CoreEvent, EngineState, TransitionResult } from "../../src/core/types.js";
import { context, proposal, round, state, title } from "./fixtures.js";

const close: CoreEvent = { t: "round_closed", id: "close", at: 1_100, roundId: "r1", executionId: "e1" };
const snapshot: CoreEvent = { t: "snapshot_ready", id: "snapshot", at: 1_101, roundId: "r1", executionId: "e1", snapshot: { broadcasterId: "100", title: "Actual pre-write title", categoryId: "200", capturedAt: 1_101 } };
const expectTitle = { via: "eventsub", resource: "channel.update", broadcasterId: "100", expected: { title: "Chat directs the show" } } as const;
const accepted: CoreEvent = { t: "execution_accepted", id: "accepted", at: 1_102, roundId: "r1", executionId: "e1", purpose: "execute", expect: expectTitle };
const confirmed: CoreEvent = { t: "execution_confirmed", id: "confirmed", at: 1_103, roundId: "r1", executionId: "e1", purpose: "execute", confirmation: { ...expectTitle, observed: expectTitle.expected } };
function execState(): EngineState { return reduce(reduce(state(), close).state, snapshot).state; }
function waitingState(): EngineState { return reduce(execState(), accepted).state; }
function writes(result: TransitionResult) { return result.commands.filter((cmd) => cmd.t === "helix"); }

describe("round collection", () => {
  it("opens with captured quorum, rejects busy/cooldown opens", () => {
    const open: CoreEvent = { id: "open", t: "round_opened", at: 1_000, roundId: "r1" };
    const initial = state({ round: null });
    const result = reduce(initial, open);
    expect(result.state.round).toMatchObject({ state: "collecting", quorum: 2, closesAt: 1_100 });
    expect(reduce(result.state, { ...open, id: "open2", roundId: "r2" }).state.round?.id).toBe("r1");
    expect(reduce(state({ round: null, context: context({ cooldowns: { globalUntil: 2_000, byActionUntil: {}, shoutoutTargetUntil: {} } }) }), open).state.round).toBeNull();
  });
  it("validates proposals, deduplicates ids, and never mutates source arrays/sets", () => {
    const initial = state({ round: round({ proposals: [], votes: {} }) });
    const event: CoreEvent = { t: "proposal_submitted", id: "proposal", at: 1_010, proposal: proposal() };
    const first = reduce(initial, event);
    expect(first.state.round?.proposals).toHaveLength(1);
    expect(initial.round?.proposals).toHaveLength(0);
    expect(reduce(first.state, { ...event, id: "new-id" }).state.round?.proposals).toHaveLength(1);
    expect(reduce(initial, { ...event, proposal: proposal("bad", { kind: "set_title", params: { title: "blocked word" } }) }).state.round?.proposals).toHaveLength(0);
    const vote: CoreEvent = { t: "vote_cast", id: "v", at: 1_020, roundId: "r1", proposalId: "p1", userId: "viewer" };
    const voted = reduce(first.state, vote);
    expect(voted.state.round?.votes.p1?.size).toBe(1);
    expect(first.state.round?.votes.p1?.size ?? 0).toBe(0);
    expect(reduce(voted.state, { ...vote, id: "v2" }).state.round?.votes.p1?.size).toBe(1);
  });
  it("drops early/late/wrong round events and closes only once", () => {
    const initial = state();
    for (const [at, roundId] of [[999, "r1"], [1_100, "r1"], [1_050, "wrong"]] as const) {
      expect(reduce(initial, { t: "vote_cast", id: `v-${at}`, at, roundId, proposalId: "p1", userId: "c" }).state.round?.votes.p1?.size).toBe(2);
    }
    expect(reduce(initial, { ...close, at: 1_099 }).state.round?.state).toBe("collecting");
    const closed = reduce(initial, close);
    expect(reduce(closed.state, { ...close, id: "close2" }).commands).toHaveLength(0);
  });
  it("refunds all candidates when quorum fails and loses no points silently", () => {
    const result = reduce(state({ round: round({ quorum: 3 }) }), close);
    expect(result.state.round?.state).toBe("failed");
    expect(result.commands).toContainEqual({ t: "refund", roundId: "r1", losingProposalIds: ["p1"] });
    expect(writes(result)).toHaveLength(0);
  });
  it("allows an authenticated force-close while normal timers cannot close early", () => {
    const event = { ...close, at: 1_050, force: true };
    expect(reduce(state(), event).state.round?.state).toBe("executing");
    expect(reduce(state(), { ...event, force: false }).state.round?.state).toBe("collecting");
  });
});

describe("execution and confirmation", () => {
  it("snapshots before writing, captures actual fetched state, and waits for matching confirmation", () => {
    const result = reduce(state(), close);
    expect(result.commands).toContainEqual({ t: "snapshot", roundId: "r1", executionId: "e1" });
    expect(writes(result)).toHaveLength(0);
    const ready = reduce(result.state, snapshot);
    expect(ready.state.round?.revert).toEqual({ kind: "set_title", params: { title: "Actual pre-write title" } });
    expect(writes(ready)).toEqual([{ t: "helix", action: title, roundId: "r1", executionId: "e1", purpose: "execute" }]);
    const waiting = reduce(ready.state, accepted);
    expect(waiting.state.round?.state).toBe("executing");
    expect(waiting.commands).toContainEqual({ t: "await_confirm", roundId: "r1", executionId: "e1", purpose: "execute", expect: expectTitle, timeoutMs: 8_000 });
    expect(reduce(waiting.state, confirmed).state.round?.state).toBe("confirmed");
    expect(ready.state.context.cooldowns.globalUntil).toBe(11_101);
  });
  it("rejects stale or other-channel snapshots", () => {
    const pending = reduce(state(), close).state;
    for (const bad of [{ ...snapshot.snapshot, capturedAt: 1_000 }, { ...snapshot.snapshot, broadcasterId: "other" }]) {
      const result = reduce(pending, { ...snapshot, snapshot: bad });
      expect(writes(result)).toHaveLength(0);
      expect(result.state.round?.state).toBe("failed");
    }
  });
  it("does not accept a topic alone, wrong resource id, broadcaster, execution or purpose", () => {
    const input = waitingState();
    const variants: CoreEvent[] = [
      { ...confirmed, executionId: "wrong" }, { ...confirmed, purpose: "revert" },
      { ...confirmed, confirmation: { ...confirmed.confirmation, broadcasterId: "other" } },
      { ...confirmed, confirmation: { ...confirmed.confirmation, observed: { title: "Wrong" } } },
    ];
    for (const event of variants) expect(reduce(input, event).state.round?.state).toBe("executing");
    const withResource = reduce(execState(), { ...accepted, expect: { ...expectTitle, resourceId: "resource" } }).state;
    expect(reduce(withResource, confirmed).state.round?.state).toBe("executing");
  });
  it("revalidates changed availability between proposal and close, and between snapshot and write", () => {
    expect(writes(reduce(state({ context: context({ allowedActions: new Set() }) }), close))).toHaveLength(0);
    const pending = reduce(state(), close).state;
    const limited = reduce(pending, { t: "context_updated", id: "context", at: 1_100, context: context({ rateLimit: { remaining: 0, resetsAt: 2_000 } }) }).state;
    expect(writes(reduce(limited, snapshot))).toHaveLength(0);
  });
  it("requires authenticated approval after a gated winner, ignores chat param approval", () => {
    const raid: Action = { kind: "raid", params: { toBroadcasterId: "300" } };
    const empty = state({ round: round({ proposals: [], votes: {} }) });
    const proposed = reduce(empty, { t: "proposal_submitted", id: "p", at: 1_010, proposal: proposal("p1", raid) }).state;
    expect(proposed.round?.proposals).toHaveLength(1);
    const winner = reduce({ ...proposed, round: { ...proposed.round!, votes: { p1: new Set(["a", "b"]) } } }, close);
    expect(winner.state.round?.state).toBe("resolving");
    expect(writes(winner)).toHaveLength(0);
    const approval = { roundId: "r1", proposalId: "p1", actionKind: "raid", approvedBy: "100", approvedAt: 1_101 } as const;
    expect(writes(reduce(winner.state, { t: "streamer_approved", id: "bad", at: 1_101, approval: { ...approval, approvedBy: "attacker" } }))).toHaveLength(0);
    expect(writes(reduce(winner.state, { t: "streamer_approved", id: "good", at: 1_101, approval }))).toHaveLength(1);
  });
});

describe("veto and failure races", () => {
  it("veto during collection or pending snapshot prevents every write", () => {
    expect(writes(applyVeto(state(), "r1"))).toHaveLength(0);
    const pending = applyVeto(reduce(state(), close).state, "r1");
    expect(pending.state.round?.state).toBe("vetoed");
    expect(writes(reduce(pending.state, snapshot))).toHaveLength(0);
  });
  it("waits for in-flight write result before undo and performs undo once", () => {
    const veto = applyVeto(execState(), "r1");
    expect(writes(veto)).toHaveLength(0);
    const undo = reduce(veto.state, accepted);
    expect(writes(undo)).toEqual([{ t: "helix", action: { kind: "set_title", params: { title: "Actual pre-write title" } }, roundId: "r1", executionId: "e1:revert", purpose: "revert" }]);
    expect(writes(applyVeto(undo.state, "r1"))).toHaveLength(0);
    expect(writes(reduce(undo.state, { ...accepted, id: "late-duplicate" }))).toHaveLength(0);
    expect(reduce(undo.state, confirmed).state.round?.state).toBe("vetoed");
  });
  it("undo confirmation is independently correlated and original late confirmation cannot complete it", () => {
    const undone = applyVeto(waitingState(), "r1").state;
    const revertExpect = { ...expectTitle, expected: { title: "Actual pre-write title" } };
    const pending = reduce(undone, { ...accepted, id: "revert-accepted", executionId: "e1:revert", purpose: "revert", expect: revertExpect }).state;
    const late = reduce(pending, { ...confirmed, id: "late" }).state;
    expect(late.round?.rollback?.phase).toBe("awaiting_confirmation");
    const result = reduce(late, { ...confirmed, id: "revert-confirmed", executionId: "e1:revert", purpose: "revert", confirmation: { ...revertExpect, observed: revertExpect.expected } });
    expect(result.state.round?.rollback?.phase).toBe("reverted");
    expect(result.state.round?.state).toBe("vetoed");
  });
  it("timeout undoes possible partial changes once and remains failed after undo", () => {
    const timedOut: CoreEvent = { t: "confirmation_timed_out", id: "timeout", at: 9_102, roundId: "r1", executionId: "e1", purpose: "execute" };
    const failed = reduce(waitingState(), timedOut);
    expect(failed.state.round?.state).toBe("failed");
    expect(writes(failed)).toHaveLength(1);
    expect(writes(reduce(failed.state, { ...timedOut, id: "timeout-again" }))).toHaveLength(0);
  });
  it("fails without undo when the provider definitively rejected the write", () => {
    const event: CoreEvent = { t: "execution_failed", id: "failure", at: 1_102, roundId: "r1", executionId: "e1", purpose: "execute", message: "Denied", mayHaveApplied: false };
    const result = reduce(execState(), event);
    expect(result.state.round?.state).toBe("failed");
    expect(writes(result)).toHaveLength(0);
    expect(writes(reduce(execState(), { ...event, mayHaveApplied: true }))).toHaveLength(1);
  });
  it("never invents an undo for a nonreversible action", () => {
    const action: Action = { kind: "create_clip", params: {} };
    const started = reduce(state({ round: round({ proposals: [proposal("p1", action)] }) }), close);
    expect(writes(started)).toHaveLength(1);
    const vetoed = applyVeto(started.state, "r1");
    const result = reduce(vetoed.state, { ...accepted, expect: { via: "helix_read", resource: "clips", broadcasterId: "100", resourceId: "clip1", expected: {} } });
    expect(writes(result)).toHaveLength(0);
    expect(result.state.round?.state).toBe("vetoed");
  });
  it("retains unresolved vetoed execution until original result arrives", () => {
    const pending = applyVeto(execState(), "r1").state;
    const result = reduce(pending, { t: "round_opened", id: "new", at: 20_000, roundId: "r2" });
    expect(result.state.round?.id).toBe("r1");
  });
  it("ignores premature confirmation timers while the original write is still in flight", () => {
    const pending = applyVeto(execState(), "r1").state;
    const result = reduce(pending, { t: "confirmation_timed_out", id: "premature", at: 10_000, roundId: "r1", executionId: "e1", purpose: "execute" });
    expect(writes(result)).toHaveLength(0);
    expect(result.state.round?.execution?.phase).toBe("request_pending");
  });
  it("keeps undo failure visible without retrying irreversible provider writes", () => {
    const undo = applyVeto(waitingState(), "r1");
    const failure: CoreEvent = { t: "execution_failed", id: "undo-failure", at: 1_104, roundId: "r1", executionId: "e1:revert", purpose: "revert", message: "Provider unavailable", mayHaveApplied: true };
    const result = reduce(undo.state, failure);
    expect(result.state.round?.rollback?.phase).toBe("failed");
    expect(result.state.round?.error).toContain("Undo failed");
    expect(writes(result)).toHaveLength(0);
  });
});

describe("replay and recovery", () => {
  it("accepts exact read verification after EventSub loss but never substitutes a write response", () => {
    const waiting = waitingState();
    expect(reduce(waiting, { ...confirmed, confirmation: { ...confirmed.confirmation, via: "helix_read" } }).state.round?.state).toBe("confirmed");
    expect(reduce(waiting, { ...confirmed, confirmation: { ...confirmed.confirmation, via: "helix_response" } }).state.round?.state).toBe("executing");
    expect(reduce(waiting, { ...confirmed, confirmation: { ...confirmed.confirmation, via: "helix_read", observed: { title: "Somebody else's change" } } }).state.round?.state).toBe("executing");
  });
  it("deduplicates event ids across event kinds and bounds the retained history", () => {
    const first = reduce(state(), { t: "vote_cast", id: "same", at: 1_050, roundId: "r1", proposalId: "p1", userId: "c" });
    expect(reduce(first.state, { ...close, id: "same" }).commands).toHaveLength(0);
    const initial = state({ processedEventIds: Array.from({ length: 2_048 }, (_, i) => `history-${i}`) });
    const next = reduce(initial, { t: "vote_cast", id: "new", at: 1_050, roundId: "r1", proposalId: "p1", userId: "c" });
    expect(next.state.processedEventIds).toHaveLength(2_048);
    expect(next.state.processedEventIds).not.toContain("history-0");
    expect(initial.processedEventIds).toHaveLength(2_048);
  });
  it("context refresh cannot erase an execution cooldown or change the active quorum", () => {
    const execution = execState();
    const result = reduce(execution, { t: "context_updated", id: "fresh", at: 1_103, context: context({ config: { ...context().config, quorum: 50 } }) });
    expect(result.state.context.cooldowns.globalUntil).toBe(11_101);
    expect(result.state.round?.quorum).toBe(2);
  });
  it("creates independent context collections and serializes public votes", () => {
    const ctx = context();
    const initial = createInitialState(ctx);
    expect(initial.context.allowedActions).not.toBe(ctx.allowedActions);
    expect(initial.context.resolvedCategoryIds).not.toBe(ctx.resolvedCategoryIds);
    expect(initial.context.cooldowns).not.toBe(ctx.cooldowns);
    const projected = JSON.parse(JSON.stringify(toPublicState(state()))) as { round: { votes: Record<string, string[]> } };
    expect(projected.round.votes.p1).toEqual(["a", "b"]);
  });
  it("refunds losers once and winner once if the director cuts", () => {
    const initial = state({ round: round({ proposals: [proposal(), proposal("p2")], votes: { p1: new Set(["a", "b"]), p2: new Set(["a"]) } }) });
    const closed = reduce(initial, close);
    expect(closed.commands).toContainEqual({ t: "refund", roundId: "r1", losingProposalIds: ["p2"] });
    const vetoed = applyVeto(closed.state, "r1");
    expect(vetoed.commands).toContainEqual({ t: "refund", roundId: "r1", losingProposalIds: ["p1"] });
    expect(applyVeto(vetoed.state, "r1").commands).toHaveLength(0);
  });
  it("restores category from actual snapshot and does not rewrite title", () => {
    const action: Action = { kind: "set_category", params: { categoryId: "200" } };
    const pending = reduce(state({ round: round({ proposals: [proposal("p1", action)] }) }), close).state;
    const ready = reduce(pending, { ...snapshot, snapshot: { ...snapshot.snapshot, categoryId: "123" } });
    expect(ready.state.round?.revert).toEqual({ kind: "set_category", params: { categoryId: "123" } });
  });
  it("rejects approval for the loser and allows only exact pre-approved gated winner", () => {
    const action: Action = { kind: "raid", params: { toBroadcasterId: "300" } };
    const initial = state({ round: round({ proposals: [proposal("p1", action), proposal("p2", action)] }) });
    const wrong = reduce(initial, { t: "streamer_approved", id: "approve-other", at: 1_050, approval: { roundId: "r1", proposalId: "p2", actionKind: "raid", approvedBy: "100", approvedAt: 1_050 } });
    expect(writes(reduce(wrong.state, close))).toHaveLength(0);
    const approved = reduce(initial, { t: "streamer_approved", id: "approve-correct", at: 1_050, approval: { roundId: "r1", proposalId: "p1", actionKind: "raid", approvedBy: "100", approvedAt: 1_050 } });
    expect(writes(reduce(approved.state, close))).toHaveLength(1);
  });
});
