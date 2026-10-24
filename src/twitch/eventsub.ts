import WebSocket from "ws";
import type { Confirmation, JsonValue } from "../core/types.js";
import type { Subscription } from "./helix.js";

export interface EventMetadata {
  message_id: string; message_type: string; message_timestamp: string;
  subscription_type?: string; subscription_version?: string;
}
export interface EventSubStatus {
  state: "connecting" | "connected" | "reconnecting" | "disconnected" | "revoked" | "error" | "stopped";
  message?: string;
}
export interface EventSocket {
  on(event: "message", callback: (data: {toString(): string}) => void): unknown;
  on(event: "close", callback: (code: number) => void): unknown;
  on(event: "error", callback: (error: Error) => void): unknown;
  close(): void;
  terminate(): void;
}
export interface EventSubOptions {
  onWelcome(sessionId: string, isMigration: boolean): void | Promise<void>;
  onNotification(type: string, event: Record<string, unknown>, metadata: EventMetadata): void | Promise<void>;
  onStatus(status: EventSubStatus): void;
  onRevocation?(subscription: Record<string, unknown>): void | Promise<void>;
  webSocketFactory?: (url: string) => EventSocket;
  now?: () => number;
  reconnectDelayMs?: number;
}
interface Connection {
  socket: EventSocket; migration: boolean; welcomed: boolean; retiring: boolean;
  keepaliveMs: number; watchdog?: ReturnType<typeof setTimeout>;
}

/** Metadata names are WebSocket JSON fields, not webhook HTTP headers. */
export class MessageDeduplicator {
  private readonly seen = new Map<string, number>();
  constructor(private readonly now: () => number = Date.now, private readonly ttlMs = 600_000, private readonly capacity = 10_000) {}
  accept(metadata: EventMetadata): boolean {
    const now = this.now();
    const timestamp = Date.parse(metadata.message_timestamp);
    if (!metadata.message_id || !Number.isFinite(timestamp) || timestamp < now - this.ttlMs || timestamp > now + 60_000) return false;
    for (const [id, expiry] of this.seen) { if (expiry <= now) this.seen.delete(id); else break; }
    if (this.seen.has(metadata.message_id)) return false;
    this.seen.set(metadata.message_id, now + this.ttlMs);
    while (this.seen.size > this.capacity) {
      const key = this.seen.keys().next().value;
      if (key === undefined) break;
      this.seen.delete(key);
    }
    return true;
  }
}

