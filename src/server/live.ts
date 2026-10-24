import type { Action, Confirmation, ConfirmationExpectation, Proposal, ValidationContext } from "../core/types.js";
import type { ActionProvider } from "../effects/executor.js";
import { errorMessage } from "../effects/executor.js";
import { OAuthManager } from "../twitch/oauth.js";
import { HelixClient, HelixError } from "../twitch/helix.js";
import { EventSubClient, buildSubscriptions, normalizeNotification } from "../twitch/eventsub.js";
import { ACTION_SCOPES, type AppConfig } from "./config.js";
import { parseChat } from "./chat.js";
import type { Director } from "./director.js";

export class LiveProvider implements ActionProvider {
  readonly auth: OAuthManager;
  readonly helix: HelixClient;
  director!: Director;
  private socket: EventSubClient | undefined;
  private identityId = "";
  private eligible = false;
  private rewards = new Set<string>();
  private refunded = new Set<string>();
  private tick: ReturnType<typeof setInterval> | undefined;
  private unsubscribeRewards: (() => void) | undefined;
  private generation = 0;
  private transportEpoch = 0;
  private redemptionEvents = new Set<string>();
  constructor(readonly config: AppConfig) {
    this.auth = new OAuthManager({ clientId: config.clientId, clientSecret: config.clientSecret, redirectUri: config.redirectUri, scopes: config.scopes, tokenStorePath: config.tokenStorePath });
    this.helix = new HelixClient({ auth: this.auth, clientId: config.clientId });
  }
  async resume(): Promise<void> {
    if (!this.config.clientId || !this.config.clientSecret || !this.config.broadcasterLogin) {
      this.director.setConnection("disconnected", "Set CLIENT_ID, CLIENT_SECRET and BROADCASTER_LOGIN in .env, then restart and connect Twitch."); return;
    }
    try { if (await this.auth.load()) await this.connect(); }
    catch (error) { this.director.setConnection("error", errorMessage(error)); }
  }
  async connect(): Promise<void> {
    this.stop();
    const generation = this.generation;
    const identity = await this.auth.validate();
    if (identity.login.toLowerCase() !== this.config.broadcasterLogin) throw new Error(`Authorize the configured broadcaster (${this.config.broadcasterLogin}).`);
    const user = await this.helix.getUser(identity.login);
    if (generation !== this.generation) return;
    if (!user || user.id !== identity.userId) throw new Error("Broadcaster identity could not be verified.");
    const previousBroadcaster = this.director.state.round?.snapshot?.broadcasterId;
    if (previousBroadcaster && previousBroadcaster !== user.id) throw new Error("This event log belongs to another broadcaster. Choose a separate EVENT_LOG_PATH.");
    this.identityId = user.id; this.eligible = ["affiliate", "partner"].includes(user.broadcaster_type);
    this.director.broadcaster = { id: user.id, login: user.login, name: user.display_name };
    await this.refreshFacts();
    if (generation !== this.generation) return;
    this.director.prepare = async (action?: Action) => {
      if (!action) return this.refreshFacts();
      if (action.kind === "set_category") {
        const category = await this.helix.getCategory(action.params.categoryId, true);
        if (!category) throw new Error("Twitch did not recognize that category ID.");
        await this.director.updateContext({ resolvedCategoryIds: new Set([...this.director.state.context.resolvedCategoryIds, category.id]), rateLimit: this.helix.rateLimit });
      }
    };
    if (this.config.channelPoints) await this.setupRewards();
    if (generation !== this.generation) return;
    this.socket = new EventSubClient({
      onWelcome: async (sessionId, isMigration) => {
        const epoch = this.transportEpoch;
        if (!isMigration) await Promise.all(buildSubscriptions(user.id, user.id, identity.scopes, this.eligible).map(subscription => this.helix.createSubscription(sessionId, subscription)));
        if (generation !== this.generation || epoch !== this.transportEpoch) return;
        await this.refreshFacts();
        if (generation !== this.generation || epoch !== this.transportEpoch) return;
        this.director.setConnection("connected");
        this.director.note(isMigration ? "Twitch connection migrated; current channel state reconciled." : "Twitch connected and channel state synchronized.");
      },
      onStatus: status => {
        if (generation !== this.generation) return;
        if (status.state === "connected") return; // onWelcome includes subscription setup and resync.
        this.transportEpoch++;
        this.director.setConnection(status.state === "connecting" || status.state === "reconnecting" ? "connecting" : status.state === "error" || status.state === "revoked" ? "error" : "disconnected", status.message || "");
      },
      onRevocation: async subscription => {
        if (generation !== this.generation) return;
        this.director.note(`Twitch revoked ${String(subscription.type)} (${String(subscription.status)}). Reconnect after resolving authorization.`, "failed");
        this.stop(); this.director.setConnection("error", "A required Twitch subscription was revoked. Connect Twitch again.");
      },
      onNotification: async (type, event, metadata) => {
        if (generation !== this.generation) return;
        const confirmation = normalizeNotification(type, event, metadata);
        if (confirmation) await this.director.executor.observe(confirmation, Date.parse(metadata.message_timestamp));
        if (type === "channel.chat.message" && event.broadcaster_user_id === this.identityId) {
          const message = event.message as { text?: string } | undefined;
          if (typeof message?.text !== "string" || typeof event.chatter_user_id !== "string" || !event.chatter_user_id || typeof event.chatter_user_name !== "string") return;
          try {
            const input = parseChat(message.text); if (!input) return;
            const actor = { userId: String(event.chatter_user_id || ""), userName: String(event.chatter_user_name || event.chatter_user_login || "Viewer") };
            if (!actor.userId) return;
            if (input.kind === "vote") await this.director.vote(input.roundId, input.proposalId, actor.userId);
            else await this.director.propose(input.roundId, input.action, actor);
          } catch (error) { this.director.note(`Chat proposal: ${errorMessage(error)}`, "info"); }
        }
        if (type === "channel.channel_points_custom_reward_redemption.add") await this.redemption(event);
        if (["channel.update", "stream.online", "stream.offline", "channel.poll.end", "channel.prediction.end"].includes(type)) await this.refreshFacts();
      },
    });
    this.socket.start();
    this.auth.startValidation(error => { this.socket?.stop(); this.director.setConnection("error", error.message); });
    this.tick = setInterval(() => { if (this.director.connection === "connected") void this.refreshFacts().catch(error => this.director.setConnection("error", errorMessage(error))); }, 30000);
  }
  async refreshFacts(): Promise<void> {
    if (!this.identityId) return;
    const generation = this.generation;
    const scopes = new Set(this.auth.identity?.scopes || []);
    const allowedActions = new Set(this.config.enabledActions.filter(kind => scopes.has(ACTION_SCOPES[kind])
      && (kind !== "snooze_ad" || scopes.has("channel:read:ads"))
      && (this.eligible || !["create_poll", "create_prediction", "resolve_prediction", "snooze_ad"].includes(kind))));
    const [channel, stream, polls, predictions, ads] = await Promise.all([
      this.helix.getChannel(this.identityId), this.helix.getStream(this.identityId),
      this.eligible && scopes.has("channel:manage:polls") ? this.helix.getPolls(this.identityId) : [],
      this.eligible && scopes.has("channel:manage:predictions") ? this.helix.getPredictions(this.identityId) : [],
      this.eligible && scopes.has("channel:read:ads") ? this.helix.getAdSchedule(this.identityId) : null,
    ]);
    const prediction = predictions.find(item => ["ACTIVE", "LOCKED"].includes(item.status));
    if (generation !== this.generation) return;
    const patch: Partial<ValidationContext> = { broadcasterId: this.identityId, isLive: Boolean(stream), channel, allowedActions,
      rateLimit: this.helix.rateLimit, activePollId: polls.find(item => item.status === "ACTIVE")?.id || null,
      activePredictionId: prediction?.id || null, predictionOutcomeIds: prediction?.outcomes.map(item => item.id) || [], adSnoozesRemaining: ads?.snooze_count || 0 };
    await this.director.updateContext(patch);
  }
  async snapshot() { return this.helix.getChannel(this.identityId); }
  async execute(action: Action) {
    if (!this.identityId || this.auth.identity?.userId !== this.identityId) throw new HelixError("Broadcaster authorization is unavailable.", 401, false);
    if (this.director.connection !== "connected") throw new HelixError("Twitch is disconnected. Inspect the channel before retrying.", 0, false);
    return this.helix.execute(action, this.identityId);
  }
  async verify(expect: ConfirmationExpectation): Promise<Confirmation | undefined> {
    if (expect.resource === "clip") return (await this.helix.getClipConfirmation(expect)) || undefined;
    if (expect.resource === "channel.update") {
      const channel = await this.snapshot();
      return { via: "helix_read", resource: expect.resource, broadcasterId: channel.broadcasterId, observed: { title: channel.title, categoryId: channel.categoryId } };
    }
    if ((expect.resource === "channel.poll.begin" || expect.resource.startsWith("channel.prediction.")) && expect.resourceId) {
      const poll = expect.resource === "channel.poll.begin";
      const response = await this.helix.request<{ data: { id: string; broadcaster_id: string; title: string; status: string; winning_outcome_id?: string }[] }>("GET", poll ? "/polls" : "/predictions", { broadcaster_id: this.identityId, id: expect.resourceId });
      const item = response.data.find(item => item.id === expect.resourceId && item.broadcaster_id === this.identityId);
      if (!item || typeof item.status !== "string" || typeof item.title !== "string") return undefined;
      return { via: "helix_read", resource: expect.resource, broadcasterId: item.broadcaster_id, resourceId: item.id,
        observed: { title: item.title, status: item.status.toLowerCase(), ...(item.winning_outcome_id ? { winningOutcomeId: item.winning_outcome_id } : {}) } };
    }
    return undefined;
  }
  private async setupRewards(): Promise<void> {
    const generation = this.generation;
    if (!this.eligible || !this.auth.identity?.scopes.includes("channel:manage:redemptions")) throw new Error("Channel Points require an Affiliate/Partner broadcaster and channel:manage:redemptions.");
    const existing = await this.helix.request<{ data: { id: string; title: string; is_user_input_required: boolean; should_redemptions_skip_request_queue: boolean }[] }>("GET", "/channel_points/custom_rewards", { broadcaster_id: this.identityId, only_manageable_rewards: "true" });
    let reward = existing.data.find(item => item.title === "Director's Cut: propose");
    if (!reward) reward = { ...(await this.helix.createReward(this.identityId, "Director's Cut: propose", this.config.rewardCost, "Copy the active round ID from the overlay. Enter: ROUND_ID title Your title (or poll Question | A | B, clip, marker Text).")), title: "Director's Cut: propose", is_user_input_required: true, should_redemptions_skip_request_queue: false };
    if (!reward.is_user_input_required || reward.should_redemptions_skip_request_queue) throw new Error("The Director's Cut reward must require viewer input and keep redemptions in the request queue.");
    if (generation !== this.generation) return;
    this.rewards.add(reward.id);
    this.director.note("Channel Points proposal reward is ready. Losing proposals are refunded; confirmed winners are fulfilled.");
    this.unsubscribeRewards?.();
    let observedRound = this.director.state.round?.id;
    let observedStatus = this.director.state.round?.state;
    this.unsubscribeRewards = this.director.subscribe(() => {
      const round = this.director.state.round;
      const newlyConfirmed = round?.state === "confirmed" && (round.id !== observedRound || observedStatus !== "confirmed");
      observedRound = round?.id; observedStatus = round?.state;
      if (newlyConfirmed && round?.winner?.redemption) void this.fulfill(round.winner).catch(error => this.director.note(`Points fulfillment: ${errorMessage(error)}`, "failed"));
    });
  }
  private async redemption(event: Record<string, unknown>): Promise<void> {
    const reward = event.reward as { id?: string } | undefined;
    if (!this.config.channelPoints || !reward?.id || !this.rewards.has(reward.id) || event.broadcaster_user_id !== this.identityId || typeof event.id !== "string"
      || event.status !== "unfulfilled" || typeof event.user_id !== "string" || !event.user_id || typeof event.user_name !== "string" || typeof event.user_input !== "string") return;
    if (this.redemptionEvents.has(event.id)) return;
    this.redemptionEvents.add(event.id);
    const redemption = { rewardId: reward.id, redemptionId: event.id };
    try {
      const input = parseChat(`!propose ${String(event.user_input || "")}`);
      if (!input || input.kind !== "proposal") throw new Error("Include the active round ID and an action in the reward input.");
      await this.director.propose(input.roundId, input.action, { userId: String(event.user_id), userName: String(event.user_name) }, redemption);
    } catch (error) {
      await this.helix.refundRedemption(this.identityId, redemption.rewardId, redemption.redemptionId);
      this.director.note(`Point proposal refunded: ${errorMessage(error)}`);
    }
  }
  async refund(proposalIds: readonly string[]): Promise<void> {
    const redemptions = proposalIds.map(id => this.director.state.round?.proposals.find(item => item.id === id)?.redemption);
    const failures: string[] = [];
    for (const redemption of redemptions) {
      if (!redemption || !this.rewards.has(redemption.rewardId) || this.refunded.has(redemption.redemptionId)) continue;
      this.refunded.add(redemption.redemptionId);
      try { await this.helix.refundRedemption(this.identityId, redemption.rewardId, redemption.redemptionId); }
      catch { failures.push(redemption.redemptionId); }
    }
    if (failures.length) throw new Error(`Check these redemptions manually: ${failures.join(", ")}`);
  }
  private async fulfill(proposal: Proposal): Promise<void> {
    const redemption = proposal.redemption;
    if (!redemption || this.refunded.has(redemption.redemptionId)) return;
    this.refunded.add(redemption.redemptionId);
    try { await this.helix.updateRedemption(this.identityId, redemption.rewardId, redemption.redemptionId, "FULFILLED"); }
    catch (error) { throw new Error(`Check redemption ${redemption.redemptionId} manually: ${errorMessage(error)}`); }
  }
  stop(): void { this.generation++; this.transportEpoch++; this.socket?.stop(); this.auth.stopValidation(); if (this.tick) clearInterval(this.tick); this.unsubscribeRewards?.(); this.unsubscribeRewards = undefined; this.director?.setConnection("disconnected"); }
}
