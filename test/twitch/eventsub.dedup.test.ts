import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSubscriptions, EventSubClient, MessageDeduplicator, normalizeNotification, type EventMetadata } from "../../src/twitch/eventsub.js";

const now = Date.parse("2026-10-24T12:00:00Z");
function metadata(id: string, type = "notification", at = now): EventMetadata { return {message_id: id, message_type: type, message_timestamp: new Date(at).toISOString()}; }
class Socket extends EventEmitter {
  closed = false;
  close() { this.closed = true; this.emit("close", 1000); }
  terminate() { this.close(); }
  message(id: string, type: string, payload: unknown) { this.emit("message", JSON.stringify({metadata: metadata(id, type), payload})); }
  welcome(id: string) { this.message(id, "session_welcome", {session: {id, keepalive_timeout_seconds: 10}}); }
}
afterEach(() => vi.useRealTimers());
describe("EventSub metadata and lifecycle", () => {
  it("deduplicates IDs, rejects stale/future frames, and bounds retained IDs", () => {
    let time = now;
    const dedupe = new MessageDeduplicator(() => time, 600_000, 2);
    expect(dedupe.accept(metadata("a"))).toBe(true);
    expect(dedupe.accept(metadata("a"))).toBe(false);
    expect(dedupe.accept(metadata("old", "notification", now - 600_001))).toBe(false);
    expect(dedupe.accept(metadata("future", "notification", now + 60_001))).toBe(false);
    dedupe.accept(metadata("b")); dedupe.accept(metadata("c"));
    expect(dedupe.accept(metadata("a"))).toBe(true);
    time += 600_001;
    expect(dedupe.accept(metadata("a", "notification", time))).toBe(true);
  });
  it("keeps the old socket until migration welcome and preserves subscriptions", async () => {
    vi.useFakeTimers();
    const sockets: Socket[] = [];
    const onWelcome = vi.fn(); const onNotification = vi.fn();
    const client = new EventSubClient({ now: () => now, onWelcome, onNotification, onStatus: vi.fn(),
      webSocketFactory: () => { const socket = new Socket(); sockets.push(socket); return socket; } });
    client.start(); sockets[0]!.welcome("session-a");
    sockets[0]!.message("move", "session_reconnect", {session: {reconnect_url: "wss://eventsub.wss.twitch.tv/ws?token=move"}});
    expect(sockets).toHaveLength(2);
    expect(sockets[0]!.closed).toBe(false);
    sockets[1]!.welcome("session-b");
    expect(sockets[0]!.closed).toBe(true);
    expect(onWelcome.mock.calls).toEqual([["session-a", false], ["session-b", true]]);
    const payload = {subscription: {type: "channel.update"}, event: {broadcaster_user_id: "123", title: "New", category_id: "1"}};
    sockets[1]!.message("event", "notification", payload); sockets[1]!.message("event", "notification", payload);
    expect(onNotification).toHaveBeenCalledTimes(1);
    client.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(2);
  });
  it("reconnects unexpected disconnects with a fresh subscription session and reports revocation", async () => {
    vi.useFakeTimers();
    const sockets: Socket[] = []; const onWelcome = vi.fn(); const onRevocation = vi.fn();
    const client = new EventSubClient({ now: () => now, onWelcome, onRevocation, onNotification: vi.fn(), onStatus: vi.fn(),
      webSocketFactory: () => { const socket = new Socket(); sockets.push(socket); return socket; } });
    client.start(); sockets[0]!.welcome("a"); sockets[0]!.close();
    await vi.advanceTimersByTimeAsync(1_000);
    sockets[1]!.welcome("b");
    expect(onWelcome.mock.calls).toEqual([["a", false], ["b", false]]);
    sockets[1]!.message("revoked", "revocation", {subscription: {type: "channel.chat.message", status: "authorization_revoked"}});
    expect(onRevocation).toHaveBeenCalledWith({type: "channel.chat.message", status: "authorization_revoked"});
    expect(onWelcome).toHaveBeenCalledTimes(2);
    client.stop();
  });
  it("watchdog treats notification traffic as keepalive and reconnects silence", async () => {
    vi.useFakeTimers();
    const sockets: Socket[] = [];
    const client = new EventSubClient({ now: () => now, onWelcome: vi.fn(), onNotification: vi.fn(), onStatus: vi.fn(),
      webSocketFactory: () => { const socket = new Socket(); sockets.push(socket); return socket; } });
    client.start(); sockets[0]!.welcome("a");
    await vi.advanceTimersByTimeAsync(9_000);
    sockets[0]!.message("healthy", "session_keepalive", {});
    await vi.advanceTimersByTimeAsync(9_000); expect(sockets[0]!.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(4_000); expect(sockets).toHaveLength(2);
    client.stop();
  });
  it.each([0, 408, 429, 503])("reconnects after a transient welcome handler failure (status %s)", async status => {
    vi.useFakeTimers();
    const sockets: Socket[] = [];
    const failure = Object.assign(new Error("Temporary subscription setup failure"), {status});
    const onWelcome = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined);
    const client = new EventSubClient({now: () => now, onWelcome, onNotification: vi.fn(), onStatus: vi.fn(),
      webSocketFactory: () => {const socket = new Socket(); sockets.push(socket); return socket;} });
    client.start(); sockets[0]!.welcome("failed");
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets[0]!.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets).toHaveLength(2);
    sockets[1]!.welcome("recovered");
    await vi.advanceTimersByTimeAsync(0);
    expect(onWelcome.mock.calls).toEqual([["failed", false], ["recovered", false]]);
    client.stop();
  });
  it("backs off repeated welcome failures until a session finishes setup", async () => {
    vi.useFakeTimers();
    const sockets: Socket[] = [];
    const onWelcome = vi.fn().mockRejectedValueOnce(new Error("First failure"))
      .mockRejectedValueOnce(new Error("Second failure")).mockResolvedValue(undefined);
    const client = new EventSubClient({now: () => now, onWelcome, onNotification: vi.fn(), onStatus: vi.fn(),
      webSocketFactory: () => {const socket = new Socket(); sockets.push(socket); return socket;} });
    client.start(); sockets[0]!.welcome("first");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets).toHaveLength(2);
    sockets[1]!.welcome("second");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets).toHaveLength(3);
    sockets[2]!.welcome("success");
    await vi.advanceTimersByTimeAsync(0);
    sockets[2]!.close();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets).toHaveLength(4);
    client.stop();
  });
  it("resubscribes after notification failure without replaying the handled event", async () => {
    vi.useFakeTimers();
    const sockets: Socket[] = [];
    const onWelcome = vi.fn();
    const onNotification = vi.fn().mockRejectedValueOnce(new Error("Read failed after processing input"));
    const client = new EventSubClient({now: () => now, onWelcome, onNotification, onStatus: vi.fn(),
      webSocketFactory: () => {const socket = new Socket(); sockets.push(socket); return socket;} });
    const payload = {subscription: {type: "channel.update"}, event: {broadcaster_user_id: "123", title: "After", category_id: "1"}};
    client.start(); sockets[0]!.welcome("first");
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]!.message("processed", "notification", payload);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets).toHaveLength(2);
    sockets[1]!.welcome("recovered");
    sockets[1]!.message("processed", "notification", payload);
    await vi.advanceTimersByTimeAsync(0);
    expect(onNotification).toHaveBeenCalledTimes(1);
    expect(onWelcome.mock.calls).toEqual([["first", false], ["recovered", false]]);
    client.stop();
  });
  it.each([400, 401, 403, 404])("stops automatic recovery for persistent handler status %s", async status => {
    vi.useFakeTimers();
    const sockets: Socket[] = [];
    const onStatus = vi.fn();
    const onWelcome = vi.fn().mockRejectedValue(Object.assign(new Error("Authorization or configuration rejected"), {status}));
    const client = new EventSubClient({now: () => now, onWelcome, onNotification: vi.fn(), onStatus,
      webSocketFactory: () => {const socket = new Socket(); sockets.push(socket); return socket;} });
    client.start(); sockets[0]!.welcome("rejected");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets[0]!.closed).toBe(true);
    expect(sockets).toHaveLength(1);
    expect(onStatus).toHaveBeenLastCalledWith({state: "error", message: expect.stringMatching(/reconnect/i)});
    client.stop();
  });
  it.each(["stopped", "retired"] as const)("ignores a late handler rejection from a %s socket", async previousState => {
    vi.useFakeTimers();
    const sockets: Socket[] = [];
    const onStatus = vi.fn();
    let reject!: (error: Error) => void;
    const pending = new Promise<void>((_resolve, rejectPromise) => {reject = rejectPromise;});
    const onWelcome = vi.fn().mockImplementationOnce(() => pending).mockResolvedValue(undefined);
    const client = new EventSubClient({now: () => now, onWelcome, onNotification: vi.fn(), onStatus,
      webSocketFactory: () => {const socket = new Socket(); sockets.push(socket); return socket;} });
    client.start(); sockets[0]!.welcome("previous");
    if (previousState === "stopped") client.stop();
    else {
      sockets[0]!.message("migration", "session_reconnect", {session: {reconnect_url: "wss://eventsub.wss.twitch.tv/ws?token=move"}});
      sockets[1]!.welcome("current");
    }
    await vi.advanceTimersByTimeAsync(0);
    const statusCount = onStatus.mock.calls.length;
    reject(new Error("Late setup failure"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onStatus).toHaveBeenCalledTimes(statusCount);
    expect(sockets).toHaveLength(previousState === "stopped" ? 1 : 2);
    if (previousState === "retired") expect(sockets[1]!.closed).toBe(false);
    client.stop();
  });
  it("selects subscriptions using granted manage scopes and account eligibility", () => {
    const subscriptions = buildSubscriptions("123", "123", ["user:read:chat", "channel:manage:polls", "channel:manage:predictions", "moderator:manage:shoutouts"], true);
    expect(subscriptions).toContainEqual({type: "channel.poll.begin", version: "1", condition: {broadcaster_user_id: "123"}});
    expect(subscriptions).toContainEqual({type: "channel.raid", version: "1", condition: {from_broadcaster_user_id: "123"}});
    expect(subscriptions).toContainEqual({type: "channel.shoutout.create", version: "1", condition: {broadcaster_user_id: "123", moderator_user_id: "123"}});
    expect(buildSubscriptions("123", "123", ["channel:manage:polls"], false).some(s => s.type.startsWith("channel.poll"))).toBe(false);
  });
  it("normalizes IDs and domain fields without accepting incomplete confirmations", () => {
    expect(normalizeNotification("channel.update", {broadcaster_user_id: "123", title: "New", category_id: "42"}, metadata("e")))
      .toEqual({via: "eventsub", resource: "channel.update", broadcasterId: "123", providerEventId: "e", observed: {title: "New", categoryId: "42"}});
    expect(normalizeNotification("channel.prediction.end", {broadcaster_user_id: "123", id: "p", status: "resolved", winning_outcome_id: "o"}, metadata("e")))
      .toMatchObject({resourceId: "p", observed: {status: "resolved", winningOutcomeId: "o"}});
    expect(normalizeNotification("channel.update", {title: "New"}, metadata("e"))).toBeUndefined();
  });
});
