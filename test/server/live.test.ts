import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventSubOptions } from "../../src/twitch/eventsub.js";
import type { ConfirmationExpectation, ValidationContext } from "../../src/core/types.js";
import type { Director, Connection } from "../../src/server/director.js";
import { loadConfig } from "../../src/server/config.js";
import { context, proposal, round } from "../core/fixtures.js";

const transport = vi.hoisted(() => ({ connections: [] as EventSubOptions[] }));
vi.mock("../../src/twitch/eventsub.js", async importOriginal => {
  const original = await importOriginal<typeof import("../../src/twitch/eventsub.js")>();
  return { ...original, EventSubClient: class {
    constructor(private options: EventSubOptions) { transport.connections.push(options); }
    start() { this.options.onStatus({state: "connecting"}); }
    stop() { this.options.onStatus({state: "stopped"}); }
  } };
});
import { LiveProvider } from "../../src/server/live.js";

const providers: LiveProvider[] = [];
beforeEach(() => { vi.useFakeTimers(); transport.connections.length = 0; });
afterEach(() => { providers.splice(0).forEach(provider => provider.stop()); vi.restoreAllMocks(); vi.useRealTimers(); });
function setup(scopes = ["user:read:chat", "channel:manage:broadcast", "channel:manage:polls"], eligible = true, points = false) {
  const config = loadConfig({ APP_MODE: "live", CLIENT_ID: "client", CLIENT_SECRET: "secret", BROADCASTER_LOGIN: "streamer",
    ENABLED_ACTIONS: "set_title,create_poll,create_prediction,snooze_ad,raid", ENABLE_CHANNEL_POINTS: String(points) }, []);
  const provider = new LiveProvider(config); providers.push(provider);
  const listeners = new Set<() => void>();
  const director = {
    state: { round: null as ReturnType<typeof round> | null, context: context() },
    connection: "disconnected" as Connection, broadcaster: null as Director["broadcaster"],
    setConnection: vi.fn((value: Connection) => { director.connection = value; }),
    updateContext: vi.fn(async (patch: Partial<ValidationContext>) => { director.state.context = {...director.state.context, ...patch}; }),
    note: vi.fn(), executor: {observe: vi.fn()},
    propose: vi.fn(async () => undefined), vote: vi.fn(async () => undefined),
    subscribe: vi.fn((listener: () => void) => { listeners.add(listener); return () => {listeners.delete(listener);}; }),
  };
  provider.director = director as unknown as Director;
  const identity = {userId: "100", login: "streamer", scopes, expiresAt: Date.now() + 3_600_000};
  vi.spyOn(provider.auth, "identity", "get").mockReturnValue(identity);
  vi.spyOn(provider.auth, "validate").mockResolvedValue(identity);
  vi.spyOn(provider.auth, "startValidation").mockImplementation(() => undefined);
  vi.spyOn(provider.helix, "getUser").mockResolvedValue({id: "100", login: "streamer", display_name: "Streamer", broadcaster_type: eligible ? "affiliate" : ""});
  vi.spyOn(provider.helix, "getChannel").mockResolvedValue({broadcasterId: "100", title: "Before", categoryId: "200", capturedAt: Date.now()});
  vi.spyOn(provider.helix, "getStream").mockResolvedValue({id: "s", user_id: "100", type: "live", viewer_count: 10});
  vi.spyOn(provider.helix, "getPolls").mockResolvedValue([]);
  vi.spyOn(provider.helix, "getPredictions").mockResolvedValue([]);
  const ads = vi.spyOn(provider.helix, "getAdSchedule").mockResolvedValue({snooze_count: 2, next_ad_at: "2026-10-24T13:00:00Z"});
  const subscription = vi.spyOn(provider.helix, "createSubscription").mockResolvedValue(undefined);
  const request = vi.spyOn(provider.helix, "request").mockResolvedValue({data: [{id: "reward", title: "Director's Cut: propose", is_user_input_required: true, should_redemptions_skip_request_queue: false}]});
  return {provider, director, subscription, ads, request, listeners};
}
async function notification(type: string, event: Record<string, unknown>) {
  await transport.connections.at(-1)!.onNotification(type, event, {message_id: "notification-id", message_type: "notification", message_timestamp: new Date().toISOString()});
}

