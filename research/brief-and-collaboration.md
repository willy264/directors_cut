# Hackathon brief verification and streamer collaboration concepts

Research date: 24 October 2026. This is one research workstream for the larger hackathon strategy. Proposed products and feasibility judgments below are our analysis, not sponsor claims.

## Evidence quality and official brief

Direct opens of the three Devpost pages failed in the browsing tool. Searches restricted to their exact URLs returned substantial, freshly indexed text. Treat the brief findings below as **official-source indexed evidence**, with an access limitation; Twitch and competitor documentation was opened directly where indicated. There is no basis here to invent additional sponsors or award tracks.

The [resources page](https://twitchcon-codex.devpost.com/resources) names **Streamer collaboration**, **Audience participation**, and **Content enhancements** as directions. It explicitly describes these as starting points rather than templates. The [overview](https://twitchcon-codex.devpost.com/) describes building for Twitch with Codex and showing the top five on the Codex Booth stage.

The [official rules](https://twitchcon-codex.devpost.com/rules) name Amazon Advertising LLC as sponsor and require a new, working Twitch-connected interactive project built with Codex during the submission period; repository, build/use description, main Codex session ID, and short YouTube demonstration showing Twitch functionality and Codex use. Judges score innovation, impact, implementation/Codex use, and design equally. Cash placements are $10,000, $6,000, $4,000, and two $2,500 runners-up. No separate sponsor-technology awards were present in the retrieved rules. This does **not** make the OpenAI API, Codex SDK at runtime, AWS, or any third-party integration mandatory.

Timing discrepancy: the indexed rules specify 2 November 2026 at 2 PM Pacific Time; the page header specifies PST. That is **22:00 UTC / 23:00 Lagos**, because Pacific daylight saving has ended by then. The resources page's conversion to 21:00 UTC / 22:00 London is inconsistent with that date and Pacific deadline. Use the rule's Pacific time, independently check the live countdown, and aim to submit a day early. The rules state that rules prevail over inconsistent promotional material. The video FAQ accepts unlisted YouTube videos, while rules say publicly visible; a genuinely public video avoids this ambiguity. Do not mistake a saved draft for submitted.

## Technology findings that affect collaboration ideas

**Chat should be an event input, not a pretend video-analysis feed.** Twitch's [chat overview](https://dev.twitch.tv/docs/chat/) recommends EventSub for reception and Helix for sending. Normal bot accounts have sending and join limits; verification reviews are paused. A two- or three-channel prototype can use explicitly authorized channels without assuming mass-scale bot verification.

**Authorization is real work.** The [IRC migration guide](https://dev.twitch.tv/docs/chat/irc-migration/) documents `user:read:chat` for reading and `user:write:chat` for writing; app-token bot operation adds `user:bot` and broadcaster permission or moderator status. Use one deliberately selected transport/auth flow, with broadcaster consent, rather than treating an arbitrary public chat URL as full API authorization.

**Shared Chat has origin information, but origin is not community membership.** [EventSub subscription definitions](https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/) include source broadcaster/message identifiers on shared messages, shared-session lifecycle events, chat deletion, and raid notification. Raid payloads identify channels and a viewer count, not a list of all arriving viewers. Use the message's originating channel to assign a contribution lane; never infer a person's permanent “home community.” Deduplicate canonical source message IDs before applying an action. One shared message echoed into two subscribed rooms must count once.

**Shared Chat is an optional native context, not our product.** [Get Shared Chat Session](https://dev.twitch.tv/docs/api/reference/#get-shared-chat-session) exposes session participants. Helix's reference lists a read endpoint for shared sessions, not a general create-shared-chat endpoint. Bot sends using app versus user access tokens have different shared-message propagation behavior; set source-only handling deliberately. Guest Star management endpoints remain marked beta. Do not make live Guest Star automation a critical dependency merely because the UI is called Stream Together.

**Stream Together already solves basic guest video.** [Twitch's Stream Together guide](https://help.twitch.tv/s/article/stream-together) describes native guest/collaborator calls, browser sources, and OBS integration. Its indexed official help text was readable; the generic help portal can also render only a loading/CSS error in the browser tool. [Twitch's Drop Ins article](https://blog.twitch.tv/en/2024/08/19/drop-ins-make-collaborating-quick-and-easy/) already provides spontaneous collaboration invitations. Our products should build a new shared activity around existing calls.

**Do not rebuild a wall of simultaneous players.** Twitch's own [Squad Stream retirement explanation](https://blog.twitch.tv/en/2023/12/13/retiring-squad-stream/) reports weak adoption and viewers finding a four-view gameplay layout overwhelming. Inference: show one strong shared artifact or one legible joint moment. The native call/video feeds can remain in the creators' chosen layout.

**Raids are a confirmed event, not an instant transfer API.** [Twitch's raid guide](https://dev.twitch.tv/docs/api/raids/) says starting a raid queues native UI; actual completion is determined through EventSub. Recipient restrictions and a failed/canceled raid must leave a proposed handoff uncommitted. A timed handoff in our backend cannot force viewers to move.

**Overlay MVPs avoid depending on public Extension approval.** OBS [Browser Source](https://obsproject.com/kb/browser-source) renders normal web pages, transparent graphics, and audio. [Twitch Extensions](https://dev.twitch.tv/docs/extensions/) offer viewer-side interactive surfaces and testing stages, with a separate review lifecycle. Use chat plus OBS browser overlays first; make an Extension an optional later surface, not a deadline assumption.

**Synchronization has limits.** [EventSub WebSocket handling](https://dev.twitch.tv/docs/eventsub/handling-websocket-events/) explains connection/reconnection and that events missed during an ordinary disconnection are not replayed. Store accepted actions and snapshots; surface a reconnect state. [OBS WebSocket's protocol](https://raw.githubusercontent.com/obsproject/obs-websocket/master/docs/generated/protocol.md) supports authenticated control and commands such as program-scene switching, but that does not synchronize Twitch viewers' HLS playback. Prefer turn windows of several seconds and between-act updates; do not promise sample-accurate remote music or frame-accurate audience reactions.

## Prior-art check and discarded directions

- **Raid scheduling already exists.** [RaidPal's own guide](https://raidpal.com/en/how-to-raid-on-twitch-what-is-a-raid-train) documents scheduled next-streamer handoffs and an OBS panel. [R3dLabs](https://r3dlabs.com/events) has event slots, check-ins, and onward raids. The proposed Raid Relay differentiates through a portable, versioned creative artifact and its custody, not its calendar.
- **Basic collaborative video and multistreaming already exist.** [Restream Pairs](https://support.restream.io/en/articles/11726283-what-is-restream-pairs) lets guests attach their channels to a host broadcast. [StreamYard](https://streamyard.com/guest-interviews) offers browser-based guests and multistreaming. Merely adding AI summaries to another guest-call interface is weak differentiation.
- **Cross-instance automation already exists.** [Streamer.bot's own event reference](https://docs.streamer.bot/api/websocket/events) includes remote instance signals/triggers as well as OBS and Twitch events. A shared button that changes two OBS scenes was considered and rejected as a main concept. A specialized show-calling product might be useful, but novelty would need more evidence.

This is a targeted overlap check, not proof that any following idea is unprecedented. None should be pitched as “first ever.”

## Concept 1 — Raid Relay Studio

**First 15 seconds:** “Your raid carries the world you just built into the next stream.” Show an unfinished tiny animated island leaving creator A's overlay and arriving at creator B's with its existing history intact.

**User and problem.** Small creator collectives already run long raid trains, but viewers arrive with little shared context and the next performance often starts over. A creator who contributes art, an animation rule, or a short text scene should be able to pass something the next creator can visibly continue.

**New mechanism.** A relay is a versioned artifact with an owner, bounded edit slots, and a visible lineage. The sender proposes a checkpoint; the recipient previews and accepts it; the actual expected raid event unlocks the next editing leg. All three conditions matter. A creator's contribution becomes a visible layer, and the new stream immediately explains what changed and what remains to build. End-of-leg recap comes from the structured edit history, not uncertain analysis of a Twitch video feed.

**Concrete episode.** An artist stream draws three creatures into a small scene. Their chat nominates a behavior from a finite catalog. A second creator receives the scene, composes an original eight-step synth motif, and adds a bridge. A third brings every layer to life in a short interactive finale. A viewer can inspect which streamer made each part. The history has genuine creative continuity across different specialties and time zones.

**Twitch and Codex fit.** Twitch chat supplies explicit commands; EventSub confirms raid/channel activity; the OBS browser source shows the artifact and handoff. Each broadcaster consents. Building the engine and handoff logic with Codex satisfies the brief; optional Codex assistance can turn an approved “next creator brief” into a proposed bounded scene-manifest patch. Runtime AI is not essential to the handoff.

**Suggested stack.** TypeScript service, relational state store, event log, web editor, Canvas/SVG renderer, WebSocket broadcast, Twitch OAuth/EventSub. Store JSON scene operations and creator-owned assets; avoid arbitrary scripts, executable uploads, or external audio rights in the MVP. No optional vendor is an official sponsor track.

**Eight-day MVP.** Two broadcasters; one artifact type (a 2D animated diorama); three kinds of edit (shape, behavior, sound pattern); manual native raid initiation; receiving consent; EventSub confirmation; checkpoint history; resume after restart. Do not build a discovery marketplace, a full DAW, or a general game engine.

**Wow demo.** Open with the finished creature jumping between creators' actual Twitch overlays. Rewind its lineage; show creator A locking their layer, raid B, accept on B, and add one surprising change in under a minute. Finish by replaying the whole transformation and credit list. Record real Twitch functionality and Codex build footage within the submission limit.

**Repeat utility.** Weekly relay seasons, creator charity marathons, educational build chains, and community remixes produce an archive of jointly made works. Each week's final artifact becomes the next week's seed.

**Failure conditions.** If the artifact is only a badge or summary, this collapses into RaidPal plus decoration. If a raid is blocked, tiny, canceled, or unobserved during disconnect, do not auto-claim successful transfer; allow clearly marked manual verification and retry. Do not award points for alleged individual raid attendance. Obtaining two willing real streamers is more important than adding another API. Originality confidence: medium; utility and demonstration confidence: high with collaborators.

## Concept 2 — Threefold Studio

**First 15 seconds:** “Three streamers make one living toy: one draws its body, one invents its behavior, one gives it a beat.” Show the combined result, not three dashboards.

**User and problem.** A visual artist, storyteller/coder, and musician can appear together, but their specialties do not automatically combine into a shared work. General video calls provide proximity; a live artifact needs agreed interfaces and a way to resolve incompatible creative changes without hours of plumbing.

**New mechanism.** Each creator owns a different typed layer of a shared scene. Geometry references stable asset IDs; behavior uses approved events and finite actions; music uses a step sequence. Changes are staged between acts. A Codex-assisted build step proposes a declarative manifest patch, checks the combined scene against behavior contracts, and presents a readable diff and preview. Creators approve a version before it appears in their overlays. This makes the build/test/revise loop part of the performance.

**Concrete episode.** Artist A sketches a paper fox in an embedded drawing tool. Creator B says, “It steals the moon only when chat goes quiet.” Creator C adds a small original synth pattern. The approved behavior is expressible through a safe grammar: absence of accepted commands for a configured window triggers an animation, while a specific chat command restores the moon. Codex proposes the mapping; a preview verifies it; all three launch the same saved scene. Later, a conflicting “moon never moves” contribution fails visibly, and the creators negotiate the patch rather than silently accepting broken output.

**Bounded Codex role.** Codex operates on a scoped scene manifest and a fixed test harness during a between-act stage. It may propose/test JSON or DSL patches; the live renderer interprets an allowlisted grammar. Never pipe chat into a shell or evaluate arbitrary generated JavaScript. It is a coding-agent-shaped workflow with explicit artifacts, test output, and revisions. A local creator-authorized Codex session can run the stage; do not place a developer's credentials in an audience browser. Root technology research should verify exact SDK/auth availability and cost before selecting runtime integration.

**Twitch fit.** Distinct originating chat channels nominate one approved change in their creator's lane. Native Stream Together can handle conversation. A shared session is optional; the product's shared artifact state and broadcaster links are explicit. OBS browser overlays display the resulting toy and its three contribution credits. This is a creative collaboration tool whose first output is playable, rather than a generic game with three players.

**Suggested stack.** Shared web editor and deterministic scene runtime; Twitch OAuth/EventSub; persistent manifests; WebAudio step synthesizer; renderer asset validation; Codex build worker or local CLI stage; unit/property tests for references and reachable behaviors; screenshot/smoke preview. The renderer can keep showing the previous approved revision while a new one builds.

**Eight-day MVP.** Support two creators first (art and behavior), then add a built-in step sequencer if stable. Limit to one scene, at most five entities, five event types, and a small behavior library. Provide edit ownership, immutable approved versions, one preview/test stage, and rollback. No external creative-suite integrations or uploaded executable assets are needed.

**Wow demo.** Show the static drawing on Twitch. Say “make it afraid of applause”; submit an approved command mapping; show Codex create a small manifest patch, a failed behavior check, and a corrected preview; then make the fox react live in both streams. Third creator adds a beat that changes only on the permitted event. The audience watches a joint artifact become something nobody could produce alone in that moment.

**Repeat utility.** Weekly miniature worlds, live character jams, collective interactive stories, and event-specific stream mascots produce shareable artifacts and reproducible show formats. Export the declarative scene and its contribution history.

**Failure conditions.** If Codex generates the art, story, and music itself, the human collaboration disappears. If generation takes minutes without a visible stage, pacing suffers; keep a built-in fallback and show the last approved scene. An unrestricted prompt-to-game builder is outside an eight-day scope. Runtime Codex adds setup and latency risk; judge this concept on a narrow proven path, not a hypothetical autonomous game engine. Originality/wow confidence: high; delivery risk: medium-high.

## Concept 3 — Handshake Studio (experimental)

**First 15 seconds:** “Two chats invent a greeting that only works when they learn each other's half.” Both channel crests sit apart; a cross-channel three-step greeting brings them together into one animated character.

**User and problem.** A joint stream merges messages but does not automatically give viewers a shared identity. Inside jokes and emotes remain local. Instead of an AI explaining those jokes, the two communities create and teach a small ritual that becomes something they can reuse when they meet again.

**New mechanism.** Each originating channel proposes one visual token and the meaning its creator wants to assign. Mods approve both halves. Each side must demonstrate the other side's token before the agreement can be activated. The approved ritual is a short finite-state program with a per-source-channel quorum, a time window, and distinct-user counting. It produces a co-owned reactive crest, not merely a translated message. Token meanings are explicitly assigned by people; the software makes no claim to understand community culture universally.

**Concrete three-step ritual.** Channel A teaches “spark,” channel B teaches “wind.” First, two distinct accounts posting from B perform A's approved spark token; second, two from A perform B's wind token; third, one distinct contributor from each origin sends the agreed build token during a forgiving window. The two crests become a flying lantern, stamped with both creators. These are channel-origin participation rules, not identity verification; switching channels cannot prove or disprove community membership. A user is eligible once per stage globally, so one account cannot fill both lanes.

**Why this is more than a poll.** Sequence, teach-back, source provenance, mutual approval, and an artifact that reacts to an agreed language matter. There is no winner-takes-all vote or spam threshold. The greeting can be rehearsed, revised, and replayed at later raids. A post-show card exports the ritual, its authors, and a short visual example. Content creators can issue a new ceremonial rule for a particular collaboration season.

**Twitch and Codex fit.** Source-aware EventSub chat drives the finite-state matcher. Shared-session events add/remove relevant channels; ordinary explicitly linked chats also work. Build the matcher, simulator, and overlay with Codex; optional between-scene Codex assistance proposes a new declarative ritual and tests for unreachable stages, unfair source requirements, and accidental double counting. A plain form is enough for the MVP. Native polls and channel points are unnecessary.

**Suggested stack.** Same basic OAuth/EventSub, state-store, and overlay infrastructure; deterministic finite-state machine; source-message deduplication; source-channel lanes; mod approval; token resolver; small original visual asset library. Respect emote access/permissions; use channel-owned or original approved art. If an approved input is deleted or withdrawn before activation, invalidate the draft and ask the creators to approve its replacement.

**Eight-day MVP.** Exactly two channels, a fixed three-stage ritual template, creator-approved tokens, a teach-back rehearsal, 2-person quorums, one reactive crest, save/replay, and a forgiving reconnect/reset flow. Do not add a culture-classification model, a universal translation bot, or permanent individual reputation.

**Wow demo.** A large burst of A-only spam visibly cannot trigger the crest. B performs A's signal; A answers with B's; the joined lantern appears across both real Twitch overlays. End with one streamer raiding the other and both replaying the saved greeting, showing a real repeat-use case in seconds.

**Repeat utility and uncertainty.** Creator duos and recurring events can build recognizable shared openings, raid greetings, and seasonal collab rituals. This is the most experimental concept: sustained value depends on creators wanting communal ceremony. Prototype with two communities early. If people just press whatever appears on the screen and do not care about authoring/reusing it, cut it rather than disguising a disposable command puzzle as a platform. Originality confidence: medium-high; repeat-use confidence: medium-low pending creator feedback.

## Relative recommendation

Choose **Raid Relay Studio** for the best mix of genuine Twitch dependence, legibility, and achievable execution, provided two real collaborators are available. Choose **Threefold Studio** for the strongest Codex-centered creative demonstration if the team can build one very narrow, safe scene language quickly. Keep **Handshake Studio** as the bolder social experiment; validate its appeal before committing the entire build window.

All three can use optional hosting/database/observability tools, but none should add integrations to chase unverified sponsor prizes. The official requirement is a novel, working Twitch-connected project built with Codex. A real demo of a coherent new collaboration mechanism is more persuasive than a collection of brand names.
