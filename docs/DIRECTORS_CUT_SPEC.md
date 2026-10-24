# Director's Cut — Build Spec

**Hackathon:** Codex × TwitchCon ($25,000 pool). **Deadline:** 2 Nov 2026, 2:00 PM PST — verify the live countdown; the FAQ's UTC conversion is off by an hour, so treat **2:00 PM PST (≈22:00 UTC / 23:00 Lagos)** as truth and aim to submit a full day early.
**Build window for this plan:** ~24 hours, single developer + Codex.
**What we're building:** a tool that hands the audience the streamer's own broadcaster control room. Chat votes; the *real* Twitch channel changes — title, category, polls, predictions, clips, markers, shoutouts, ad snooze. No game world is invented; **Twitch's own Helix API is the game world.**

> **Read this first, Codex:** the heart of this project is a small, pure, deterministic **decision engine** (`/src/core`) with a real unit-test suite. Everything else (Twitch I/O, overlay) is plumbing around it. When you build, build the core + its tests first and keep all side effects out of it — that is both the correct architecture and the thing we will show in the demo as "Codex built and verified this." Capture the main Codex session ID via `/status` at the start and keep it.

---

## 0. The product in one loop

```
viewer action (EventSub)  →  decision engine validates + tallies (pure code)
      →  effects layer calls Helix (a REAL Twitch action)
      →  EventSub fires back confirming it happened
      →  overlay renders "chat did this", crediting the proposer
```

This is a **read → act → verify** loop. We never assume a Helix call worked and draw it optimistically — we wait for the confirming EventSub event and render *that*. Using the API in both directions is a deliberate technical-sophistication signal for judges.

The audience never touches Twitch directly. Every action passes through our engine, which validates legality, enforces quorum/cooldown, snapshots how to revert, and gives the streamer a veto. "The director can always call cut" is a feature, not a patch.

---

## 1. Tech stack (chosen for a 24h single-service build)

- **Language:** TypeScript (Node 20+).
- **One service**, run with `ts-node`/`tsx` in dev:
  - `ws` — EventSub WebSocket client.
  - `express` — OAuth redirect callback, overlay static hosting, a small control API, and an SSE stream to the overlay.
  - **State:** in-memory + an append-only JSON-lines event log on disk (`./data/events.jsonl`) for durability and replay. SQLite is optional; do **not** spend time on a DB if files suffice.
- **Overlay:** a single static `index.html` + vanilla JS (or tiny Preact), receiving state over **SSE** (`EventSource`) — simpler than a second WebSocket and reconnects for free.
- **Tests:** `vitest`. The `/src/core` suite is the deliverable test surface.
- **No public server required.** EventSub **WebSocket** transport + a **user access token** means everything runs on `localhost`. This is the single biggest reason this project is demo-safe.

---

## 2. Twitch auth & scopes

**Flow:** OAuth **Authorization Code** grant. We need a user access token for the broadcaster, because EventSub WebSocket subscriptions and all the write actions are user-scoped.

1. Register an app in the Twitch Developer Console → get **Client ID** + **Client Secret**. Add redirect URL `http://localhost:3000/auth/callback`.
2. Send the streamer to `https://id.twitch.tv/oauth2/authorize?response_type=code&client_id=...&redirect_uri=...&scope=<space-separated scopes>`.
3. Exchange `code` at `https://id.twitch.tv/oauth2/token` → `access_token` + `refresh_token`. Persist both.
4. **Refresh on 401** via the refresh token; never hard-code tokens.

**Scopes to request (exact):**

| Scope | Enables |
|---|---|
| `user:read:chat` | Read chat via EventSub (`channel.chat.message`) |
| `user:write:chat` | Post status messages back to chat (optional but nice) |
| `channel:read:redemptions` **or** `channel:manage:redemptions` | Read Channel-Point redemptions; `manage` also lets us create rewards + refund points |
| `channel:manage:broadcast` | Change title/category; create stream markers |
| `channel:manage:polls` | Create/read polls |
| `channel:manage:predictions` | Create/lock/resolve predictions |
| `clips:edit` | Create clips |
| `moderator:manage:shoutouts` | Send shoutouts |
| `channel:manage:ads` | Snooze next ad break |
| `channel:read:ads` | Receive `channel.ad_break.begin` |
| `moderation:read` *(optional)* | Check AutoMod status on proposed text |
| `channel:manage:raids` *(stretch)* | Start a raid |

