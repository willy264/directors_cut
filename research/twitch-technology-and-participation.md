# Twitch technology research and audience participation concepts

Research date: 24 October 2026, Africa/Lagos. Primary technical documentation was opened through the browser. Devpost itself was inaccessible to this worker; the parent researcher supplied the exact verified resource directions and rules. The three directions are starting points, not verified separate prize tracks. No separate sponsor bounty is assumed below.

## Decisions that should shape the idea

The strongest hackathon architecture is a small authoritative game/event server, a streamer control page, and an OBS Browser Source that renders the public experience. Viewers participate using free Twitch chat commands. This gives a real Twitch demonstration without requiring every viewer to install software, leave the channel, purchase Bits, or wait for public Extension approval. An interactive Extension can be a later interface, but should not be the only viable MVP.

Design participation as consequential construction, discovery, coordination, or collective reasoning. A command that changes a persistent shared system is more distinctive than another chatbot response, a one-off distraction, or majority voting. Every command should produce a legible visual consequence, acknowledge the contributor, and remain intelligible to a newcomer.

Runtime AI is optional. Codex's required value is in building the product and demonstrating the development session. An LLM may decorate a result, classify bounded natural-language intent, or author level descriptions, but the game should validate actions deterministically and continue if model calls fail. Never execute viewer-supplied code or give chat access to a developer agent's tools.

## Verified Twitch capabilities and their implications

### Chat and authorization

