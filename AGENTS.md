# Director's Cut

The user-provided plan is in [docs/DIRECTORS_CUT_SPEC.md](docs/DIRECTORS_CUT_SPEC.md).
Follow the active user request when it narrows that plan. The repository now
contains a runnable local service with demo and live Twitch adapters.

- Use pnpm. Commit pnpm-lock.yaml when making dependency changes.
- Keep src/core pure: no network/filesystem calls, environment reads, timers,
  wall-clock reads, random IDs, or imports from Twitch/effects/server modules.
- Inject facts, time and identifiers. Copy state and voter sets before updates.
- Implement meaningful core tests before filling in each stub. Never replace a
  stub with permissive fake validation or claim unfinished tests have passed.
- Normalize Twitch payloads at the adapter boundary. Correlate execution and
  confirmation; obtain reversible snapshots before the write.
- Trusted streamer approval comes from authenticated control events, not chat
  params. Keep account tokens and runtime logs in gitignored local storage.
- Check current official Twitch docs before implementing provider calls; the
  spec is a product plan, not an authoritative API reference.
- Run pnpm typecheck, pnpm test and pnpm build for implementation changes.
  Distinguish local/mock verification from real Twitch channel verification.
- Publish features through separate pull requests, verify their checks, and
  merge them to main, as requested by the repository owner.