> The streamer must be a Twitch **Affiliate/Partner** for polls, predictions, and Channel Points to exist on their account. Use an eligible test account. Free `!chat` commands work on any account, so the demo degrades gracefully if points are unavailable.

---

## 3. EventSub — the input & confirmation layer

**Connect:** `wss://eventsub.wss.twitch.tv/ws`.

**Lifecycle (implement all of this — it's where reliability points live):**
1. On connect, receive `session_welcome` → read `payload.session.id`.
2. For each subscription, `POST https://api.twitch.tv/helix/eventsub/subscriptions` with
   ```json
   { "type": "...", "version": "...", "condition": { ... },
     "transport": { "method": "websocket", "session_id": "<from welcome>" } }
   ```
   Headers: `Client-Id`, `Authorization: Bearer <user token>`.
3. Handle message types: `session_keepalive` (reset a watchdog timer), `notification` (an event), `session_reconnect` (Twitch is moving you — connect to the new URL in the payload **before** closing the old socket), `revocation` (a sub died — log and re-create).
4. **Dedup:** keep an LRU of `Twitch-Eventsub-Message-Id` (10-min TTL). Drop repeats and any message whose `Twitch-Eventsub-Message-Timestamp` is older than 10 minutes.
5. **Outage resync:** missed events are **not** replayed. On any reconnect, immediately `GET` current channel state (title/category) via Helix and reconcile, so the engine's view of "revertible state" is never stale.

**Subscriptions to create:**

| Purpose | Type | Ver | Condition | Scope |
|---|---|---|---|---|
| Read chat (free-tier commands) | `channel.chat.message` | 1 | `broadcaster_user_id`, `user_id` | `user:read:chat` |
| Point-redemption command bus | `channel.channel_points_custom_reward_redemption.add` | 1 | `broadcaster_user_id` | `channel:read:redemptions` |
| Confirm title/category change | `channel.update` | 2 | `broadcaster_user_id` | — |
| Confirm poll started | `channel.poll.begin` | 1 | `broadcaster_user_id` | `channel:read:polls` |
| Live poll tally (optional overlay) | `channel.poll.progress` | 1 | `broadcaster_user_id` | `channel:read:polls` |
| Confirm prediction started | `channel.prediction.begin` | 1 | `broadcaster_user_id` | `channel:read:predictions` |
| Prediction live state (optional) | `channel.prediction.progress` | 1 | `broadcaster_user_id` | `channel:read:predictions` |
| Ad break started (context) | `channel.ad_break.begin` | 1 | `broadcaster_user_id` | `channel:read:ads` |
| Raid context (stretch) | `channel.raid` | 1 | `to_broadcaster_user_id` | — |

> ⚠️ **Verify before coding:** confirm each subscription's exact `version` and payload field names against the canonical list at `https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/`. Twitch bumps versions; this table is correct as of research but must be checked first.

**Clip confirmation:** there is no reliable "clip created" EventSub event, so for clips we confirm by polling `GET /helix/clips?id=<id>` until it resolves (a clip takes a few seconds to finalize), then render the edit URL.

---

## 4. Helix — the action layer

All calls: base `https://api.twitch.tv/helix`, headers `Client-Id` + `Authorization: Bearer <user token>`.

| Action | Method & path | Scope | Key constraints |
|---|---|---|---|
| Set title / category / language | `PATCH /channels` | `channel:manage:broadcast` | title ≤ 140 chars; `game_id` must be a real category ID |
| Resolve category name → ID | `GET /games?name=<name>` | — | returns `data[].id`; if empty, reject the proposal |
| Read current channel info (for revert) | `GET /channels?broadcaster_id=` | — | snapshot title+game before changing |
| Create poll | `POST /polls` | `channel:manage:polls` | title ≤ 60; 2–5 choices; choice ≤ 25; duration 15–1800s |
| Create prediction | `POST /predictions` | `channel:manage:predictions` | title ≤ 45; 2–10 outcomes; outcome ≤ 25; window 30–1800s |
| End/resolve prediction *(gated)* | `PATCH /predictions` | `channel:manage:predictions` | **irreversible** — streamer confirm required |
| Create clip | `POST /clips?broadcaster_id=` | `clips:edit` | stream must be live; returns `id` + `edit_url`; poll to confirm |
| Create stream marker | `POST /streams/markers` | `channel:manage:broadcast` | description ≤ 140 |
| Send shoutout | `POST /chat/shoutouts` | `moderator:manage:shoutouts` | needs `from_`, `to_broadcaster_id`, `moderator_id`; rate-limited by Twitch (1 per 2 min per target) |
| Create custom reward | `POST /channel_points/custom_rewards` | `channel:manage:redemptions` | used at startup to spawn our proposal rewards |
| Refund / fulfil redemption | `PATCH /channel_points/custom_rewards/redemptions` | `channel:manage:redemptions` | set `CANCELED` to refund points when a round loses |
| Snooze next ad | `POST /channels/ads/schedule/snooze` | `channel:manage:ads` | limited snoozes available; read remaining from response |
| Start raid *(stretch, gated)* | `POST /raids` | `channel:manage:raids` | **irreversible** — streamer confirm required |
| Check AutoMod on text *(optional)* | `POST /moderation/enforcements/status` | `moderation:read` | screen proposed title/shoutout text |

**Rate limits:** Helix is a token-bucket (watch `Ratelimit-Remaining`/`Ratelimit-Reset` headers). Our round cooldown (§6) keeps us well under budget; the engine must also refuse to fire if the bucket is near empty.

---

## 5. The deterministic engine — `/src/core` (the Codex-build centrepiece)

**Design rule: the core is pure.** It takes state + an input event and returns `(newState, commands[])`. It performs **no** I/O. The effects layer executes the commands and feeds results back in as new events. This is what makes it fully unit-testable and what we showcase.

### 5.1 Types

```ts
type ActionKind =
  | "set_title" | "set_category" | "create_poll" | "create_prediction"
  | "create_clip" | "create_marker" | "shoutout" | "snooze_ad"
  | "resolve_prediction" /*gated*/ | "raid" /*gated*/;

interface Action { kind: ActionKind; params: Record<string, unknown>; }

interface Proposal {
  id: string;            // uuid
  roundId: string;
  action: Action;
  proposedBy: { userId: string; userName: string };
  at: number;            // ms epoch
}

type RoundState =
  | "collecting" | "resolving" | "executing"
  | "confirmed" | "failed" | "vetoed";

interface Round {
  id: string;
  state: RoundState;
  opensAt: number; closesAt: number;
  proposals: Proposal[];
  votes: Record<string /*proposalId*/, Set<string /*userId*/>>;
  winner?: Proposal;
  revert?: Action;       // how to undo the winner, snapshotted pre-exec
}

// Commands are the ONLY way the core causes side effects.
type Command =
  | { t: "helix"; action: Action; roundId: string; revertSnapshotNeeded?: boolean }
  | { t: "await_confirm"; roundId: string; expect: string; timeoutMs: number }
  | { t: "refund"; roundId: string; losingProposalIds: string[] }
  | { t: "render"; payload: unknown };
```

### 5.2 Pure functions to implement (each gets tests)

- `validate(action, ctx): Ok<Action> | Err<ValidationError>` — enforce every Helix constraint from §4 **before** anything fires: title/choice/outcome lengths, counts, durations; category exists (ctx supplies resolved IDs); text passes the profanity/blocklist (+ optional AutoMod); reversibility is possible; action isn't on cooldown; rate-limit budget is sufficient; gated actions carry a `streamerConfirmed` flag.
- `tally(round): Proposal | null` — pick the winner deterministically. Rule: most distinct voters; **tie-break by earliest `at`, then lexical `id`.** Must be a pure function of the round — identical input always yields identical winner.
- `reduce(state, event): { state, commands }` — the round state machine:
  `collecting` → (timer fires) → `resolving` → (winner or none) → `executing` → emits `helix` + `await_confirm` → on confirm `confirmed`, on timeout/error `failed` (+ auto-revert if a partial change happened) → veto event at any point → `vetoed` (+ revert command).
- `applyVeto(state, roundId): { state, commands }` — emits the revert command built from the snapshot.

### 5.3 Reversibility

Before executing a reversible action, the effects layer fetches current state (`GET /channels` for title/category) and stores it on the round as `revert`. Veto or failure replays `revert`. Irreversible actions (`resolve_prediction`, `raid`) are **not** auto-firable — the engine only emits them when `params.streamerConfirmed === true`, which the control panel sets.

### 5.4 Griefing defences (all in `validate` + engine)

- **Quorum:** a proposal needs ≥ `QUORUM` (default 3) distinct voters to be eligible to win. One troll can't act alone.
- **Text safety:** every string bound for a title/marker/shoutout runs through a blocklist and (optional) AutoMod check; failure rejects the proposal.
- **Cooldown:** global `COOLDOWN_MS` (default 10s) between executing rounds; per-action-kind cooldown for rate-limited ones (shoutout ≥ 2 min).
- **Streamer veto/undo:** always available from the control panel; wins over everything.

---

## 6. Timing & checkpoint design (handles the video↔event gap)

The streamer's dashboard reacts instantly; viewers see the overlay **10–30s later** through HLS delay. We never reward millisecond reactions — everything is **checkpoint-gated into rounds**:

- **Round window:** `COLLECTING` = **25s** (tunable via env). Long enough that even delayed viewers can still vote "in time."
- **Phases:** `COLLECTING (25s)` → `RESOLVING (~1s, tally+lock)` → `EXECUTING (Helix call + await confirm, 8s timeout)` → `CONFIRMED` / `FAILED`.
- **Cooldown:** `COOLDOWN_MS` (10s) before the next round opens.
- **Round IDs everywhere:** every proposal/vote carries its `roundId`; the engine drops any input whose round is no longer `collecting`. This kills late/duplicate events from a closed round.
- **One round at a time** in the MVP. (Parallel rounds are a post-hackathon feature; don't build them now.)

---

## 7. Optional OpenAI integration (behind a flag — only if time allows)

The **only** sanctioned use: map a viewer's freeform `user_input` into a typed candidate action via **structured outputs**, e.g. `"make the title about the WR speedrun attempt"` → `{ kind: "set_title", params: { title: "WR attempt — Any% — come watch" } }`. **The engine still validates and decides.** Model proposes, code disposes. Gate it behind `ENABLE_AI=true`; the product is complete and demoable without it. Do **not** put any model call in the hot path or let model output fire an action directly.

---

## 8. Repo layout

```
directors-cut/
  AGENTS.md            # this spec (or a pointer to it)
  README.md            # setup + scopes + judge instructions + Codex session ID
  .env.example         # CLIENT_ID, CLIENT_SECRET, BROADCASTER_LOGIN, round/quorum knobs, ENABLE_AI
  src/
    core/              # PURE — types.ts, validate.ts, tally.ts, engine.ts
    twitch/            # oauth.ts, eventsub.ts (ws client+dedup+reconnect), helix.ts
    effects/           # executor.ts (runs Commands, snapshots revert, awaits confirm)
    server/            # app.ts (express: /auth/callback, /overlay, /events SSE, /control)
    overlay/           # index.html + overlay.js (EventSource → render round + director's log)
  test/
    core/              # validate.test.ts, tally.test.ts, engine.test.ts  ← the demo's test surface
    twitch/            # helix.contract.test.ts (mocked fetch), eventsub.dedup.test.ts
  data/                # events.jsonl (gitignored)
```

---

## 9. 24-hour build schedule (vertical slice first)

| Hours | Goal | Done-when |
|---|---|---|
| **0–2** | Scaffold + OAuth + token refresh. Connect EventSub WS, subscribe to redemptions + `channel.update`, log events to console. | Redeem a reward → event prints. *(This is the day-one vertical slice: real Twitch action in → our code sees it.)* |
| **2–6** | `/src/core`: types, `validate`, `tally`, `reduce` + **full vitest suite**. Round lifecycle in isolation (no I/O). | `npm test` green; engine drives a round end-to-end on fake events. |
| **6–10** | Effects layer + Helix client. Wire `set_title`, `create_poll`, `create_clip` with the await-confirm loop + revert snapshot. | Chat/redemption → **real title change** confirmed via `channel.update` → logged. |
| **10–14** | Overlay: round panel (proposals, countdown, tally) + "Director's Log" feed with proposer credit. SSE from service. | Overlay in OBS shows a live round and the confirmed action. |
| **14–17** | Remaining actions: prediction (gated resolve), marker, shoutout, ad snooze. Control panel: veto/undo, confirm-gate, quorum knob. | All actions fire + are vetoable; gated ones need confirm. |
| **17–19** | Reliability: EventSub dedup + `session_reconnect` + outage resync; Helix rate-limit budget; cooldowns; point refunds on losing rounds. | Kill/restart the socket mid-round → no dupes, state resyncs. |
| **19–21** | *(Optional)* `ENABLE_AI` structured-output mapper. Overlay visual polish (readable at stream res, light/dark safe). | Looks clean on a 1080p stream; AI flag works or is cleanly off. |
| **21–23** | Record Codex-build footage (see §10) + rehearse the 2:40 on a **real** channel. | One clean dry run start-to-finish. |
| **23–24** | Freeze submission snapshot; finish README (scopes, setup, **main Codex Session ID** from `/status`); record final demo; submit. | Repo + <3min YouTube video + Session ID submitted, a day before deadline. |

---

## 10. Codex-build story — capture this as you go

Judging weights "Technical implementation, **especially Codex use**" at 25%. Make the agent's work visible:

1. **Session ID:** run `/status` at the start, record the **main session UUID**, put it in the README and the submission.
2. **Show the core being built test-first.** The pure `/src/core` + its vitest suite is the perfect artifact — film Codex writing `tally` and `validate`, running the tests, and a test going red → fixed.
3. **Capture one real bug Codex diagnosed** — e.g. a non-deterministic tie-break, a missed EventSub dedup, or a revert that didn't restore category. Show red → root cause → green. This is far more convincing than "Codex wrote glue."
4. **Narrate the read→act→verify loop** as the architecture Codex implemented.
5. Keep the session log; the rollout lives under `~/.codex/sessions/` as JSONL if you need to reference decisions.

---

## 11. Demo script — 2:40 (leaves buffer under the 3:00 cap)

| Time | On screen | Voiceover beat |
|---|---|---|
| **0:00–0:15** | Live stream, overlay visible. A one-line title card: *"What if chat ran the control room?"* | "This is Director's Cut. The audience isn't playing a game — they're operating my actual Twitch channel." |
| **0:15–0:55** | Chat redeems **"Propose a title"** + types text. A 25s round opens on the overlay; votes stack; it resolves. **Cut to the Twitch dashboard** showing the title actually changed. | "They propose, they vote, and in 25 seconds the *real* stream title changes — here's the dashboard, it's not a graphic." |
| **0:55–1:25** | Chat triggers **"Open a prediction."** A **real Channel-Points prediction** pops in the native Twitch UI. Then a funny moment → chat spams `!clip` → round resolves → **real clip URL** appears in the Director's Log. | "A prediction the *crowd* opened. A clip the *crowd* cut — here's the link, created by Helix, confirmed by EventSub." |
| **1:25–1:45** | Someone proposes a bad title; it's auto-filtered / streamer taps **Veto**; overlay shows the revert. | "Code is always in charge — quorum, filtering, and the director can call cut. The crowd drives; it can't crash the car." |
| **1:45–2:20** | Screen-capture of **Codex**: the `/src/core` test suite running green, a tie-break test going red → fixed, the read→act→verify architecture. Show the **Session ID**. | "Codex built the engine test-first — this pure decision core, its tests, and the bug it caught in the tie-break logic. Session ID's in the repo." |
| **2:20–2:40** | Overlay wide shot: the Director's Log scrolling with credited actions. End card: repo URL + "install in minutes, any Affiliate channel." | "No game to learn, no server to host — one OAuth and an overlay. Any streamer can hand their audience the booth." |

> Label any pre-recorded or simulated segment. Keep the final cut at ~2:40 so nothing depends on judges watching past the limit.

---

## 12. Definition of done (MVP)

- [ ] OAuth + token refresh working; scopes from §2 granted.
- [ ] EventSub WS: welcome, subscribe, keepalive watchdog, reconnect, dedup, revocation — all handled.
- [ ] `/src/core` pure engine with passing vitest suite (validate, tally, reduce, veto).
- [ ] At minimum **title change, poll, and clip** fire for real and are confirmed via the verify step.
- [ ] Quorum + cooldown + streamer veto/undo + reversibility snapshots working.
- [ ] Overlay shows live round + Director's Log, readable on a 1080p stream.
- [ ] README with setup, scopes, judge run-instructions, and the **main Codex Session ID**.
- [ ] Frozen submission snapshot; <3min video; submitted ≥1 day before deadline.

**Stretch (only if green early):** prediction auto-resolve (gated), raid (gated), ad snooze, `ENABLE_AI` structured-output proposal mapper, per-viewer private proposal UI (would require a Twitch Extension — **do not attempt**: 8–14 day review exceeds the hackathon).