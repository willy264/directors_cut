# Director's Cut

Chat proposes. The audience votes. The channel changes only after a deterministic decision and a verified Twitch result. The streamer can call cut; title and category changes can be restored from their pre-write snapshots.

A local TypeScript service, control room and transparent OBS overlay. Includes a clearly labeled simulation for rehearsal and a live Twitch adapter for all ten actions in the [build spec](docs/DIRECTORS_CUT_SPEC.md).

## Run the demo

Use **Node.js 22.12+ and pnpm 10.32.1**.

```powershell
pnpm install --frozen-lockfile
Copy-Item .env.example .env
pnpm demo
```

On macOS/Linux, use `cp .env.example .env`. Open [the control room](http://localhost:3000) and [the overlay](http://localhost:3000/overlay). No Twitch credentials are needed for demo mode.

1. Open a round and propose a title.
2. Select three different simulated viewers and vote for the proposal. Repeated votes from one viewer count once.
3. Wait for the 25-second window or use **Close voting**. Watch execution progress to confirmation.
4. Choose **Undo last action**. The saved title is restored and independently verified.

The demo never writes to Twitch. Its clip links are labeled local receipts. To try all action forms, add their names to `ENABLED_ACTIONS`. A simulated prediction must first be created; it then has ID `101` and outcome IDs `201` and `202` for testing gated resolution.

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm start
```

`pnpm dev` watches source files. `pnpm start` runs the compiled service; `pnpm live` or `pnpm start:live` selects live mode explicitly. A build copies the overlay assets into `dist`.

## Connect a Twitch channel

Register an app in the [Twitch Developer Console](https://dev.twitch.tv/console/apps), with the exact OAuth redirect `http://localhost:3000/auth/callback`. Set `CLIENT_ID`, `CLIENT_SECRET`, and `BROADCASTER_LOGIN` in `.env`; run `pnpm live`, then use **Connect Twitch**. Authorize the configured broadcaster's own account. The service uses Authorization Code OAuth, validates identity, refreshes tokens, and validates the token hourly.

Set `ENABLED_ACTIONS` and `TWITCH_SCOPES` for your intended features. Available actions are the intersection of configuration, granted scopes and account eligibility. Reconnect OAuth after changing scopes.

| Action | Scope | Verification / undo |
| --- | --- | --- |
| `set_title`, `set_category` | `channel:manage:broadcast` | Matching `channel.update` or exact follow-up read; snapshot undo |
| `create_poll` | `channel:manage:polls` | Poll ID in `channel.poll.begin` or follow-up read |
| `create_prediction` | `channel:manage:predictions` | Prediction ID in `channel.prediction.begin` or follow-up read |
| `create_clip` | `clips:edit` | Poll GET Clips for the returned clip ID, up to 60 seconds |
| `create_marker` | `channel:manage:broadcast` | Authoritative marker resource in the Helix response |
| `shoutout` | `moderator:manage:shoutouts` | Matching `channel.shoutout.create` |
| `snooze_ad` | `channel:manage:ads` and `channel:read:ads` | Authoritative schedule in the snooze response |
| `resolve_prediction` | `channel:manage:predictions` | Streamer approval, then prediction end event or exact read |
| `raid` | `channel:manage:raids` | Streamer approval, then actual outgoing raid event; up to 120 seconds |

`user:read:chat` enables authenticated audience input. Polls, predictions, Channel Points and ad features require an eligible account. Clips, markers, shoutouts and raids also depend on live channel/provider constraints. The default configuration enables title, category, poll, clip and marker actions. Only title/category have undo; a completed poll, clip, shoutout, ad snooze, prediction resolution or raid cannot be rolled back by this app. A local cut cannot cancel an already-started raid countdown; cancel it in Twitch if needed.

The service binds to loopback. Local control requests require a per-process token and the same origin; live audience votes can only come from Twitch EventSub identities. Keep the panel on the streamer's machine. Tokens and event logs are stored under gitignored `data/`; the public SSE stream excludes control credentials.

## Audience commands

Open a round in the streamer panel. Viewers copy the current round ID and proposal ID shown on the overlay. A proposal needs **three distinct votes by default**; submitting it does not automatically cast a vote.

```text
!propose r_ab123456 title Tonight chat runs the show
!propose r_ab123456 category 509658
!propose r_ab123456 poll Next challenge? | Speedrun | No-hit
!propose r_ab123456 prediction Will we finish? | Yes | No
!propose r_ab123456 clip
!propose r_ab123456 marker That clutch save
!propose r_ab123456 shoutout TARGET_BROADCASTER_ID
!propose r_ab123456 snooze
!propose r_ab123456 raid TARGET_BROADCASTER_ID
!propose r_ab123456 resolve PREDICTION_ID WINNING_OUTCOME_ID
!vote r_ab123456 p_cd123456
```

Category commands take an actual Twitch category ID, which the live adapter resolves before acceptance. Poll and prediction commands use a 60-second duration; the panel provides duration fields. Late inputs retain their original round IDs and cannot affect a newer round. Gated winners wait for approval in the authenticated local panel; chat cannot supply that approval.

For Channel Points, enable `ENABLE_CHANNEL_POINTS=true` and grant `channel:manage:redemptions`. On connection the service creates or reuses **Director's Cut: propose**, an app-owned reward that requires viewer input and keeps redemptions in the queue. Enter `ROUND_ID title Your title` (or another action from above). Losing/rejected proposals are refunded; confirmed winners are fulfilled. Voting still uses `!vote`. Existing rewards with incompatible queue/input settings are rejected. Interrupted or failed point settlements are left for manual reconciliation in Twitch; the service does not replay them blindly after a restart.

## OBS and reliability

Add a Browser Source at `http://localhost:3000/overlay`, sized **1920 × 1080**. The page is transparent outside its panels. It receives current state immediately via SSE and reconnects automatically. A disconnected overlay shows that status rather than presenting stale information as live.

The engine is pure: supplied facts and an input event produce new state and commands. I/O lives in adapters. Distinct voters, deterministic ties (vote count, earliest proposal, lexical ID), quorum, text bounds/blocklist, cooldowns and exact approval are enforced before a write. Configure `BLOCKED_TERMS` with comma-separated terms for your channel; external AutoMod and the optional AI mapper are not implemented. `ENABLE_AI=true` fails explicitly rather than pretending a mapper is active.

EventSub handles welcome, watchdogs, deduplication, migration, unexpected reconnects and revocation. The adapter reconciles channel state when reconnecting. Resource IDs, broadcaster, expected fields and execution timing correlate confirmations; authoritative Helix reads can recover missed events. Write requests are never retried after ambiguous network failures. A rejected HTTP 401 may be retried once after refreshing authorization. A rate-limit response stops retries.

Each reduced event and its checkpoint are appended before commands run. Startup restores the latest valid checkpoint without reissuing writes. An interrupted round becomes failed and asks the streamer to inspect Twitch. Demo and live use separate default logs. A truncated final append is repaired; corruption in earlier records stops startup. This is single-process storage: run one instance per event log and broadcaster.

The visible feed contains the current process's recent outcomes; the JSONL journal retains recorded event history. If a write or restore cannot be verified, inspect the actual Twitch channel before continuing. Default confirmation time is eight seconds, with longer windows for clips and raids. Shoutouts enforce at least two minutes globally and sixty minutes per target.

## Verification and build record

The suite covers the pure core, mocked OAuth/Helix/EventSub contracts, effects races, checkpoint recovery, real local HTTP routes and the complete demo title/undo loop. Chrome checks exercised the dashboard, mobile layout and transparent overlay. **Live OAuth and real channel writes still need a credentialed broadcaster rehearsal**; mocked and demo results are not evidence that Twitch accepted a real action. Recording and submitting the hackathon video remain separate manual steps.

Main Codex build session ID: **`01a16b4d-1dd3-75b3-8022-727785426f6c`** (captured from the session environment). See [the build log](docs/BUILD_LOG.md) for the genuine test-first record, diagnosed bugs and rehearsal instructions.

Official references used: [Helix API](https://dev.twitch.tv/docs/api/reference/), [EventSub types](https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/), [WebSocket lifecycle](https://dev.twitch.tv/docs/eventsub/handling-websocket-events/), [OAuth authorization code](https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/#authorization-code-grant-flow), and [token validation](https://dev.twitch.tv/docs/authentication/validate-tokens/).
