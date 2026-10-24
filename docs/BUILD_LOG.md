# Build record

Main Codex session: `01a16b4d-1dd3-75b3-8022-727785426f6c`, read from the active session environment. Workers built the pure core, Twitch contracts and UI; the main agent built effects, the service and integration. Features are delivered through pull requests and merged into `main` at the repository owner's request.

## Test-first evidence

The core worker wrote 64 substantive tests against the existing `NotImplementedError` stubs. All 64 failed before implementation. Implementation and additional regressions brought the core to 77 passing tests. The session transcript records that sequence; no footage was manufactured.

Additional review tests exposed actual integration defects:

- A previous matching channel event could confirm a newer title change. Effects now record write start time and exclude earlier provider events, while retaining events that arrive during the request.
- A verification read that never completed suppressed its confirmation deadline. Deadline checks now run independently of an in-flight read; late responses are ignored.
- A partial final JSONL record was recoverable once but broke the second restart. Recovery now removes only the incomplete append and preserves complete records; malformed checkpoints are rejected.
- Concurrent context refreshes overwrote each other's fields. Patches now apply inside the serialized event queue.
- Subscription setup could finish after stop and resurrect a dead connection. Generation and transport checks prevent stale async completions from marking it connected.
- Starting the next round while refunds were in flight could drop a losing redemption. Refund work now captures redemptions before awaiting requests.
- A confirmed title updated the provider but left the channel card stale. Only a successfully correlated confirmation now updates displayed channel facts.

Regression tests are in `test/effects` and `test/server`; the HTTP title/undo test also verifies three distinct voters and repeat-vote deduplication.

## Provider corrections to the supplied plan

- WebSocket metadata uses `message_id` and `message_timestamp`, rather than webhook HTTP headers.
- Revocation requires resolving authorization; the adapter does not blindly recreate a revoked subscription.
- Manage-polls and manage-predictions scopes authorize their corresponding read subscriptions.
- Reading the ad schedule requires `channel:read:ads`, in addition to the write scope for snooze.
- Clips are verified through GET Clips, allowing up to 60 seconds. There is no clip-created EventSub claim. The current create-clip reference omits legacy `has_delay`.
- Raid confirmation is the actual outgoing raid, after Twitch's countdown or Raid Now. API acceptance alone does not mean the raid happened.
- Shoutouts enforce a two-minute global and sixty-minute target cooldown.
- Markers and ad snoozes use the authoritative created resource/schedule response. Every action is not claimed to have an EventSub confirmation or undo.

Sources: [Helix reference](https://dev.twitch.tv/docs/api/reference/), [subscription types](https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/), [WebSocket handling](https://dev.twitch.tv/docs/eventsub/handling-websocket-events/).

## Rehearsal before submission

Local verification uses real HTTP routes and Chrome against the simulated provider. Desktop and mobile layouts, SSE updates, three distinct votes, a confirmed title and verified undo were exercised. Real channel success has not been recorded because broadcaster credentials were unavailable in the workspace.

Connect the intended broadcaster, go live, open a title round, gather three actual chat votes, and inspect the native Twitch channel after confirmation. Exercise undo, a native poll and a real clip. Check the returned clip URL. Disconnect/reconnect EventSub and confirm channel resync without replaying a write. If points are enabled, inspect one losing refund and one winning fulfillment in Twitch's queue.

For the video, show the real channel changing, snapshot undo, the green core suite and one genuine regression above. Explain clip polling rather than using the supplied script's incorrect “clip confirmed by EventSub” line. Label demo-mode segments. Keep the final cut under the hackathon video limit, include the public repository URL and this session ID, and submit through Devpost after checking its current deadline.
