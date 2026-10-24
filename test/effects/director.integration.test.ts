import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Action, CoreEvent } from "../../src/core/types.js";
import type { ActionProvider } from "../../src/effects/executor.js";
import type { AppConfig } from "../../src/server/config.js";
import { Director } from "../../src/server/director.js";
import { EventLog } from "../../src/server/event-log.js";
import { context, state } from "../core/fixtures.js";

let directory = "";
const directors: Director[] = [];
function config(): AppConfig {
  return { mode: "demo", host: "127.0.0.1", port: 3000, clientId: "", clientSecret: "", broadcasterLogin: "", redirectUri: "http://localhost:3000/auth/callback", scopes: [],
    engine: context().config, enabledActions: ["set_title", "create_clip"], blockedTerms: [], eventLogPath: join(directory, "events.jsonl"), tokenStorePath: join(directory, "tokens.json"), channelPoints: false, rewardCost: 100 };
}
function provider(): ActionProvider {
  const expect = { via: "eventsub", resource: "channel.update", broadcasterId: "100", expected: { title: "Chat directs the show" } } as const;
  return { snapshot: vi.fn(async () => ({ broadcasterId: "100", title: "Saved title", categoryId: "200", capturedAt: Date.now() })),
    execute: vi.fn(async () => ({ expect, confirmation: { ...expect, observed: expect.expected } })), verify: vi.fn(async () => undefined), refund: vi.fn(async () => {}) };
}
function setup() {
  const actions = provider();
  const director = new Director(config(), actions);
  directors.push(director);
  director.state = state();
  vi.spyOn(director.journal, "append").mockResolvedValue();
  return { director, actions };
}
async function microtasks() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "directors-cut-director-test-")); vi.useFakeTimers(); vi.setSystemTime(1_100); });
afterEach(async () => { for (const director of directors) await director.stop(); directors.length = 0; vi.useRealTimers(); await rm(directory, { recursive: true, force: true }); });

