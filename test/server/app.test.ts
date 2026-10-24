import { createServer, request, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DemoProvider } from "../../src/effects/demo.js";
import { createApp } from "../../src/server/app.js";
import { loadConfig } from "../../src/server/config.js";
import { Director } from "../../src/server/director.js";

const resources: { directory: string; server: Server; director: Director }[] = [];

async function setup(mode: "demo" | "live" = "demo") {
  const directory = await mkdtemp(join(tmpdir(), "directors-cut-http-"));
  const config = loadConfig({ APP_MODE: mode, EVENT_LOG_PATH: join(directory, "events.jsonl"), COOLDOWN_MS: "0", ROUND_WINDOW_MS: "60000" }, []);
  const provider = new DemoProvider();
  const director = new Director(config, provider);
  await director.initialize();
  const server = createServer(createApp(director));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  resources.push({ directory, server, director });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const getState = async () => {
    const response = await fetch(`${base}/api/state`);
    return await response.json() as ReturnType<Director["publicState"]>;
  };
  const state = await getState();
  const post = (path: string, payload: unknown, headers: Record<string, string> = {}) => fetch(`${base}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Control-Token": state.controlToken!, ...headers }, body: JSON.stringify(payload),
  });
  return { base, director, provider, getState, post, token: state.controlToken! };
}

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    resource.server.closeAllConnections();
    await new Promise<void>((done, reject) => resource.server.close((error) => error ? reject(error) : done()));
    await resource.director.stop();
    // Cleanup is limited to this test's own freshly created temporary directory.
    if (dirname(resolve(resource.directory)) !== resolve(tmpdir())) throw new Error("Unexpected test directory");
    await rm(resource.directory, { recursive: true, force: true });
  }
});

describe("local HTTP control boundary", () => {
  it("requires the current control token and accepts authenticated local controls", async () => {
    const app = await setup();
    for (const token of ["", "wrong", "x".repeat(app.token.length)]) {
      const denied = await app.post("/control/rounds/open", {}, { "X-Control-Token": token });
      expect(denied.status).toBe(403);
      expect(app.director.state.round).toBeNull();
    }
    const accepted = await app.post("/control/rounds/open", {});
    expect(accepted.status).toBe(200);
    expect((await app.getState()).round?.state).toBe("collecting");
  });

  it("rejects foreign origins and non-loopback Host headers even with a valid token", async () => {
    const app = await setup();
    const foreign = await app.post("/control/rounds/open", {}, { Origin: "https://untrusted.example" });
    expect(foreign.status).toBe(403);
    // Use the HTTP client directly: fetch normalizes the forbidden Host header.
    const reboundStatus = await new Promise<number>((done, reject) => {
      const req = request(`${app.base}/api/state`, { headers: { Host: "untrusted.example" } }, (res) => {
        res.resume(); done(res.statusCode!);
      });
      req.on("error", reject); req.end();
    });
    expect(reboundStatus).toBe(403);
    const crossSite = await fetch(`${app.base}/api/state`, { headers: { "Sec-Fetch-Site": "cross-site" } });
    expect(crossSite.status).toBe(403);
    expect(app.director.state.round).toBeNull();
  });

  it("serves a no-store control snapshot and immediately streams state without its control token", async () => {
    const app = await setup();
    const snapshot = await fetch(`${app.base}/api/state`);
    expect(snapshot.headers.get("cache-control")).toBe("no-store");
    expect(snapshot.headers.get("content-security-policy")).toContain("script-src 'self'");
    const stream = await fetch(`${app.base}/events`);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const reader = stream.body!.getReader();
    try {
      const chunk = await reader.read();
      const text = new TextDecoder().decode(chunk.value);
      expect(text).toContain("event: state\n");
      const json = text.split("\n").find((line) => line.startsWith("data: "))!.slice(6);
      const event = JSON.parse(json) as Record<string, unknown>;
      expect(event.mode).toBe("demo");
      expect(event).not.toHaveProperty("controlToken");
      expect(text).not.toContain(app.token);
    } finally { await reader.cancel(); }
  });

  it("blocks synthetic votes in live mode", async () => {
    const app = await setup("live");
    const response = await app.post("/control/votes", { roundId: "r_1", proposalId: "p_1", userId: "pretend-viewer" });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: expect.stringContaining("distinct Twitch accounts") });
  });

  it("credits live control proposals to the authenticated broadcaster rather than supplied viewer fields", async () => {
    const app = await setup("live");
    app.director.broadcaster = { id: "100", login: "real_director", name: "Real Director" };
    await app.director.updateContext({ broadcasterId: "100", channel: await app.provider.snapshot(), isLive: true, allowedActions: new Set(["set_title"]) });
    app.director.setConnection("connected");
    expect((await app.post("/control/rounds/open", {})).status).toBe(200);
    const roundId = (await app.getState()).round!.id;
    const response = await app.post("/control/proposals", { roundId, action: { kind: "set_title", params: { title: "A real proposal" } }, userId: "spoofed-viewer", userName: "Spoofed Viewer" });
    expect(response.status).toBe(200);
    expect((await app.getState()).round!.proposals[0]?.proposedBy).toEqual({ userId: "100", userName: "Real Director" });
  });
});

describe("demo HTTP round and verified undo", () => {
  it("counts distinct votes, verifies a title change, and restores the previous title on cut", async () => {
    const app = await setup();
    const originalTitle = (await app.getState()).channel!.title;
    expect((await app.post("/control/rounds/open", {})).status).toBe(200);
    const roundId = (await app.getState()).round!.id;
    expect((await app.post("/control/proposals", { roundId, action: { kind: "set_title", params: { title: "The audience made this happen" } }, userId: "alice", userName: "Alice" })).status).toBe(200);
    const proposalId = (await app.getState()).round!.proposals[0]!.id;
    for (const userId of ["alice", "alice", "bob", "carol"]) {
      expect((await app.post("/control/votes", { roundId, proposalId, userId })).status).toBe(200);
    }
    expect((await app.getState()).round!.proposals[0]!.votes).toBe(3);
    expect((await app.post("/control/rounds/close", { roundId })).status).toBe(200);
    expect((await app.getState()).log.filter((entry) => entry.status === "confirmed")).toHaveLength(0);
    await vi.waitFor(async () => expect((await app.getState()).round?.state).toBe("confirmed"), { timeout: 5000, interval: 50 });
    const confirmed = await app.getState();
    expect(confirmed.channel?.title).toBe("The audience made this happen");
    expect(confirmed.round?.canUndo).toBe(true);
    expect(confirmed.log).toContainEqual(expect.objectContaining({ status: "confirmed", actor: "Alice" }));
    expect((await app.post("/control/veto", { roundId })).status).toBe(200);
    await vi.waitFor(async () => expect((await app.getState()).round?.executionPhase).toBe("reverted"), { timeout: 5000, interval: 50 });
    const restored = await app.getState();
    expect(restored.round?.state).toBe("vetoed");
    expect(restored.channel?.title).toBe(originalTitle);
    expect(restored.log).toContainEqual(expect.objectContaining({ message: "Saved channel state restored and verified." }));
  });
});
