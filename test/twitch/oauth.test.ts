import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OAuthManager } from "../../src/twitch/oauth.js";

const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map(folder => rm(folder, {recursive: true, force: true}))); });
async function setup(responses: unknown[]) {
  const folder = await mkdtemp(join(tmpdir(), "directors-cut-oauth-")); folders.push(folder);
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
    const response = responses.shift();
    return response instanceof Response ? response : new Response(JSON.stringify(response));
  });
  const tokenStorePath = join(folder, "tokens.json");
  return { manager: new OAuthManager({clientId: "client", clientSecret: "secret", redirectUri: "http://localhost:3000/auth/callback", scopes: ["user:read:chat"], tokenStorePath, fetch: fetcher, now: () => 1000}), fetcher, tokenStorePath };
}
const identity = {client_id: "client", user_id: "123", login: "streamer", scopes: ["user:read:chat"], expires_in: 3600};
describe("OAuth token lifecycle", () => {
  it("binds state, persists tokens atomically, validates the identity and coalesces refreshes", async () => {
    const {manager, fetcher, tokenStorePath} = await setup([
      {access_token: "old", refresh_token: "refresh&token", expires_in: 3600}, identity,
      {access_token: "new", refresh_token: "next", expires_in: 3600},
    ]);
    const authorize = new URL(manager.authorizationURL("random-state"));
    expect(authorize.searchParams.get("state")).toBe("random-state");
    expect(authorize.searchParams.get("response_type")).toBe("code");
    expect(await manager.exchangeCode("code")).toMatchObject({userId: "123", login: "streamer"});
    expect(await Promise.all([manager.refresh("old"), manager.refresh("old"), manager.refresh("old")])).toEqual(["new", "new", "new"]);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(String(fetcher.mock.calls[2]?.[1]?.body)).toContain("refresh_token=refresh%26token");
    expect(JSON.parse(await readFile(tokenStorePath, "utf8"))).toMatchObject({accessToken: "new", refreshToken: "next"});
    expect(await manager.refresh("old")).toBe("new");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("rejects another client's token and invalidates a revoked session without blindly refreshing", async () => {
    const wrong = await setup([{access_token: "t", refresh_token: "r", expires_in: 3600}, {...identity, client_id: "other"}]);
    await expect(wrong.manager.exchangeCode("code")).rejects.toThrow("identity");
    await expect(wrong.manager.getAccessToken()).rejects.toThrow("Connect Twitch");
    const revoked = await setup([{access_token: "t", refresh_token: "r", expires_in: 3600}, identity, new Response(null, {status: 401})]);
    await revoked.manager.exchangeCode("code");
    await expect(revoked.manager.validate()).rejects.toMatchObject({status: 401});
    expect(revoked.manager.identity).toBeUndefined();
    await expect(revoked.manager.getAccessToken()).rejects.toThrow("Connect Twitch");
    expect(revoked.fetcher).toHaveBeenCalledTimes(3);
  });
  it("reports missing storage as disconnected", async () => {
    const {manager, fetcher} = await setup([]);
    expect(await manager.load()).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