describe("Director queued execution", () => {
  const close: CoreEvent = { t: "round_closed", id: "close", at: 1_100, roundId: "r1", executionId: "e1" };
  it("persists the execution decision before asking a provider to read or write", async () => {
    const { director, actions } = setup();
    let finish!: () => void;
    vi.mocked(director.journal.append).mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const closing = director.dispatch(close);
    await microtasks();
    expect(actions.snapshot).not.toHaveBeenCalled();
    expect(actions.execute).not.toHaveBeenCalled();
    expect(director.state.round?.state).toBe("collecting");
    finish(); await closing; await microtasks();
    expect(actions.snapshot).toHaveBeenCalledTimes(1);
    expect(actions.execute).toHaveBeenCalledTimes(1);
  });
  it("queues snapshot, accepted and immediate confirmation without deadlock or duplicate writes", async () => {
    const { director, actions } = setup();
    await director.dispatch(close);
    await microtasks();
    expect(actions.execute).toHaveBeenCalledTimes(1);
    expect(director.state.round?.state).toBe("confirmed");
    const events = vi.mocked(director.journal.append).mock.calls.map(([event]) => (event as CoreEvent).t);
    expect(events).toEqual(["round_closed", "snapshot_ready", "execution_accepted", "execution_confirmed"]);
  });
  it("does not issue writes if the local journal cannot persist the decision", async () => {
    const { director, actions } = setup();
    vi.mocked(director.journal.append).mockRejectedValueOnce(new Error("Disk full"));
    await expect(director.dispatch(close)).rejects.toThrow("Disk full");
    await microtasks();
    expect(actions.snapshot).not.toHaveBeenCalled();
    expect(actions.execute).not.toHaveBeenCalled();
    expect(director.state.round?.state).toBe("collecting");
    expect(director.connection).toBe("error");
  });
  it("serializes simultaneous votes so neither distinct voter is lost", async () => {
    vi.setSystemTime(1_050);
    const { director } = setup();
    await Promise.all([
      director.dispatch({ t: "vote_cast", id: "v1", at: 1_050, roundId: "r1", proposalId: "p1", userId: "c" }),
      director.dispatch({ t: "vote_cast", id: "v2", at: 1_050, roundId: "r1", proposalId: "p1", userId: "d" }),
    ]);
    expect([...director.state.round!.votes.p1!]).toEqual(["a", "b", "c", "d"]);
  });
  it("merges concurrent context patches against the latest serialized state", async () => {
    const { director } = setup();
    await Promise.all([director.updateContext({ isLive: false }), director.updateContext({ adSnoozesRemaining: 0 })]);
    expect(director.state.context.isLive).toBe(false);
    expect(director.state.context.adSnoozesRemaining).toBe(0);
  });
  it("marks an interrupted vetoed write as failed on restart without replaying provider writes", async () => {
    const cfg = config(); cfg.mode = "live";
    const prior = state();
    await new EventLog(cfg.eventLogPath).append({ id: "last" }, { ...prior, round: { ...prior.round!, state: "vetoed", execution: { id: "e1", purpose: "execute", phase: "request_pending", startedAt: 1_000 } } });
    const actions = provider();
    const director = new Director(cfg, actions);
    directors.push(director);
    await director.initialize();
    expect(director.state.round?.execution?.phase).toBe("failed");
    expect(director.state.round?.error).toContain("restarted");
    expect(actions.execute).not.toHaveBeenCalled();
  });
  it("restores a potentially applied write once after an ambiguous network failure", async () => {
    const { director, actions } = setup();
    vi.mocked(actions.execute).mockImplementation(async (action) => {
      if (action.kind === "set_title" && action.params.title === "Chat directs the show") throw new TypeError("Connection lost after write");
      const expect = { via: "eventsub" as const, resource: "channel.update", broadcasterId: "100", expected: { title: "Saved title" } };
      return { expect, confirmation: { ...expect, observed: expect.expected } };
    });
    await director.dispatch(close);
    await microtasks();
    expect(actions.execute).toHaveBeenCalledTimes(2);
    expect(vi.mocked(actions.execute).mock.calls[1]?.[0]).toEqual({ kind: "set_title", params: { title: "Saved title" } });
    expect(director.state.round?.state).toBe("failed");
    expect(director.state.round?.rollback?.phase).toBe("reverted");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(actions.execute).toHaveBeenCalledTimes(2);
  });
  it("a veto while writing waits for that request to settle before restoring", async () => {
    const { director, actions } = setup();
    let finishOriginal!: () => void;
    const originalExpected = { via: "eventsub" as const, resource: "channel.update", broadcasterId: "100", expected: { title: "Chat directs the show" } };
    vi.mocked(actions.execute).mockImplementation(async (action) => {
      if (action.kind === "set_title" && action.params.title === "Chat directs the show") {
        await new Promise<void>((resolve) => { finishOriginal = resolve; });
        return { expect: originalExpected, confirmation: { ...originalExpected, observed: originalExpected.expected } };
      }
      const expect = { ...originalExpected, expected: { title: "Saved title" } };
      return { expect, confirmation: { ...expect, observed: expect.expected } };
    });
    await director.dispatch(close); await microtasks();
    await director.veto("r1"); await microtasks();
    expect(actions.execute).toHaveBeenCalledTimes(1);
    expect(director.state.round?.state).toBe("vetoed");
    finishOriginal(); await microtasks();
    expect(actions.execute).toHaveBeenCalledTimes(2);
    expect(director.state.round?.state).toBe("vetoed");
    expect(director.state.round?.rollback?.phase).toBe("reverted");
    expect(director.log.filter((item) => item.status === "confirmed")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(actions.execute).toHaveBeenCalledTimes(2);
  });
  it("late original evidence cannot replace the channel state after verified undo", async () => {
    const { director, actions } = setup();
    const originalExpect = { via: "eventsub" as const, resource: "channel.update", broadcasterId: "100", expected: { title: "Chat directs the show" } };
    vi.mocked(actions.execute).mockImplementation(async (action) => {
      if (action.kind === "set_title" && action.params.title === "Chat directs the show") return { expect: originalExpect };
      const expect = { ...originalExpect, expected: { title: "Saved title" } };
      return { expect, confirmation: { ...expect, observed: expect.expected } };
    });
    await director.dispatch(close); await microtasks();
    await director.veto("r1"); await microtasks();
    expect(director.state.round?.rollback?.phase).toBe("reverted");
    expect(director.state.context.channel?.title).toBe("Saved title");
    await director.dispatch({ t: "execution_confirmed", id: "late-original", at: 1_102, roundId: "r1", executionId: "e1", purpose: "execute", confirmation: { ...originalExpect, observed: originalExpect.expected } });
    expect(director.state.round?.state).toBe("vetoed");
    expect(director.state.context.channel?.title).toBe("Saved title");
  });
  it("reports that opening is blocked while a veto still awaits the original request", async () => {
    const { director } = setup();
    const previous = director.state.round!;
    director.state = { ...director.state, round: { ...previous, state: "vetoed", execution: { id: "e1", purpose: "execute", startedAt: 1_000, phase: "request_pending" } } };
    await expect(director.openRound()).rejects.toThrow();
    expect(director.state.round?.id).toBe("r1");
  });
  it.each([null, {}, { kind: "set_category" }, { kind: "set_category", params: { categoryId: [] } }])("rejects malformed action shape before calling the provider (%j)", async (action) => {
    vi.setSystemTime(1_050);
    const { director } = setup();
    director.prepare = vi.fn(async () => {});
    await expect(director.propose("r1", action as Action, { userId: "viewer", userName: "Viewer" })).rejects.toThrow();
    expect(director.prepare).not.toHaveBeenCalled();
  });
});
