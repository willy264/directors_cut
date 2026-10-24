# Director's Cut

Audience proposals and votes drive real Twitch channel actions through a pure
decision engine. This repository currently contains the **starter scaffold**.
`validate`, `tally`, `reduce`, and `applyVeto` intentionally throw
`NotImplementedError`; Twitch, server, effects, and overlay directories are
reserved for the next implementation steps.

Use Node.js 22.12+ and pnpm 10.32.1 (pinned in package.json).

```powershell
pnpm install
Copy-Item .env.example .env
pnpm typecheck
pnpm build
```

On macOS/Linux, use `cp .env.example .env` for the copy step. Fill in Twitch app
credentials and the broadcaster login when implementing OAuth. Register
`http://localhost:3000/auth/callback` as the callback. Environment parsing, token
storage, OAuth and service startup are not implemented yet.

`pnpm test` and `pnpm test:watch` are wired to Vitest. There are no tests yet;
`pnpm test` deliberately reports no tests and exits nonzero until real tests are
added. Start with the core behavior in `test/core/`: validation boundaries,
quorum, deterministic ties, stale events, snapshots, confirmation and veto races.

```text
src/core/
  types.ts       Typed actions, context, rounds, events and commands
  config.ts      Defaults injected into the engine
  errors.ts      Explicit NotImplementedError
  validate.ts    Validation stub
  tally.ts       Deterministic tally stub
  engine.ts      Reducer and veto stubs
  index.ts       Public core exports
src/twitch/      OAuth, EventSub and Helix (next)
src/effects/     Command executor, persistence and verification (next)
src/server/      Express, control routes and SSE (next)
src/overlay/     OBS HTML/JS (next)
test/core/      Core unit tests (next)
test/twitch/    Adapter contract tests (next)
data/           Local event log and token store; gitignored
```

The [original build spec](docs/DIRECTORS_CUT_SPEC.md) contains the product plan.
The scaffold makes these implementation boundaries explicit:

- Quorum is captured on each round so `tally(round)` is self-contained.
- Time, execution IDs, external facts and approval are supplied to the core.
- A snapshot command completes before the engine emits a reversible write.
- Confirmation carries an execution ID, execute/revert purpose and expected
  fields/resource identity, so late original results cannot masquerade as undo.
  Clips use a follow-up read; not every action has an EventSub confirmation.
- Only title/category actions have snapshot-based undo in this scope.
- `ReadonlySet` voters must be encoded as arrays for JSONL/SSE and decoded during
  replay. Never serialize the in-memory state directly with JSON.stringify.
- The supplied spec understates shoutout cooldowns: Twitch documents two minutes
  globally and 60 minutes for the same target. The defaults reflect both.
  [Official reference](https://dev.twitch.tv/docs/api/reference/#send-a-shoutout)

The minimum scopes in `.env.example` cover the first title/poll/clip slice. Add
optional scopes as actions are enabled. `channel:manage:polls` also covers poll
EventSub subscriptions. AI proposal mapping is disabled by default and has no
runtime implementation or SDK dependency at this stage.

Main Codex build session ID: **not recorded yet**. Obtain it from `/status` in the
main build thread and record it before preparing the hackathon submission.