export class EventSubClient {
  private stopped = true;
  private active: Connection | undefined;
  private migrating: Connection | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private attempts = 0;
  private readonly dedupe: MessageDeduplicator;
  private readonly factory: (url: string) => EventSocket;
  constructor(private readonly options: EventSubOptions) {
    this.factory = options.webSocketFactory ?? ((url) => new WebSocket(url));
    this.dedupe = new MessageDeduplicator(options.now);
  }
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect("wss://eventsub.wss.twitch.tv/ws", false);
  }
  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    for (const connection of [this.active, this.migrating]) {
      if (!connection) continue;
      connection.retiring = true;
      if (connection.watchdog) clearTimeout(connection.watchdog);
      connection.socket.close();
    }
    this.active = undefined; this.migrating = undefined;
    this.options.onStatus({ state: "stopped" });
  }
  private connect(url: string, migration: boolean): void {
    if (this.stopped) return;
    this.options.onStatus({ state: migration || this.attempts > 0 ? "reconnecting" : "connecting" });
    let socket: EventSocket;
    try { socket = this.factory(url); }
    catch { this.scheduleReconnect(); return; }
    const connection: Connection = { socket, migration, welcomed: false, retiring: false, keepaliveMs: 15_000 };
    if (migration) this.migrating = connection; else this.active = connection;
    this.watch(connection);
    socket.on("message", (raw) => { void this.receive(connection, raw.toString()).catch(error => this.handlerFailed(connection, error)); });
    socket.on("error", () => {
      this.options.onStatus({ state: "error", message: "EventSub connection error" });
      socket.terminate();
    });
    socket.on("close", () => {
      if (connection.watchdog) clearTimeout(connection.watchdog);
      if (this.stopped || connection.retiring) return;
      if (this.migrating === connection) this.migrating = undefined;
      if (this.active === connection) this.active = undefined;
      this.options.onStatus({ state: "disconnected", message: "Missed events cannot be replayed; channel state will be refreshed" });
      // If a migration is still connecting, allow its welcome to take ownership.
      if (!this.active && !this.migrating) this.scheduleReconnect();
    });
  }
  private handlerFailed(connection: Connection, error: unknown): void {
    // Pending callbacks from a stopped, closed or migrated session cannot change the current session.
    if (this.stopped || connection.retiring || (this.active !== connection && this.migrating !== connection)) return;
    const status = error !== null && typeof error === "object" && "status" in error ? Number(error.status) : 0;
    if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
      this.stop();
      this.options.onStatus({ state: "error", message: `EventSub setup or handler was rejected (HTTP ${status}). Reconnect after resolving authorization or configuration.` });
      return;
    }
    this.options.onStatus({ state: "error", message: "EventSub handler failed; reconnecting and refreshing channel state" });
    // The close path starts a new subscription session. Never replay the failed notification.
    connection.socket.terminate();
  }
  private watch(connection: Connection): void {
    if (connection.watchdog) clearTimeout(connection.watchdog);
    connection.watchdog = setTimeout(() => connection.socket.terminate(), connection.keepaliveMs + 2_000);
    connection.watchdog.unref();
  }
  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = Math.min(30_000, (this.options.reconnectDelayMs ?? 1_000) * 2 ** this.attempts++);
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = undefined; this.connect("wss://eventsub.wss.twitch.tv/ws", false); }, delay);
    this.reconnectTimer.unref();
  }
  private async receive(connection: Connection, raw: string): Promise<void> {
    if (this.stopped || connection.retiring) return;
    let message: Record<string, unknown>;
    try { const parsed: unknown = JSON.parse(raw); if (!record(parsed)) return; message = parsed; } catch { return; }
    if (!record(message.metadata) || !record(message.payload)) return;
    const m = message.metadata;
    if (typeof m.message_id !== "string" || typeof m.message_type !== "string" || typeof m.message_timestamp !== "string") return;
    const metadata = m as unknown as EventMetadata;
    if (!this.dedupe.accept(metadata)) return;
    this.watch(connection);
    const payload = message.payload;
    switch (metadata.message_type) {
      case "session_welcome": {
        if (connection.welcomed || !record(payload.session) || typeof payload.session.id !== "string") return;
        connection.welcomed = true;
        if (typeof payload.session.keepalive_timeout_seconds === "number") connection.keepaliveMs = payload.session.keepalive_timeout_seconds * 1000;
        this.watch(connection);
        if (connection.migration) {
          const previous = this.active;
          this.active = connection; this.migrating = undefined;
          if (previous && previous !== connection) {
            previous.retiring = true;
            if (previous.watchdog) clearTimeout(previous.watchdog);
            previous.socket.close();
          }
        }
        this.options.onStatus({ state: "connected" });
        // Migrated sessions retain subscriptions: caller must not recreate them.
        await this.options.onWelcome(payload.session.id, connection.migration);
        if (!this.stopped && !connection.retiring && this.active === connection) this.attempts = 0;
        break;
      }
      case "session_keepalive": break;
      case "notification":
        if (!connection.welcomed || !record(payload.subscription) || typeof payload.subscription.type !== "string" || !record(payload.event)) return;
        await this.options.onNotification(payload.subscription.type, payload.event, metadata);
        break;
      case "session_reconnect": {
        if (!connection.welcomed || this.migrating || !record(payload.session) || typeof payload.session.reconnect_url !== "string") return;
        const reconnect = new URL(payload.session.reconnect_url);
        if (reconnect.protocol !== "wss:" || reconnect.hostname !== "eventsub.wss.twitch.tv") return;
        this.connect(payload.session.reconnect_url, true);
        break;
      }
      case "revocation":
        if (!record(payload.subscription)) return;
        this.options.onStatus({ state: "revoked", message: `Subscription revoked: ${String(payload.subscription.type)} (${String(payload.subscription.status)})` });
        // Authorization revocation requires a new grant, never an automatic subscribe loop.
        await this.options.onRevocation?.(payload.subscription);
        break;
    }
  }
}

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }

