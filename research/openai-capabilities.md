# OpenAI capabilities and integration choices

Research date: 24 October 2026. These are technical findings and design recommendations for the Codex x TwitchCon hackathon, not additional competition requirements. Source pages were opened and their relevant content inspected. No API calls, account provisioning, or product builds were performed.

## 1. Separate the required build tool from the optional product runtime

The event requires a project built with Codex and a working Twitch connection. Its brief does not require a runtime OpenAI API integration. Consequently there are three legitimate design choices:

1. Build the complete product with Codex and run ordinary application code during a stream.
2. Build with Codex and add model calls for bounded tasks such as interpreting proposed actions, rewriting instructions, or producing dialogue.
3. Build with Codex and make an additional Codex integration part of the product, such as generating a constrained scene between acts.

Choice 3 can make sponsor fit especially visible, but introduces an execution environment, authentication, variable task duration, and rollback requirements. It should have a compelling product purpose. Evidence: [event rules](https://twitchcon-codex.devpost.com/rules).

## 2. Codex SDK and noninteractive execution

The official TypeScript SDK can start a thread, run a prompt, continue a thread, and resume it by ID. Noninteractive `codex exec` supports JSON event output and a final response constrained by an output schema. These interfaces make a bounded backstage authoring task plausible. They do not establish a guaranteed latency or a zero-configuration multi-tenant runtime.

Sources: [Codex SDK](https://developers.openai.com/codex/sdk/), [noninteractive mode](https://developers.openai.com/codex/noninteractive/).

Recommended product use: the streamer commissions a change to a small scene description, a worker produces a candidate, application checks run, and the creator previews the version before publication. While it works, the current version remains live. A timeout retains that version. A downloaded asset includes its revision and contribution credits.

For a hackathon, constrain the output to a small declarative schema such as objects, approved behaviors, colors, and musical patterns. The application interprets that data. If the demo claims Codex actually edits source code, implement a separate disposable worker with file and network restrictions and prove the build/test/preview loop. Do not call ordinary structured content generation a source-code compiler.

Avoid handing raw Twitch messages to a coding agent that can access the streamer's working directory or credentials. Treat a message as a proposed creative contribution, validate it, and pass only the accepted brief into a worker. This follows directly from the product's trust boundary, rather than being a generic compliance layer.

## 3. Structured Outputs: turn proposals into inspectable actions

Structured Outputs can constrain response shape to supported JSON Schema. Function calling lets a model request an application-defined operation; application code executes the operation. Both are useful for converting natural language into a visible action card. Neither establishes that an action is fair, physically possible, truthful, or authorized.

Sources: [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs), [function calling](https://developers.openai.com/api/docs/guides/function-calling).

Recommended pattern:

`viewer proposal -> typed candidate -> application rule validation -> visible preview -> authoritative state transition`

Examples: map a proposal onto a bridge part from a fixed catalog; extract a proposed experiment from an allowed menu; produce an NPC's dialogue using only that NPC's known facts. State changes, resource spending, identity limits, and winners are calculated by application code. Refusals, incomplete outputs, and timeouts have explicit fallback states.

## 4. Vision: useful observation, not ground truth

Image-capable models accept visual inputs, but the official documentation acknowledges mistakes and limitations including small text and precise visual interpretation. They are suitable for candidate labels and descriptions. They are a poor foundation for exact scores, collision detection, measurements, or a high-frequency game loop.

Source: [Images and vision](https://developers.openai.com/api/docs/guides/images-vision).

A Twitch chat/API connection does not itself provide a general video-frame feed. For a physical experiment or drawing stream, have the creator explicitly share a camera/window or supply selected snapshots. Sample at meaningful checkpoints, crop to the selected region, and confirm important observations. For an original game, structured telemetry is more accurate and cheaper than reading game state from pixels.

Design consequence: a vision model can suggest that a blue cart crossed a marker; a local tracker, sensor, or creator confirmation supplies the measurement used by the simulation or scoreboard. Never present a generated counterfactual as an observed result.

## 5. Audio: choose a workflow by the actual job

The current official audio overview distinguishes conversational voice, realtime transcription, translation, and generated speech. A transcription session supplies text from live audio without needing a talking assistant. Realtime conversational APIs support voice interaction and tool use. The overview currently points new conversational projects toward GPT-Live; an older Realtime example should not be treated as the only current voice architecture.

Sources: [Audio and voice](https://developers.openai.com/api/docs/guides/audio), [realtime transcription](https://developers.openai.com/api/docs/guides/realtime-transcription), [Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations).

Recommended use: optional push-to-talk capture for a creator's instruction, then a preview card. A short narrator line between rounds is often sufficient. Persistent conversational voice adds cost, interruption handling, consented media capture, and the danger of talking over the streamer. It should be central to the experience if included.

Do not assume background music and multiple speakers produce perfectly separated transcripts. Confirm names, measurements, and irreversible actions. Live captions can improve access, but captions alone do not make a distinctive hackathon concept.

## 6. Image generation and content checks

The image-generation tool can create or edit images from text and optional image inputs. It is appropriate for a chapter card, a prop, or a finished visual artifact generated between scenes. It is unsuitable as a synchronous dependency for every viewer action. Use an existing asset or a procedural placeholder while a new asset is pending.

Source: [Image generation](https://developers.openai.com/api/docs/guides/tools-image-generation).

The Moderation API supplies text/image classification signals; this is not the same as protection against prompt injection or enforcement of game rules. A finite action vocabulary and moderator controls remain useful for public contributions. Source: [Moderation](https://developers.openai.com/api/docs/guides/moderation).

## 7. Runtime and cost discipline

These are proposed engineering targets, not vendor performance guarantees:

- Run the actual game, measurement processing, timers, and state transitions without waiting for a model.
- Process ordinary chat commands without model calls. For natural-language proposals, batch or debounce and enforce a per-round cap.
- At 20 accepted proposals per minute, a 90-minute stream would already create 1,800 interpretation calls if each proposal makes one request. At one call per three-second batch it is also 1,800; the call cap must follow desired workload, not the presence of batching alone.
- Reserve expensive generation for intermissions or accepted creative contributions. Log actual token/audio/image usage and apply a session budget.
- Store stable instructions before changing context to make prompt-cache reuse possible; a continuing session does not guarantee a cache hit.
- Capture request duration in a pilot, then set the round format around measured behavior. Display a pending state and keep a last-known-good artifact.

Sources: [prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching), [official JavaScript SDK timeout/retry behavior](https://developers.openai.com/api/reference/typescript). No current model price or measured latency is asserted here.

For these proposals, a TypeScript service, browser dashboard, browser-rendered overlay, and a small durable event store are enough to start. A host must actually support the selected long-lived connections and workers. An ordinary short-lived function endpoint is not automatically a suitable EventSub WebSocket listener or Codex worker.

## 8. Make Codex use reviewable

A credible development narrative could show: Codex scaffolding the Twitch adapter; a real failed reconnect test; the resulting fix; and the finished interaction. Preserve the main build thread ID and a small development log with prompts, decisions, commits, and validation results. Showing iteration communicates technical judgment more effectively than asserting that all source code came from an agent.

The runtime Codex feature, if present, is a separate claim from the fact that Codex helped build the application. Demonstrate both honestly. A production coding agent should never sit on the critical path of a fast live game.
