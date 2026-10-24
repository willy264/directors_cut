import { randomBytes, randomUUID } from "node:crypto";
import { reduce } from "../core/engine.js";
import { validate } from "../core/validate.js";
import type { Actor, Action, CoreEvent, EngineState, Proposal, ValidationContext } from "../core/types.js";
import { Executor, errorMessage, type ActionProvider } from "../effects/executor.js";
import type { AppConfig } from "./config.js";
import { EventLog } from "./event-log.js";

export interface LogItem { id: string; at: number; status: "confirmed" | "failed" | "vetoed" | "info"; message: string; actor?: string; url?: string }
export type Connection = "demo" | "disconnected" | "connecting" | "connected" | "error";
export class Director {
  state: EngineState;
  connection: Connection;
  broadcaster: { id: string; login: string; name: string } | null;
  message = "";
  readonly controlToken = randomBytes(32).toString("hex");
  readonly executor: Executor;
  readonly journal: EventLog;
  readonly log: LogItem[] = [];
  private subscribers = new Set<() => void>();
  private serial: Promise<void> = Promise.resolve();
  private roundTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  prepare: ((action?: Action) => Promise<void>) | undefined;
  constructor(readonly config: AppConfig, readonly provider: ActionProvider) {
    this.connection = config.mode === "demo" ? "demo" : "disconnected";
    this.broadcaster = config.mode === "demo" ? { id: "100", login: "demo_director", name: "Demo Director" } : null;
    this.state = { round: null, context: {
      now: Date.now(), config: config.engine, broadcasterId: this.broadcaster?.id || "", isLive: config.mode === "demo",
      allowedActions: new Set(config.mode === "demo" ? config.enabledActions : []), resolvedCategoryIds: new Set(["509658"]),
      blockedTerms: config.blockedTerms, textVerdicts: {}, cooldowns: { globalUntil: 0, byActionUntil: {}, shoutoutTargetUntil: {} },
      rateLimit: { remaining: 800, resetsAt: Date.now() + 60000 }, channel: null, activePollId: null,
      activePredictionId: null, predictionOutcomeIds: [], adSnoozesRemaining: config.mode === "demo" ? 3 : 0,
    } };
    this.journal = new EventLog(config.eventLogPath);
    this.executor = new Executor(provider, event => this.dispatch(event), message => this.note(message, "failed"));
    if (config.mode === "demo" && provider.readFacts) this.prepare = async () => { await this.updateContext(await provider.readFacts!()); };
  }
  async initialize(): Promise<void> {
    const recovered = await this.journal.recover();
    if (recovered) {
      const round = recovered.round;
      const interrupted = round && (["collecting", "resolving", "executing"].includes(round.state)
        || (round.execution && !["confirmed", "failed", "reverted"].includes(round.execution.phase))
        || (round.rollback && !["reverted", "failed"].includes(round.rollback.phase)));
      this.state = { context: { ...this.state.context, cooldowns: recovered.context.cooldowns }, round: round ? { ...round,
        ...(interrupted ? { state: "failed" as const, awaitingApproval: false, error: "Service restarted during this round. Inspect Twitch before beginning another round.",
          ...(round.execution ? { execution: { ...round.execution, phase: "failed" as const } } : {}),
          ...(round.rollback ? { rollback: { ...round.rollback, phase: "failed" as const } } : {}) } : {}) } : null };
      this.note(interrupted ? "Recovered an interrupted round. No Twitch write was replayed; check the channel before continuing." : "Previous round restored from the local event log.", interrupted ? "failed" : "info");
    }
    if (this.config.mode === "demo") await this.updateContext({ channel: await this.provider.snapshot() });
  }
  subscribe(listener: () => void): () => void { this.subscribers.add(listener); return () => { this.subscribers.delete(listener); }; }
  publish(): void { for (const listener of this.subscribers) listener(); }
  setConnection(connection: Connection, message = ""): void { this.connection = connection; this.message = message; this.publish(); }
  note(message: string, status: LogItem["status"] = "info", extra: Partial<Pick<LogItem, "actor" | "url">> = {}): void {
    this.log.unshift({ id: randomUUID(), at: Date.now(), message, status, ...extra }); this.log.splice(30); this.publish();
  }
  private event() { return { id: randomUUID(), at: Date.now() }; }
  dispatch(input: CoreEvent | (() => CoreEvent)): Promise<void> {
    const next = this.serial.then(async () => {
      if (this.stopped) return;
      const event = typeof input === "function" ? input() : input;
      const before = this.state;
      let result = reduce(before, event);
      if (event.t === "execution_confirmed" && event.confirmation.resource === "channel.update"
        && ((event.purpose === "execute" && result.state.round?.state === "confirmed" && result.state.round.execution?.phase === "confirmed" && before.round?.execution?.phase !== "confirmed")
          || (event.purpose === "revert" && result.state.round?.rollback?.phase === "reverted" && before.round?.rollback?.phase !== "reverted"))
        && result.state.context.channel) {
        const observed = event.confirmation.observed;
        result = { ...result, state: { ...result.state, context: { ...result.state.context, channel: { ...result.state.context.channel,
          ...(typeof observed.title === "string" ? { title: observed.title } : {}),
          ...(typeof observed.categoryId === "string" ? { categoryId: observed.categoryId } : {}), capturedAt: event.at } } } };
      }
      await this.journal.append(event, result.state);
      this.state = result.state;
      const round = this.state.round;
      if (event.t === "execution_confirmed" && round?.state === "confirmed" && before.round?.state !== "confirmed") {
        const url = event.confirmation.observed.url;
        this.note(`${this.config.mode === "demo" ? "Demo: " : ""}${describe(round.winner!.action)} confirmed.`, "confirmed", {
          actor: round.winner!.proposedBy.userName, ...(typeof url === "string" ? { url } : {}),
        });
      }
      if (round?.state === "failed" && before.round?.state !== "failed") this.note(round.error || "Round failed; no confirmed action.", "failed");
      if (round?.state === "vetoed" && before.round?.state !== "vetoed") this.note(round.revert ? "Cut called. Restoring the saved channel state…" : "Cut called. Round stopped; completed irreversible actions cannot be undone.", "vetoed");
      if (round?.rollback?.phase === "reverted" && before.round?.rollback?.phase !== "reverted") this.note("Saved channel state restored and verified.", "vetoed");
      if (round?.rollback?.phase === "failed" && before.round?.rollback?.phase !== "failed") this.note("Restore could not be verified. Check the Twitch dashboard.", "failed");
      this.executor.cancelExcept([round?.execution, round?.rollback].filter(execution => execution?.phase === "awaiting_confirmation").map(execution => execution!.id));
      if (this.roundTimer) clearTimeout(this.roundTimer);
      if (round?.state === "collecting") this.roundTimer = setTimeout(() => { void this.closeRound(round.id).catch(error => this.note(errorMessage(error), "failed")); }, Math.max(0, round.closesAt - Date.now()));
      this.publish();
      for (const command of result.commands) void this.executor.run(command).catch(error => this.note(errorMessage(error), "failed"));
    });
    this.serial = next.catch(error => { this.setConnection("error", `Local event log failed: ${errorMessage(error)}`); });
    return next;
  }
  async updateContext(patch: Partial<ValidationContext>): Promise<void> {
    await this.dispatch(() => ({ ...this.event(), t: "context_updated", context: { ...this.state.context, ...patch, now: Date.now() } }));
  }
  private ready(): void {
    if (this.config.mode === "live" && this.connection !== "connected") throw new Error("Connect Twitch and wait for subscriptions before opening or proposing a round.");
  }
  async openRound(): Promise<void> {
    this.ready(); await this.prepare?.();
    const previous = this.state.round;
    if (previous && (["collecting", "resolving", "executing"].includes(previous.state) || previous.execution?.phase === "request_pending" || (previous.rollback && !["failed", "reverted"].includes(previous.rollback.phase)))) throw new Error("Finish the current round or its restore first.");
    if (this.state.context.cooldowns.globalUntil > Date.now()) throw new Error("The channel is cooling down. Try again shortly.");
    await this.dispatch({ ...this.event(), t: "round_opened", roundId: `r_${randomBytes(4).toString("hex")}` });
  }
  async closeRound(roundId: string, force = false): Promise<void> {
    if (this.state.round?.id !== roundId || this.state.round.state !== "collecting") throw new Error("This round is no longer collecting.");
    // Refresh eligibility and provider resource conflicts immediately before selecting a winner.
    if (this.config.mode === "live" && this.connection !== "connected") { await this.veto(roundId); throw new Error("Twitch disconnected. The round was stopped before execution."); }
    try { await this.prepare?.(); }
    catch (error) { await this.veto(roundId); throw error; }
    await this.dispatch({ ...this.event(), t: "round_closed", roundId, executionId: randomUUID(), force });
  }
  async propose(roundId: string, action: Action, actor: Actor, redemption?: Proposal["redemption"]): Promise<void> {
    this.ready();
    if (this.state.round?.id !== roundId || this.state.round.state !== "collecting" || Date.now() >= this.state.round.closesAt) throw new Error("That round is closed. Use the round ID shown on the overlay.");
    const preflight = validate(action, { ...this.state.context, now: Date.now(), mode: "proposal", roundId });
    if (!preflight.ok && ["invalid_action", "invalid_params"].includes(preflight.error.code)) throw new Error(preflight.error.message);
    await this.prepare?.(action);
    if (this.config.mode === "demo" && action.kind === "set_category") await this.updateContext({ resolvedCategoryIds: new Set([...this.state.context.resolvedCategoryIds, action.params.categoryId]) });
    const result = validate(action, { ...this.state.context, now: Date.now(), mode: "proposal", roundId });
    if (!result.ok) throw new Error(result.error.message);
    const proposal: Proposal = { id: `p_${randomBytes(4).toString("hex")}`, roundId, action: result.value, proposedBy: actor, at: Date.now(), ...(redemption ? { redemption } : {}) };
    await this.dispatch({ ...this.event(), t: "proposal_submitted", proposal });
    if (!this.state.round?.proposals.some(item => item.id === proposal.id)) throw new Error("Proposal arrived after the round closed.");
  }
  async vote(roundId: string, proposalId: string, userId: string): Promise<void> {
    if (this.state.round?.id !== roundId || this.state.round.state !== "collecting" || Date.now() >= this.state.round.closesAt) throw new Error("That voting round has closed.");
    if (!this.state.round.proposals.some(proposal => proposal.id === proposalId)) throw new Error("Unknown proposal ID.");
    await this.dispatch({ ...this.event(), t: "vote_cast", roundId, proposalId, userId });
  }
  async veto(roundId: string): Promise<void> { await this.dispatch({ ...this.event(), t: "veto_requested", roundId }); }
  async approve(roundId: string, proposalId: string): Promise<void> {
    this.ready(); await this.prepare?.();
    const proposal = this.state.round?.winner;
    if (!proposal || proposal.id !== proposalId || proposal.roundId !== roundId || !["raid", "resolve_prediction"].includes(proposal.action.kind)) throw new Error("No matching gated winner awaits approval.");
    await this.dispatch({ ...this.event(), t: "streamer_approved", approval: { roundId, proposalId, actionKind: proposal.action.kind as "raid" | "resolve_prediction", approvedBy: this.state.context.broadcasterId, approvedAt: Date.now() } });
  }
  async settings(input: Record<string, unknown>): Promise<void> {
    const config = { ...this.state.context.config };
    for (const key of ["quorum", "roundWindowMs", "cooldownMs"] as const) {
      const value = input[key]; if (value === undefined) continue;
      const min = key === "quorum" ? 1 : key === "roundWindowMs" ? 1000 : 0;
      const max = key === "quorum" ? 10000 : key === "roundWindowMs" ? 300000 : 3600000;
      if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new Error(`${key} must be from ${min} to ${max}.`);
      config[key] = value;
    }
    await this.updateContext({ config });
  }
  publicState(includeControl = false) {
    const { round, context } = this.state;
    return { mode: this.config.mode, connection: this.connection, connected: ["connected", "demo"].includes(this.connection), broadcaster: this.broadcaster,
      channel: context.channel ? { title: context.channel.title, categoryId: context.channel.categoryId } : null,
      round: round ? { id: round.id, state: round.state, opensAt: round.opensAt, closesAt: round.closesAt, quorum: round.quorum,
        proposals: round.proposals.map(proposal => ({ id: proposal.id, action: proposal.action, proposedBy: proposal.proposedBy, at: proposal.at, votes: round.votes[proposal.id]?.size || 0 })),
        winnerId: round.winner?.id, executionPhase: round.rollback?.phase || round.execution?.phase,
        awaitingApproval: round.awaitingApproval || false,
        canUndo: Boolean(round.revert && round.state === "confirmed"), error: round.error,
      } : null, settings: { quorum: context.config.quorum, roundWindowMs: context.config.roundWindowMs, cooldownMs: context.config.cooldownMs },
      availableActions: [...context.allowedActions], log: this.log, message: this.message, serverTime: Date.now(), ...(includeControl ? { controlToken: this.controlToken } : {}) };
  }
  async stop(): Promise<void> { this.stopped = true; if (this.roundTimer) clearTimeout(this.roundTimer); this.executor.stop(); await this.serial; await this.journal.flush(); }
}
function describe(action: Action): string {
  return action.kind === "set_title" ? `Title “${action.params.title}”` : action.kind.replaceAll("_", " ");
}
