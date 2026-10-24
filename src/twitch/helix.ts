import type { Action, ChannelSnapshot, Confirmation, ConfirmationExpectation, JsonValue } from "../core/types.js";

export interface TokenProvider { getAccessToken(): Promise<string>; refresh(rejectedToken?: string): Promise<string>; }
export interface HelixOptions { auth: TokenProvider; clientId: string; fetch?: typeof fetch; now?: () => number; }
export interface TwitchUser { id: string; login: string; display_name: string; broadcaster_type: string; }
export interface TwitchStream { id: string; user_id: string; type: string; viewer_count: number; }
export interface TwitchCategory { id: string; name: string; }
export interface TwitchPoll { id: string; status: string; title: string; }
export interface TwitchPrediction { id: string; status: string; title: string; outcomes: {id: string; title: string}[]; }
export interface Subscription { type: string; version: string; condition: Record<string, string>; }
export interface ExecutionReceipt { expect: ConfirmationExpectation; confirmation?: Confirmation; confirmationTimeoutMs?: number; }
interface Data<T> { data: T[]; }
type Fields = Record<string, JsonValue>;

export class HelixError extends Error {
  constructor(message: string, readonly status: number, readonly mayHaveApplied = false, readonly retryAt?: number) {
    super(message); this.name = "HelixError";
  }
}

/** All retries are explicit: only a rejected 401 is retried once after refresh. */
export class HelixClient {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private budget = { remaining: 800, resetsAt: 0 };
  private readonly pendingClipEdits = new Map<string, { editUrl: string; expiresAt: number }>();
  constructor(private readonly options: HelixOptions) { this.fetcher = options.fetch ?? fetch; this.now = options.now ?? Date.now; }
  get rateLimit(): { remaining: number; resetsAt: number } { return { ...this.budget }; }