export function buildSubscriptions(broadcasterId: string, userId: string, scopes: readonly string[], eligible = true): Subscription[] {
  const granted = new Set(scopes);
  const broadcaster = { broadcaster_user_id: broadcasterId };
  const subs: Subscription[] = [
    { type: "channel.update", version: "2", condition: broadcaster },
    { type: "stream.online", version: "1", condition: broadcaster },
    { type: "stream.offline", version: "1", condition: broadcaster },
    { type: "channel.raid", version: "1", condition: { from_broadcaster_user_id: broadcasterId } },
  ];
  const add = (type: string, condition: Record<string, string> = broadcaster) => subs.push({ type, version: "1", condition });
  if (granted.has("user:read:chat")) add("channel.chat.message", { ...broadcaster, user_id: userId });
  if (eligible && (granted.has("channel:read:redemptions") || granted.has("channel:manage:redemptions"))) add("channel.channel_points_custom_reward_redemption.add");
  if (eligible && (granted.has("channel:read:polls") || granted.has("channel:manage:polls"))) {
    for (const suffix of ["begin", "progress", "end"]) add(`channel.poll.${suffix}`);
  }
  if (eligible && (granted.has("channel:read:predictions") || granted.has("channel:manage:predictions"))) {
    for (const suffix of ["begin", "progress", "lock", "end"]) add(`channel.prediction.${suffix}`);
  }
  if (granted.has("moderator:read:shoutouts") || granted.has("moderator:manage:shoutouts")) add("channel.shoutout.create", { ...broadcaster, moderator_user_id: userId });
  if (eligible && granted.has("channel:read:ads")) add("channel.ad_break.begin");
  return subs;
}

/** Translate only documented event fields into domain confirmation data. */
export function normalizeNotification(type: string, event: Record<string, unknown>, metadata: EventMetadata): Confirmation | undefined {
  const broadcasterId = type === "channel.raid" ? event.from_broadcaster_user_id : event.broadcaster_user_id;
  if (typeof broadcasterId !== "string") return undefined;
  const observed: Record<string, JsonValue> = {};
  let resourceId: string | undefined;
  switch (type) {
    case "channel.update":
      if (typeof event.title !== "string" || typeof event.category_id !== "string") return undefined;
      observed.title = event.title; observed.categoryId = event.category_id;
      break;
    case "channel.poll.begin":
    case "channel.prediction.begin":
      if (typeof event.id !== "string" || typeof event.title !== "string") return undefined;
      resourceId = event.id; observed.title = event.title;
      break;
    case "channel.prediction.end":
      if (typeof event.id !== "string" || typeof event.status !== "string") return undefined;
      resourceId = event.id; observed.status = event.status.toLowerCase();
      if (typeof event.winning_outcome_id === "string") observed.winningOutcomeId = event.winning_outcome_id;
      break;
    case "channel.shoutout.create":
    case "channel.raid":
      if (typeof event.to_broadcaster_user_id !== "string") return undefined;
      observed.toBroadcasterId = event.to_broadcaster_user_id;
      break;
    default: return undefined;
  }
  return { via: "eventsub", resource: type, broadcasterId, providerEventId: metadata.message_id,
    ...(resourceId ? { resourceId } : {}), observed };
}