describe("Live Twitch wiring", () => {
  it("does not report ready until every subscription and channel resync has completed", async () => {
    const {provider, director, subscription} = setup();
    let finish!: () => void;
    const pending = new Promise<void>(resolve => {finish = resolve;});
    subscription.mockImplementation(() => pending);
    await provider.connect();
    const ready = transport.connections[0]!.onWelcome("session", false);
    expect(director.connection).not.toBe("connected");
    finish(); await ready;
    expect(director.connection).toBe("connected");
    const count = subscription.mock.calls.length;
    await transport.connections[0]!.onWelcome("migrated", true);
    expect(subscription).toHaveBeenCalledTimes(count);
  });
  it("cannot resurrect a stopped session when pending subscription calls finish", async () => {
    const {provider, director, subscription} = setup();
    let finish!: () => void;
    const pending = new Promise<void>(resolve => {finish = resolve;});
    subscription.mockImplementation(() => pending);
    await provider.connect();
    const ready = transport.connections[0]!.onWelcome("session", false);
    provider.stop();
    finish(); await ready;
    expect(director.connection).not.toBe("connected");
  });
  it("recovers after a transient facts refresh failure without issuing Twitch writes", async () => {
    const {provider, director} = setup();
    await provider.connect();
    await transport.connections[0]!.onWelcome("session", false);
    const channel = vi.mocked(provider.helix.getChannel);
    const write = vi.spyOn(provider.helix, "execute");
    channel.mockRejectedValueOnce(new Error("Temporary Twitch read failure"));

    await vi.advanceTimersByTimeAsync(30_000);
    expect(director.connection).not.toBe("connected");
    await expect(provider.execute({kind: "set_title", params: {title: "Blocked while facts are stale"}})).rejects.toThrow();
    const readsAfterFailure = channel.mock.calls.length;

    await vi.advanceTimersByTimeAsync(30_000);
    expect(channel.mock.calls.length).toBeGreaterThan(readsAfterFailure);
    expect(director.connection).toBe("connected");
    expect(write).not.toHaveBeenCalled();
  });
  it.each(["stop", "revocation"] as const)("cannot resurrect a session after %s interrupts facts recovery", async reason => {
    const {provider, director} = setup();
    await provider.connect();
    const callbacks = transport.connections[0]!;
    await callbacks.onWelcome("session", false);
    const channel = vi.mocked(provider.helix.getChannel);
    channel.mockRejectedValueOnce(new Error("Temporary Twitch read failure"));
    await vi.advanceTimersByTimeAsync(30_000);

    let finish!: () => void;
    const pending = new Promise<void>(resolve => {finish = resolve;});
    channel.mockImplementationOnce(async () => {
      await pending;
      return {broadcasterId: "100", title: "Recovered", categoryId: "200", capturedAt: Date.now()};
    });
    const readsAfterFailure = channel.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(channel.mock.calls.length).toBeGreaterThan(readsAfterFailure);
    if (reason === "stop") provider.stop();
    else await callbacks.onRevocation?.({type: "channel.chat.message", status: "authorization_revoked"});
    const updatesAtStop = director.updateContext.mock.calls.length;

    finish();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(director.connection).not.toBe("connected");
    expect(director.updateContext).toHaveBeenCalledTimes(updatesAtStop);
    await expect(provider.execute({kind: "set_title", params: {title: "No late write"}})).rejects.toThrow();
  });
  it("limits non-Affiliate channels to capabilities actually available to that account", async () => {
    const {provider, director} = setup(["user:read:chat", "channel:manage:broadcast", "channel:manage:polls", "channel:manage:predictions", "channel:manage:ads"], false);
    await provider.connect();
    expect([...director.state.context.allowedActions]).toEqual(["set_title"]);
    expect(provider.helix.getPolls).not.toHaveBeenCalled();
    expect(provider.helix.getPredictions).not.toHaveBeenCalled();
  });
  it("does not fetch ad schedule or enable snooze without the separate read scope", async () => {
    const {provider, director, ads} = setup(["user:read:chat", "channel:manage:broadcast", "channel:manage:ads"]);
    await provider.connect();
    expect(ads).not.toHaveBeenCalled();
    expect(director.state.context.allowedActions.has("snooze_ad")).toBe(false);
  });
  it("uses read and manage ad permissions together when enabling snooze", async () => {
    const {provider, director, ads} = setup(["user:read:chat", "channel:manage:ads", "channel:read:ads"]);
    await provider.connect();
    expect(ads).toHaveBeenCalledWith("100");
    expect(director.state.context.allowedActions.has("snooze_ad")).toBe(true);
    expect(director.state.context.adSnoozesRemaining).toBe(2);
  });
  it("correlates fallback reads by channel and provider resource ID", async () => {
    const {provider, request} = setup(); await provider.connect();
    const expectPoll: ConfirmationExpectation = {via: "eventsub", resource: "channel.poll.begin", broadcasterId: "100", resourceId: "poll", expected: {title: "Pick"}};
    request.mockResolvedValueOnce({data: [{id: "poll", broadcaster_id: "other", title: "Pick", status: "ACTIVE"}]});
    expect(await provider.verify(expectPoll)).toBeUndefined();
    request.mockResolvedValueOnce({data: [{id: "poll", broadcaster_id: "100", title: "Pick", status: "ACTIVE"}]});
    expect(await provider.verify(expectPoll)).toMatchObject({via: "helix_read", broadcasterId: "100", resourceId: "poll", observed: {title: "Pick", status: "active"}});
    expect(request).toHaveBeenLastCalledWith("GET", "/polls", {broadcaster_id: "100", id: "poll"});
  });
  it("blocks new Twitch writes after authorization is revoked", async () => {
    const {provider} = setup(); await provider.connect();
    await transport.connections[0]!.onWelcome("session", false);
    const write = vi.spyOn(provider.helix, "execute").mockResolvedValue({expect: {via: "eventsub", resource: "channel.update", broadcasterId: "100", expected: {title: "After"}}});
    await transport.connections[0]!.onRevocation?.({type: "channel.chat.message", status: "authorization_revoked"});
    await expect(provider.execute({kind: "set_title", params: {title: "After"}})).rejects.toThrow();
    expect(write).not.toHaveBeenCalled();
  });
  it("accepts only unfulfilled rewards with valid viewer identity and configured reward IDs", async () => {
    const {provider, director} = setup(["user:read:chat", "channel:manage:broadcast", "channel:manage:redemptions"], true, true);
    await provider.connect(); await transport.connections[0]!.onWelcome("session", false);
    const refund = vi.spyOn(provider.helix, "refundRedemption").mockResolvedValue(undefined);
    const base = {id: "redemption", broadcaster_user_id: "100", reward: {id: "reward"}, status: "unfulfilled", user_id: "viewer", user_name: "Viewer", user_input: "r1 title Hello"};
    await notification("channel.channel_points_custom_reward_redemption.add", {...base, reward: {id: "unmanaged"}});
    await notification("channel.channel_points_custom_reward_redemption.add", {...base, status: "fulfilled"});
    await notification("channel.channel_points_custom_reward_redemption.add", {...base, user_id: undefined});
    expect(director.propose).not.toHaveBeenCalled();
    expect(refund).not.toHaveBeenCalled();
    await notification("channel.channel_points_custom_reward_redemption.add", base);
    expect(director.propose).toHaveBeenCalledExactlyOnceWith("r1", {kind: "set_title", params: {title: "Hello"}}, {userId: "viewer", userName: "Viewer"}, {rewardId: "reward", redemptionId: "redemption"});
  });
  it("removes the previous reward listener on reconnect", async () => {
    const {provider, listeners} = setup(["user:read:chat", "channel:manage:redemptions"], true, true);
    await provider.connect(); expect(listeners.size).toBe(1);
    await provider.connect(); expect(listeners.size).toBe(1);
    provider.stop(); expect(listeners.size).toBe(0);
  });
  it("keeps all losing redemptions available while a subsequent round opens", async () => {
    const {provider, director} = setup(["user:read:chat", "channel:manage:redemptions"], true, true);
    await provider.connect();
    director.state.round = round({proposals: [
      {...proposal("p1"), redemption: {rewardId: "reward", redemptionId: "redemption-1"}},
      {...proposal("p2"), redemption: {rewardId: "reward", redemptionId: "redemption-2"}},
    ]});
    let finish!: () => void;
    const pending = new Promise<void>(resolve => {finish = resolve;});
    const refund = vi.spyOn(provider.helix, "refundRedemption").mockResolvedValue(undefined).mockImplementationOnce(() => pending);
    const refunded = provider.refund(["p1", "p2"]);
    director.state.round = round({id: "new-round", proposals: []});
    finish(); await refunded;
    expect(refund.mock.calls).toEqual([["100", "reward", "redemption-1"], ["100", "reward", "redemption-2"]]);
  });
});
