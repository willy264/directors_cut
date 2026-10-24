import { randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import express, { type ErrorRequestHandler, type Express } from "express";
import type { Action } from "../core/types.js";
import { errorMessage } from "../effects/executor.js";
import type { Director } from "./director.js";
import type { LiveProvider } from "./live.js";

export function createApp(director: Director, live?: LiveProvider): Express {
  const app = express();
  const assets = fileURLToPath(new URL("../overlay/", import.meta.url));
  const oauthStates = new Map<string, number>();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    const host = req.headers.host || "";
    const allowedHosts = new Set(["localhost", "127.0.0.1", "[::1]"].flatMap(name => [`${name}:${director.config.port}`, `${name}:${req.socket.localPort}`]));
    if (!allowedHosts.has(host.toLowerCase())) { res.status(403).json({ error: "Use the local Director's Cut address." }); return; }
    res.set({ "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cross-Origin-Resource-Policy": "same-origin",
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
    if (req.headers["sec-fetch-site"] === "cross-site" && req.path !== "/auth/callback") { res.status(403).json({ error: "Open the control panel directly." }); return; }
    next();
  });
  app.use(express.json({ limit: "16kb", strict: true }));
  app.use("/assets", express.static(assets, { index: false, dotfiles: "deny" }));
  app.get("/", (_req, res) => { res.sendFile(`${assets}/dashboard.html`); });
  app.get("/overlay", (_req, res) => { res.sendFile(`${assets}/index.html`); });
  app.get("/health", (_req, res) => { res.json({ ok: true, mode: director.config.mode, connection: director.connection }); });
  app.get("/api/state", (_req, res) => { res.set("Cache-Control", "no-store").json(director.publicState(true)); });
  app.get("/events", (req, res) => {
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    const send = () => { if (!res.destroyed) res.write(`event: state\ndata: ${JSON.stringify(director.publicState())}\n\n`); };
    const unsubscribe = director.subscribe(send);
    const heartbeat = setInterval(() => { res.write(": heartbeat\n\n"); }, 15000);
    send();
    req.on("close", () => { unsubscribe(); clearInterval(heartbeat); });
  });
  app.use("/control", (req, res, next) => {
    const supplied = req.get("X-Control-Token") || "";
    const expected = director.controlToken;
    const origin = req.get("Origin");
    if ((origin && origin !== `http://${req.headers.host}`) || supplied.length !== expected.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
      res.status(403).json({ error: "Refresh the local control panel to authenticate this request." }); return;
    }
    if (!req.is("application/json")) { res.status(415).json({ error: "Send JSON controls." }); return; }
    next();
  });
  const field = (body: Record<string, unknown>, name: string): string => {
    const value = body[name]; if (typeof value !== "string" || !value.trim() || value.length > 200) throw new Error(`Missing or invalid ${name}.`); return value;
  };
  app.post("/control/rounds/open", async (_req, res) => { await director.openRound(); res.json({ state: director.publicState() }); });
  app.post("/control/rounds/close", async (req, res) => { await director.closeRound(field(req.body, "roundId"), true); res.json({ state: director.publicState() }); });
  app.post("/control/proposals", async (req, res) => {
    const actor = director.config.mode === "demo" ? { userId: typeof req.body.userId === "string" ? req.body.userId : "demo-director", userName: typeof req.body.userName === "string" ? req.body.userName.slice(0,80) : "Demo Director" } : { userId: director.state.context.broadcasterId, userName: director.broadcaster?.name || "Director" };
    if (!actor.userId || actor.userId.length > 100) throw new Error("Invalid viewer identity.");
    await director.propose(field(req.body, "roundId"), req.body.action as Action, actor); res.json({ state: director.publicState() });
  });
  app.post("/control/votes", async (req, res) => {
    if (director.config.mode !== "demo") { res.status(403).json({ error: "Live votes must come from distinct Twitch accounts in chat." }); return; }
    await director.vote(field(req.body, "roundId"), field(req.body, "proposalId"), field(req.body, "userId")); res.json({ state: director.publicState() });
  });
  app.post("/control/veto", async (req, res) => { await director.veto(field(req.body, "roundId")); res.json({ state: director.publicState() }); });
  app.post("/control/approve", async (req, res) => { await director.approve(field(req.body, "roundId"), field(req.body, "proposalId")); res.json({ state: director.publicState() }); });
  app.post("/control/settings", async (req, res) => { await director.settings(req.body); res.json({ state: director.publicState() }); });
  app.get("/auth/start", (req, res) => {
    if (!live || !director.config.clientId || !director.config.clientSecret || !director.config.broadcasterLogin) { res.status(400).send("Configure live mode and Twitch app credentials in .env, then restart the service."); return; }
    const callback = new URL(director.config.redirectUri);
    if (callback.host !== req.headers.host) { res.redirect(`${callback.origin}/auth/start`); return; }
    for (const [key, expiry] of oauthStates) if (expiry < Date.now()) oauthStates.delete(key);
    const state = randomBytes(32).toString("hex"); oauthStates.set(state, Date.now() + 600000);
    res.cookie("dc_oauth_state", state, { httpOnly: true, sameSite: "lax", path: "/auth", maxAge: 600000 });
    res.redirect(live.auth.authorizationURL(state));
  });
  app.get("/auth/callback", async (req, res) => {
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const cookie = /(?:^|;\s*)dc_oauth_state=([^;]+)/.exec(req.headers.cookie || "")?.[1];
    const expiry = oauthStates.get(state); oauthStates.delete(state);
    res.clearCookie("dc_oauth_state", { path: "/auth" });
    if (!live || !expiry || expiry < Date.now() || state !== cookie || typeof req.query.code !== "string") { res.status(400).send("OAuth response could not be verified. Start Connect Twitch again."); return; }
    await live.auth.exchangeCode(req.query.code); await live.connect(); res.redirect("/");
  });
  app.get("/demo/clips/:id", (_req, res) => { res.type("text").send("Director's Cut — simulated clip\n\nThis is a local demo receipt, not a Twitch clip. Connect a live broadcaster to create real clips."); });
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => { res.status(400).json({ error: errorMessage(error) }); };
  app.use(errors);
  return app;
}