  async request<T>(method: string, path: string, query: Record<string, string> = {}, body?: unknown): Promise<T> {
    if (!path.startsWith("/") || path.includes("://")) throw new HelixError("Invalid Helix path", 0);
    if (this.budget.remaining === 0 && this.budget.resetsAt > this.now()) throw new HelixError("Twitch rate limit is cooling down", 429, false, this.budget.resetsAt);
    const url = new URL(`https://api.twitch.tv/helix${path}`);
    url.search = new URLSearchParams(query).toString();
    let token = await this.options.auth.getAccessToken();
    for (let attempt = 0; attempt < 2; attempt++) {
      let response: Response;
      try {
        response = await this.fetcher(url, { method,
          headers: { "Client-Id": this.options.clientId, Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000),
        });
      } catch { throw new HelixError("Twitch request interrupted; its outcome may be unknown", 0, method !== "GET"); }
      const remaining = response.headers.get("Ratelimit-Remaining");
      const reset = response.headers.get("Ratelimit-Reset");
      if (remaining !== null && Number.isFinite(Number(remaining))) this.budget.remaining = Number(remaining);
      if (reset !== null && Number.isFinite(Number(reset))) this.budget.resetsAt = Number(reset) * 1000;
      if (response.status === 401 && attempt === 0) { token = await this.options.auth.refresh(token); continue; }
      if (response.status === 429) {
        const retry = Number(response.headers.get("Retry-After") ?? 0);
        this.budget = { remaining: 0, resetsAt: Math.max(this.budget.resetsAt, this.now() + (retry > 0 ? retry * 1000 : 60_000)) };
        throw new HelixError("Twitch rate limit reached; wait before trying again", 429, false, this.budget.resetsAt);
      }
      if (!response.ok) throw new HelixError(`Twitch ${method} ${path} returned HTTP ${response.status}`, response.status, method !== "GET" && response.status >= 500);
      if (response.status === 204) return undefined as T;
      try { return await response.json() as T; }
      catch { throw new HelixError("Twitch returned an unreadable response", response.status, method !== "GET"); }
    }
    throw new HelixError("Twitch authorization failed", 401);
  }
  async getUser(login: string): Promise<TwitchUser | null> {
    return (await this.request<Data<TwitchUser>>("GET", "/users", { login })).data[0] ?? null;
  }
  async getStream(broadcasterId: string): Promise<TwitchStream | null> {
    return (await this.request<Data<TwitchStream>>("GET", "/streams", { user_id: broadcasterId })).data[0] ?? null;
  }
  async getCategory(nameOrId: string, byId = false): Promise<TwitchCategory | null> {
    return (await this.request<Data<TwitchCategory>>("GET", "/games", { [byId ? "id" : "name"]: nameOrId })).data[0] ?? null;
  }
  async getChannel(broadcasterId: string): Promise<ChannelSnapshot> {
    const channel = (await this.request<Data<{ broadcaster_id: string; title: string; game_id: string }>>("GET", "/channels", { broadcaster_id: broadcasterId })).data[0];
    if (!channel || channel.broadcaster_id !== broadcasterId || typeof channel.title !== "string" || typeof channel.game_id !== "string") throw new HelixError("Channel information not found or incomplete", 404);
    return { broadcasterId, title: channel.title, categoryId: channel.game_id, capturedAt: this.now() };
  }
  async getPolls(broadcasterId: string): Promise<TwitchPoll[]> {
    return (await this.request<Data<TwitchPoll>>("GET", "/polls", { broadcaster_id: broadcasterId, first: "20" })).data;
  }
  async getPredictions(broadcasterId: string): Promise<TwitchPrediction[]> {
    return (await this.request<Data<TwitchPrediction>>("GET", "/predictions", { broadcaster_id: broadcasterId, first: "20" })).data;
  }
  async getAdSchedule(broadcasterId: string): Promise<{ snooze_count: number; next_ad_at?: string } | null> {
    const data = (await this.request<Data<{ snooze_count: number | string; next_ad_at?: string }>>("GET", "/channels/ads", { broadcaster_id: broadcasterId })).data[0];
    return data ? { ...data, snooze_count: Number(data.snooze_count) } : null;
  }
  async createSubscription(sessionId: string, subscription: Subscription): Promise<void> {
    await this.request("POST", "/eventsub/subscriptions", {}, { ...subscription, transport: { method: "websocket", session_id: sessionId } });
  }
  async createReward(broadcasterId: string, title: string, cost: number, prompt: string): Promise<{id: string}> {
    return first(await this.request<Data<{id: string}>>("POST", "/channel_points/custom_rewards", { broadcaster_id: broadcasterId }, {
      title, cost, prompt, is_user_input_required: true, should_redemptions_skip_request_queue: false,
    }));
  }
  async refundRedemption(broadcasterId: string, rewardId: string, redemptionId: string): Promise<void> {
    await this.updateRedemption(broadcasterId, rewardId, redemptionId, "CANCELED");
  }
  async updateRedemption(broadcasterId: string, rewardId: string, redemptionId: string, status: "CANCELED" | "FULFILLED"): Promise<void> {
    await this.request("PATCH", "/channel_points/custom_rewards/redemptions", { broadcaster_id: broadcasterId, reward_id: rewardId, id: redemptionId }, { status });
  }
  async execute(action: Action, broadcasterId: string): Promise<ExecutionReceipt> {
    const event = (resource: string, expected: Fields, resourceId?: string): ExecutionReceipt => ({
      expect: { via: "eventsub", resource, broadcasterId, expected, ...(resourceId ? { resourceId } : {}) },
    });
    const direct = (resource: string, observed: Fields, resourceId?: string): ExecutionReceipt => {
      const identity = { via: "helix_response" as const, resource, broadcasterId, ...(resourceId ? { resourceId } : {}) };
      return { expect: { ...identity, expected: observed }, confirmation: { ...identity, observed } };
    };
    switch (action.kind) {
      case "set_title":
        await this.request("PATCH", "/channels", { broadcaster_id: broadcasterId }, { title: action.params.title });
        return event("channel.update", { title: action.params.title });
      case "set_category":
        await this.request("PATCH", "/channels", { broadcaster_id: broadcasterId }, { game_id: action.params.categoryId });
        return event("channel.update", { categoryId: action.params.categoryId });
      case "create_poll": {
        const poll = first(await this.request<Data<{id: string}>>("POST", "/polls", {}, {
          broadcaster_id: broadcasterId, title: action.params.title, choices: action.params.choices.map(title => ({ title })), duration: action.params.durationSeconds,
        }));
        return event("channel.poll.begin", { title: action.params.title }, resourceId(poll));
      }
      case "create_prediction": {
        const prediction = first(await this.request<Data<{id: string}>>("POST", "/predictions", {}, {
          broadcaster_id: broadcasterId, title: action.params.title, outcomes: action.params.outcomes.map(title => ({ title })), prediction_window: action.params.predictionWindowSeconds,
        }));
        return event("channel.prediction.begin", { title: action.params.title }, resourceId(prediction));
      }
      case "create_clip": {
        const clip = first(await this.request<Data<{id: string; edit_url: string}>>("POST", "/clips", { broadcaster_id: broadcasterId }));
        const id = resourceId(clip);
        for (const [key, edit] of this.pendingClipEdits) if (edit.expiresAt < this.now()) this.pendingClipEdits.delete(key);
        if (typeof clip.edit_url === "string") this.pendingClipEdits.set(id, { editUrl: clip.edit_url, expiresAt: this.now() + 120_000 });
        return { expect: { via: "helix_read", resource: "clip", broadcasterId, resourceId: id, expected: {} }, confirmationTimeoutMs: 60_000 };
      }
      case "create_marker": {
        const marker = first(await this.request<Data<{id: string; description: string; position_seconds: number}>>("POST", "/streams/markers", {}, { user_id: broadcasterId, description: action.params.description }));
        if (typeof marker.description !== "string" || !Number.isFinite(marker.position_seconds)) throw new HelixError("Twitch returned incomplete marker information", 200, true);
        return direct("stream.marker", { description: marker.description, positionSeconds: marker.position_seconds }, resourceId(marker));
      }
      case "shoutout":
        await this.request("POST", "/chat/shoutouts", { from_broadcaster_id: broadcasterId, to_broadcaster_id: action.params.toBroadcasterId, moderator_id: broadcasterId });
        return event("channel.shoutout.create", { toBroadcasterId: action.params.toBroadcasterId });
      case "snooze_ad": {
        const result = first(await this.request<Data<{snooze_count: number | string; next_ad_at: string}>>("POST", "/channels/ads/schedule/snooze", { broadcaster_id: broadcasterId }));
        if (!Number.isFinite(Number(result.snooze_count)) || typeof result.next_ad_at !== "string") throw new HelixError("Twitch returned incomplete ad information", 200, true);
        return direct("ad.snooze", { snoozesRemaining: Number(result.snooze_count), nextAdAt: result.next_ad_at });
      }
      case "resolve_prediction":
        await this.request("PATCH", "/predictions", {}, { broadcaster_id: broadcasterId, id: action.params.predictionId, status: "RESOLVED", winning_outcome_id: action.params.winningOutcomeId });
        return event("channel.prediction.end", { status: "resolved", winningOutcomeId: action.params.winningOutcomeId }, action.params.predictionId);
      case "raid":
        await this.request("POST", "/raids", { from_broadcaster_id: broadcasterId, to_broadcaster_id: action.params.toBroadcasterId });
        return { ...event("channel.raid", { toBroadcasterId: action.params.toBroadcasterId }), confirmationTimeoutMs: 120_000 };
    }
  }
  async getClipConfirmation(expect: ConfirmationExpectation): Promise<Confirmation | null> {
    if (expect.resource !== "clip" || !expect.resourceId) return null;
    const clip = (await this.request<Data<{id: string; broadcaster_id: string; url: string}>>("GET", "/clips", { id: expect.resourceId })).data[0];
    if (!clip || clip.id !== expect.resourceId || clip.broadcaster_id !== expect.broadcasterId) return null;
    if (typeof clip.url !== "string") return null;
    const edit = this.pendingClipEdits.get(clip.id);
    this.pendingClipEdits.delete(clip.id);
    return { via: "helix_read", resource: "clip", broadcasterId: clip.broadcaster_id, resourceId: clip.id, observed: { url: clip.url, ...(edit ? { editUrl: edit.editUrl } : {}) } };
  }
}

function first<T>(response: Data<T>): T {
  if (!response?.data?.[0]) throw new HelixError("Twitch accepted the request but returned no resource", 200, true);
  return response.data[0];
}

function resourceId(value: {id: string}): string {
  if (typeof value.id !== "string" || !value.id) throw new HelixError("Twitch accepted the request but returned no resource ID", 200, true);
  return value.id;
}
