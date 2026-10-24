import { describe, expect, it, vi } from "vitest";
import { HelixClient, HelixError } from "../../src/twitch/helix.js";
import type { Action } from "../../src/core/types.js";

function setup(responses: (Response | Error)[]) {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
    const response = responses.shift();
    if (response instanceof Error) throw response;
    if (!response) throw new Error("Unexpected request");
    return response;
  });
  const auth = { getAccessToken: vi.fn(async () => "old-token"), refresh: vi.fn(async () => "new-token") };
  return { client: new HelixClient({ auth, clientId: "client", fetch: fetcher, now: () => 1_000 }), fetcher, auth };
}
function json(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }); }

describe("Helix request contracts", () => {
  it("encodes titles in a JSON PATCH and returns a field-specific confirmation expectation", async () => {
    const { client, fetcher } = setup([new Response(null, { status: 204 })]);
    const receipt = await client.execute({ kind: "set_title", params: { title: 'A & B "live"' } }, "123");
    const [url, options] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe("https://api.twitch.tv/helix/channels?broadcaster_id=123");
    expect(options).toMatchObject({ method: "PATCH", body: JSON.stringify({ title: 'A & B "live"' }), headers: { "Client-Id": "client", Authorization: "Bearer old-token" } });
    expect(receipt.expect).toEqual({ via: "eventsub", resource: "channel.update", broadcasterId: "123", expected: { title: 'A & B "live"' } });
    expect(receipt.confirmation).toBeUndefined();
  });
  it("refreshes a rejected token once and does not replay an ambiguous POST failure", async () => {
    const { client, fetcher, auth } = setup([json({}, 401), json({ data: [{id: "poll-1"}] })]);
    await client.execute({ kind: "create_poll", params: { title: "Next?", choices: ["A", "B"], durationSeconds: 30 } }, "123");
    expect(auth.refresh).toHaveBeenCalledExactlyOnceWith("old-token");
    expect(fetcher.mock.calls[1]?.[1]?.headers).toMatchObject({ Authorization: "Bearer new-token" });
    const failed = setup([new Error("connection closed after write")]);
    await expect(failed.client.execute({ kind: "create_clip", params: {} }, "123")).rejects.toMatchObject({ mayHaveApplied: true });
    expect(failed.fetcher).toHaveBeenCalledTimes(1);
  });
  it("stops after a repeated 401 and exposes a rate-limit cooldown without hammering Twitch", async () => {
    const unauthorized = setup([json({}, 401), json({}, 401)]);
    await expect(unauthorized.client.getUser("name")).rejects.toMatchObject({ status: 401 });
    expect(unauthorized.auth.refresh).toHaveBeenCalledTimes(1);
    const { client, fetcher } = setup([new Response(null, { status: 429, headers: { "Ratelimit-Remaining": "0", "Ratelimit-Reset": "100" } })]);
    await expect(client.getUser("name")).rejects.toMatchObject({ status: 429, retryAt: 100_000 });
    await expect(client.getUser("name")).rejects.toBeInstanceOf(HelixError);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(client.rateLimit).toEqual({ remaining: 0, resetsAt: 100_000 });
  });
  it("correlates clips through a later read using both resource ID and channel", async () => {
    const { client } = setup([json({ data: [{id: "clip-1", edit_url: "https://clips.twitch.tv/clip-1/edit"}] }),
      json({ data: [] }), json({ data: [{id: "clip-1", broadcaster_id: "other", url: "bad"}] }),
      json({ data: [{id: "clip-1", broadcaster_id: "123", url: "https://clips.twitch.tv/clip-1"}] })]);
    const receipt = await client.execute({ kind: "create_clip", params: {} }, "123");
    expect(receipt.confirmation).toBeUndefined();
    expect(receipt.confirmationTimeoutMs).toBe(60_000);
    expect(await client.getClipConfirmation(receipt.expect)).toBeNull();
    expect(await client.getClipConfirmation(receipt.expect)).toBeNull();
    expect(await client.getClipConfirmation(receipt.expect)).toMatchObject({ resourceId: "clip-1", broadcasterId: "123", observed: {url: "https://clips.twitch.tv/clip-1"} });
  });
  it.each<{action: Action; method: string; path: string; body?: unknown; response: unknown; resource: string}>([
    { action: {kind: "set_category", params: {categoryId: "42"}}, method: "PATCH", path: "/channels", body: {game_id: "42"}, response: null, resource: "channel.update" },
    { action: {kind: "create_poll", params: {title: "Pick", choices: ["A", "B"], durationSeconds: 30}}, method: "POST", path: "/polls", body: {broadcaster_id: "123", title: "Pick", choices: [{title: "A"}, {title: "B"}], duration: 30}, response: {data: [{id: "p"}]}, resource: "channel.poll.begin" },
    { action: {kind: "create_prediction", params: {title: "Win?", outcomes: ["Yes", "No"], predictionWindowSeconds: 60}}, method: "POST", path: "/predictions", body: {broadcaster_id: "123", title: "Win?", outcomes: [{title: "Yes"}, {title: "No"}], prediction_window: 60}, response: {data: [{id: "p"}]}, resource: "channel.prediction.begin" },
    { action: {kind: "create_marker", params: {description: "Moment"}}, method: "POST", path: "/streams/markers", body: {user_id: "123", description: "Moment"}, response: {data: [{id: "m", description: "Moment", position_seconds: 10}]}, resource: "stream.marker" },
    { action: {kind: "shoutout", params: {toBroadcasterId: "456"}}, method: "POST", path: "/chat/shoutouts", response: null, resource: "channel.shoutout.create" },
    { action: {kind: "snooze_ad", params: {}}, method: "POST", path: "/channels/ads/schedule/snooze", response: {data: [{snooze_count: 1, next_ad_at: "later"}]}, resource: "ad.snooze" },
    { action: {kind: "resolve_prediction", params: {predictionId: "p", winningOutcomeId: "o"}}, method: "PATCH", path: "/predictions", body: {broadcaster_id: "123", id: "p", status: "RESOLVED", winning_outcome_id: "o"}, response: {data: []}, resource: "channel.prediction.end" },
    { action: {kind: "raid", params: {toBroadcasterId: "456"}}, method: "POST", path: "/raids", response: {data: [{created_at: "now"}]}, resource: "channel.raid" },
  ])("maps $action.kind to the documented API", async ({action, method, path, body, response, resource}) => {
    const {client, fetcher} = setup([response === null ? new Response(null, {status: 204}) : json(response)]);
    const result = await client.execute(action, "123");
    const [url, request] = fetcher.mock.calls[0]!;
    expect(new URL(String(url)).pathname).toBe(`/helix${path}`);
    expect(request?.method).toBe(method);
    expect(request?.body).toBe(body === undefined ? undefined : JSON.stringify(body));
    expect(result.expect.resource).toBe(resource);
    if (action.kind === "shoutout") expect(new URL(String(url)).searchParams.get("moderator_id")).toBe("123");
    if (action.kind === "raid") { expect(result.confirmation).toBeUndefined(); expect(result.confirmationTimeoutMs).toBe(120_000); }
  });
});