Twitch explicitly recommends **EventSub plus the Twitch API** for modern chat integrations. IRC remains available but has limited features. The normal account send limits documented are 20 messages/30 seconds, increasing to 100/30 seconds for broadcaster/moderator/VIP contexts; ordinary non-privileged sending is also limited to one message/second/channel. These are output limits, not an invitation to respond once per incoming message. Use the overlay for dense acknowledgements, and send occasional aggregate chat messages. Chat verification reviews are currently paused, so do not make verification a launch dependency. [Twitch Chat overview](https://dev.twitch.tv/docs/chat/)

For the minimal installed/streamer-owned integration, obtain the broadcaster's User Access Token with `user:read:chat`; add `user:write:chat` only if posting is needed. EventSub WebSockets require a User Access Token. For a hosted cloud bot, Twitch documents bot-account grants `user:read:chat`, `user:write:chat`, and `user:bot`, plus broadcaster `channel:bot` consent or applicable moderator status. Webhooks use App Access Tokens. The cloud pattern is useful for a product, but the broadcaster-owned WebSocket pattern is simpler for one-channel MVP validation. [Chat authentication](https://dev.twitch.tv/docs/chat/authenticating/)

The actual receive topic is `channel.chat.message` version `1`, with `broadcaster_user_id` and authorized `user_id` conditions. Receive payloads identify the chatter and message. Chat deletion/clear event types are available, so a product displaying raw submissions should retract or hide deleted material. Optional redemption input uses `channel.channel_points_custom_reward_redemption.add` and `channel:read:redemptions` or `channel:manage:redemptions`. [EventSub subscription types](https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/)

Sending is `POST /helix/chat/messages`, requiring `user:write:chat` for the user-token path; messages are capped at 500 characters. Native custom rewards require broadcaster `channel:manage:redemptions`, cost at least one point, and channels have at most 50 enabled-plus-disabled custom rewards. Management of redemptions is restricted to the app that created the reward. The API reference still documents Affiliate/Partner eligibility errors for these endpoints. [Twitch API reference](https://dev.twitch.tv/docs/api/reference/)

There is a documentation mismatch worth keeping explicit: Twitch Help currently describes Channel Points availability for **all monetized streamers after creator onboarding**, while the API reference still lists Affiliate/Partner restrictions. Native polls are explicitly documented as Affiliate/Partner-only. Do an account-level integration spike before relying on either feature. Our proposed MVPs use free chat inputs and app-owned round energy instead. Apps cannot inspect arbitrary viewers' Channel Point balances, grant bonus points, or move points between channels. [Channel Points FAQ](https://help.twitch.tv/s/article/channel-points-faq), [Native Polls](https://dev.twitch.tv/docs/api/polls/)

OAuth sessions must validate tokens on startup and hourly thereafter using `https://id.twitch.tv/oauth2/validate`; terminate authorization-dependent sessions if revoked. Keep OAuth tokens on the server rather than in the OBS overlay URL. [Token validation](https://dev.twitch.tv/docs/authentication/validate-tokens/)

### Event delivery, reconnects, and scale

EventSub supports webhooks, WebSockets, and Conduits. Delivery is at least once: keep processed `message_id` values so a retry does not apply a purchase, vote, or game action twice. [EventSub overview](https://dev.twitch.tv/docs/eventsub/)

Connect to `wss://eventsub.wss.twitch.tv/ws`, receive the welcome session ID, then create subscriptions through Helix. The socket itself is receive-only except standard Pong frames. Subscribe promptly after welcome; the default initial window is ten seconds. A server-directed reconnect carries a special URL and retains subscriptions; an unexpected lost connection requires reconnecting and resubscribing, and events during the gap are not replayed. Documented user-token connection limits are three active sockets, 300 enabled subscriptions/socket, and aggregate subscription cost 10. [WebSocket handling](https://dev.twitch.tv/docs/eventsub/handling-websocket-events/)

Helix uses token buckets and returns rate-limit headers. Handle HTTP 429 by respecting reset information rather than busy retrying. Do not poll a REST endpoint every animation frame: the authoritative server receives events, reduces state, and pushes compact updates to browser clients. [API concepts and limits](https://dev.twitch.tv/docs/api/guide/)

For Shared Chat, preserve channel provenance and deduplicate copies of the same original action using `source_message_id` when present, falling back to ordinary message ID. The payload also exposes `source_broadcaster_user_id`; that enables channel-based teams without treating duplicated deliveries as extra votes. [EventSub payload reference](https://dev.twitch.tv/docs/eventsub/eventsub-reference/)

### Overlay versus Extension versus media access

An OBS Browser Source is a browser-rendered page supporting custom visual/audio layouts. It can load a URL or local page. A public overlay is rendered into the broadcast, making it suitable for universal spectating; it is not a per-viewer clickable Twitch surface. A distinct streamer page can show private controls while the Browser Source shows audience-only information. This is the key primitive for the asymmetric game proposed below. [OBS Browser Source](https://obsproject.com/kb/browser-source)

A Twitch Extension is a sandboxed iframe with panel, video-overlay, and component views. It can use the Extension Helper for identity, context, and interaction. Its iframe origin and CSP restrictions matter: ordinary Twitch-page DOM access is not a capability to assume. The public documentation's surface does not constitute a generic raw-video or raw-audio feed; that is an implementation inference, not a quoted blanket prohibition. Use a creator-controlled input source for any computer vision or audio processing rather than assuming a viewer token unlocks the stream's pixels. [Extensions overview and security model](https://dev.twitch.tv/docs/extensions/)

Local Test and Hosted Test Extensions are visible only to developer-listed test accounts and some Twitch staff. Public review is currently documented as **8–14 days**, potentially longer around weekends/US holidays. Changes after review require a new review. Thus an Extension-only entry may demonstrate successfully with allowlisted testers but still be unavailable to ordinary viewers before the hackathon deadline. [Extension life cycle](https://dev.twitch.tv/docs/extensions/life-cycle/)

If an Extension is later added, its helper reports `hlsLatencyBroadcaster`, enabling client-specific timing adjustment. Extension PubSub should carry coarse state, not the whole simulation: building guidance specifies one message/second/channel and 5 KB/message. The API reference separately lists 100 messages/minute for a client/broadcaster combination. Respect the stricter applicable limit; interpolate visuals locally or use an appropriately allowlisted app backend. [Extension reference](https://dev.twitch.tv/docs/extensions/reference/), [Building Extensions](https://dev.twitch.tv/docs/extensions/building/)

The embedded-player API exposes `getPlaybackStats().hlsLatencyBroadcaster`. `getCurrentTime()` works for VODs, not live streams. It also documents a `Twitch.Player.CAPTIONS` event with caption text synchronized to video; this is useful only when actual captions exist. It is not universal transcription access. [Video and Clips embedding](https://dev.twitch.tv/docs/embed/video-and-clips/)

**Design inference:** video delay differs from chat/event timing, so avoid sub-second reaction scoring. Put round IDs in commands, accept 15–30 second planning windows, show the result in a separate resolution phase, and allow the streamer to extend/pause rounds. Those round lengths are suggested product choices, not Twitch guarantees. An EventSub event timestamp is not proof of the exact video frame a viewer saw.

### Test what can actually fail

The Twitch CLI has a local mock WebSocket server, event injection, reconnect simulation, and close/revocation scenarios. Use that for development and a real broadcaster-authorized Twitch channel for final acceptance. Clearly label simulated crowd inputs in any recording; a mock load test is useful evidence, but does not replace showing real Twitch users controlling the product. [Twitch CLI WebSocket testing](https://dev.twitch.tv/docs/cli/websocket-event-command/)

## Audience participation concepts

These are original proposals, not verified globally unprecedented inventions. Build estimates assume an experienced small team, a deliberately narrow browser MVP, and eight available build days. Optional cross-direction growth should not expand the first demo.

### A1. Signal Salvage — the audience is the missing instrument panel

**Hook:** The streamer pilots a damaged salvage sub. Viewers can see a sonar/navigation layer that is deliberately absent from the streamer's cockpit. Neither side can finish the expedition alone.

**First 15 seconds:** Put the empty cockpit beside the rich public sonar and say: “I can steer, but only you can see the safe passage. Your chat messages are our instruments.” One `!probe` command immediately reveals a wreck cell with the contributor's name.

**Loop:** Chatters claim one of three free station roles: sonar, power, or engineering. Each round, sonar users probe a different map cell, engineers connect a small circuit, and power users allocate scarce battery capacity. The community combines this distributed work into a navigable route. The streamer hears/reads the crew's plan, then executes the next maneuver using the limited cockpit view. A rescue scene reveals whose contribution exposed the hidden passage.

**Why it is distinctive:** The audience possesses necessary information and does parallel work; it does not vote on the streamer's left/right controls. Twitch delay becomes an intentional radio/planning cadence. Individual viewers can make useful contributions even when they disagree with the majority.

**MVP:** One 12×12 wreck map, three roles, three hazards, 20-second planning phases, 2D vector sonar. Two app routes subscribe to the same state: a private cockpit and public OBS overlay. Inputs such as `!probe C4 r3`, `!wire B2 B3 r3`, and `!power sonar 2 r3` arrive via EventSub. One accepted action/viewer/round; no paid energy or native polls. No private messaging, Extension, computer vision, or game-memory injection is needed.

**Three-minute demonstration:** Show the cockpit lacking route knowledge; two real viewers reveal a blocked corridor and reconnect a relay; the captain follows their plan; the recovered artifact's credit roll identifies the crew. Reserve 20–30 seconds for Codex building/debugging footage.

**With 5–20 real viewers:** Split them across the three stations, show 15–30 seconds of parallel work, and reveal a route that requires information from all stations. One viewer cannot complete the network through spam. With 1–4 viewers, permit explicit station switching between planning phases and a smaller authored map; one real person can perform several different jobs over successive rounds. Do not fill the crowd with unlabeled bot actions. Every command carries a round ID; this is a planning game, not a reaction-speed contest.

**Integration:** Twitch provides identity, chat event transport, and live consequence. Codex builds the asymmetric renderers, deterministic reducer, puzzle generation and integration tests. Optional runtime model adds salvage logs after the result, never decides whether the rescue succeeded. A later two-streamer version gives each channel different instruments.

**Risk and cut:** The streamer could glance at the public preview; treat that as an honor-based game convention and hide OBS preview during play. Puzzle authoring, rather than networking, is the hardest work. Author one excellent map before procedural generation. Highest recommendation for a convincing participatory demo.

### A2. Amendment Engine — chat rewrites the laws of a tiny world

**Hook:** The streamer must cross a miniature machine-world whose rules are drafted by the audience. Proposed amendments preview their consequences before becoming law.

**First 15 seconds:** Show an impossible gap, then a viewer's rule card makes a ghost bridge appear: “You do not control my character. You write the laws I have to survive.”

**Loop:** Viewers contribute bounded rule cards: `IF red tile THEN bounce`, `IF switch B THEN open gate A`, `IF carrying lantern THEN bridge solid`. The server composes them with existing laws, displays ghost trajectories for competing rule sets, and highlights a contradiction or newly reachable route. Chat combines compatible cards into an amendment; the streamer ratifies it and tries the run. Successful and disastrous laws remain in an evolving public constitution with contributor attribution and rollback history.

**Why it is distinctive:** Crowd Control already triggers game effects; this product is about **composable causal rules**, visible counterfactual previews, and collective debugging. The entertainment comes from emergent combinations and understanding why a seemingly helpful law failed.

**MVP:** A turn-based grid puzzle, not arbitrary 3D physics. Three predicates, three effects, eight interactable cells, bounded rule count, deterministic state graph. Commands select from a grammar; a reachability check flags obvious soft locks and permits a safe rollback. Do not promise that every arbitrary rule set is solvable. Broadcast previews with an OBS source and accept free commands through the same chat adapter as A1.

**Three-minute demonstration:** One viewer creates a bridge rule; another creates a lantern condition; the preview shows why the pair blocks a door; the audience edits one clause; the streamer crosses; the constitution adds both contributors. Include the Codex session creating the first failing reachability test and the fix.

**With 5–20 real viewers:** Allow three proposal slots and separate clause contributions, rather than five identical majority ballots. A second viewer must co-sign an amendment while the remaining group can identify a concrete conflicting rule. Use a 25-second proposal phase and a separate resolution/run phase. With 1–4 viewers, lower the co-sign requirement and let the host author one seed clause openly; retain actual viewer authorship of the decisive edit. The social mechanic is negotiating compatible laws, not predicting the next outcome.

**Integration:** Codex's software-building role is naturally visible: it constructs a tiny rules interpreter, replay debugger, and validation tests. A runtime model can translate a viewer's phrase into an existing card suggestion, then demand schema validation; omit that from the MVP if it slows interaction.

**Risk and cut:** General-purpose rule languages are a trap. Ship nine combinations with excellent visual explanations. Never evaluate submitted JavaScript. Estimated difficulty is medium-high; the scope is viable only with a small discrete world.

### A3. Chat Naturalist — a community authors an ecosystem, then lives with its consequences

**Hook:** Chat grows a persistent artificial island where each viewer can introduce one inheritable trait, and the streamer runs seasonal survival expeditions inside the resulting world.

**First 15 seconds:** Show a dry island, two tiny lineages, and one user's water-storage trait appearing on a creature: “You are designing the species. We are about to find out which of your choices survives the next season.”

**Loop:** Each round the island faces a visible environmental problem: limited water, long night, or migrating food. Different viewers contribute bounded traits—water storage, nocturnal sight, cooperation—into species proposals. Each species has a fixed trait budget, so a popular super-creature cannot take everything. A short simulation generation reveals the consequences: a slow creature survives drought but cannot reach distant food. The streamer changes one environmental lever or performs a rescue expedition. Newcomers can inspect the lineage and contribute to an underrepresented species, rather than trying to outspam veteran viewers.

**Why it is distinctive:** The product is a collectively authored causal system with lineage and long-term consequences, rather than a crowd of cosmetic avatars. Contributor identities remain legible through family trees and trait provenance. The simulated ecology makes no claim to biological realism.

**MVP:** Three traits, two resources, three small species, one tile island, and deterministic 10-second generation resolution. Viewer actions are `!trait moss water r4` or `!support dune coop r4`; one energy unit/person/round. Use an app-owned energy system, not Twitch Channel Points. Streamer only controls season and one rescue action. Save the world between sessions.

**Three-minute demonstration:** Two viewers introduce opposing traits; fast creatures dominate initially; the streamer starts a drought; the previously overlooked water-storing lineage survives; open its family tree to reveal the viewers who created the adaptation. Then show Codex changing a flawed trait calculation and rerunning the deterministic replay.

**With 5–20 real viewers:** Divide the crowd between three species with a fixed trait budget per species; display the tradeoffs and authors while they bargain in chat. Normalize by species budget rather than message count. Accept mutations for 20–30 seconds, then close inputs before resolving the generation. With 1–4 viewers, start two preset species and let every real participant contribute to either lineage over successive rounds; presets are clearly labeled as seed populations, not simulated spectators. The satisfying outcome is discovery of an interaction that the crowd did not initially understand, rather than a win/lose poll.

**Integration:** Twitch supplies identity and participation; Codex builds the simulation, instrumentation, replay and attribution. An optional model names species or writes a short field-guide entry from actual observed outcomes. Cross-channel expansion could send a seed species with a raid, but automatic cross-channel state transfer requires explicit product authorization and should remain stretch scope.

**Risk and cut:** Simulation balance can be tedious and hard to explain. Keep the fitness rules visible and deterministic. Stop at three traits; polish the causal reveal instead of adding realistic genetics. Feasibility medium; differentiation strong if the visual lineage is excellent.

### A4. Relayworks — nobody owns the whole solution

**Hook:** A community builds an emergency water/power network, but every person may place only one component per round. Good teamwork is visible as a working machine, not a vote tally.

**Loop:** The broadcast shows a failing settlement and a finite parts supply. New viewers get an immediately useful role: place a pipe, relay, fuse or storage cell. Components have different costs and dependencies; several individually sensible actions can overload the system. A preview marks pressure/voltage flow, the streamer chooses when to commit the construction phase, and the resulting system must survive a short stress event. Credits follow the physical route, highlighting each contributor's piece.

**Distinctive move:** The system measures complementary contributions and repairs, rather than raw message volume. A small new community can play with four people; a large chat contributes candidate pieces and local teams coalesce plans. It gives the streamer a shared artifact to narrate.

**MVP and demo:** One 8×8 pipe board, one resource, three component types, three stress events, 20-second build rounds, finite accepted commands. In the demo, one user's storage tank saves another user's fragile pipe network when the streamer releases a flood. Render the water path and named components in OBS. A season or sprawling colony is unnecessary.

**Integration and risk:** Entirely Codex-built deterministic simulation plus Twitch identity/chat. Runtime AI adds little, so leave it out. The obvious analogue is collaborative construction and Twitch Plays; differentiation depends on contributor ownership, causal stress testing, and the host's meaningful timing choice. This is the safest build, but A1 or A2 has a sharper pitch.

## Competitive checks and what they disqualify

[Crowd Control](https://crowdcontrol.live/) already supports viewer-triggered in-game events, effects, puzzles, and keyboard actions. [Its Disrupts product](https://crowdcontrol.live/disrupts) already offers custom overlays, sound effects, challenges and keybinds. Therefore “chat causes random effects in any game” and “custom AI distractions” are weak standalone pitches. A2 differentiates with a persistent compositional rules system and deterministic preview, not merely a larger effect menu. This is a product comparison, not a claim that no competitor has any similar feature.

[Stream Avatars](https://streamavatars.com/) already provides customizable viewer avatars, cooperative boss fights, battle royale, duels, and command-driven basketball. Therefore a generic chat pet, avatar arena, or community boss battle is a crowded direction. A3 must show inheritance, resource tradeoffs and causal lineage in the working demo to earn its distinction; cosmetic creatures alone do not.

The broad mechanic of Twitch Plays is explicitly named by the hackathon itself, so “Twitch Plays, but with an LLM” does not establish originality. A1's information asymmetry, A2's composed rule debugging, A3's shared lineage, and A4's complementary construction each provide a more concrete reason for people to participate.

## Recommended order and build gate

1. **Signal Salvage:** strongest live collaboration between host and audience; explainable in one sentence; no expensive infrastructure.
2. **Amendment Engine:** most technically expressive Codex story and strongest counterfactual reveal; constrain the rule language immediately.
3. **Chat Naturalist:** best persistent community artifact and return-to-stream hook; balancing/visual clarity need attention.
4. **Relayworks:** fallback if time is short; easiest deterministic MVP, less distinctive pitch.

Before committing, build one vertical slice in four hours: authorize a real test channel; receive two users' commands; render different private/public state; visibly resolve one consequential round. If an idea cannot create a compelling moment with two viewers and one round, adding more features or runtime AI will not repair the core loop.

For an eight-day plan: day 1 Twitch/OBS vertical slice; days 2–3 deterministic core loop; day 4 role/contribution UI; day 5 newcomer explanation and creator controls; day 6 real-channel playtests/reconnect recovery; day 7 visual polish and recording; day 8 fix submission/demo gaps. This is a planning estimate, not a rule-derived schedule. Save Codex footage/session ID from the start.
