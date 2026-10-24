import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Executor, type ActionProvider } from "../../src/effects/executor.js";
import type { Command, Confirmation, CoreEvent } from "../../src/core/types.js";

const expected = { via: "eventsub", resource: "channel.update", broadcasterId: "100", expected: { title: "New title" } } as const;
const observation: Confirmation = { ...expected, providerEventId: "provider-event", observed: expected.expected };
const execute: Command = { t: "helix", action: { kind: "set_title", params: { title: "New title" } }, roundId: "r1", executionId: "e1", purpose: "execute" };
const awaitConfirm: Command = { t: "await_confirm", roundId: "r1", executionId: "e1", purpose: "execute", expect: expected, timeoutMs: 1500 };
const executors: Executor[] = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup() {
  const events: CoreEvent[] = [];
  const errors: string[] = [];
  const provider: ActionProvider = {
    snapshot: vi.fn(async () => ({ broadcasterId: "100", title: "Old", categoryId: "200", capturedAt: Date.now() })),
    execute: vi.fn(async () => ({ expect: expected })),
    verify: vi.fn(async () => undefined), refund: vi.fn(async () => {}),
  };
  const executor = new Executor(provider, async (event) => { events.push(event); }, (message) => { errors.push(message); });
  executors.push(executor);
  return { executor, provider, events, errors };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(10_000); });
afterEach(() => { for (const executor of executors) executor.stop(); executors.length = 0; vi.useRealTimers(); });

describe("executor confirmation boundaries", () => {
  it("ignores matching buffered provider events that occurred before this write started", async () => {
    const { executor, events } = setup();
    await executor.observe(observation, 9_000);
    await executor.run(execute);
    await executor.run(awaitConfirm);
    expect(events.filter((event) => event.t === "execution_confirmed")).toHaveLength(0);
    await executor.observe({ ...observation, providerEventId: "new-event" }, 10_001);
    expect(events.filter((event) => event.t === "execution_confirmed")).toHaveLength(1);
  });
  it("retains an event arriving during the write, before its response", async () => {
    const { executor, provider, events } = setup();
    const pending = deferred<{ expect: typeof expected }>();
    vi.mocked(provider.execute).mockReturnValue(pending.promise);
    const running = executor.run(execute);
    await executor.observe(observation, 10_001);
    pending.resolve({ expect: expected });
    await running;
    await executor.run(awaitConfirm);
    expect(events.map((event) => event.t)).toEqual(["execution_accepted", "execution_confirmed"]);
  });
  it("does not let a delayed pre-write notification confirm an existing waiter", async () => {
    const { executor, events } = setup();
    await executor.run(execute);
    await executor.run(awaitConfirm);
    await executor.observe(observation, 9_000);
    expect(events.filter((event) => event.t === "execution_confirmed")).toHaveLength(0);
  });
  it("deduplicates writes and confirmation dispatch while retaining purpose", async () => {
    const { executor, provider, events } = setup();
    await executor.run(execute);
    await executor.run(execute);
    await executor.run(awaitConfirm);
    await executor.run(awaitConfirm);
    await executor.observe(observation, 10_001);
    await executor.observe(observation, 10_001);
    expect(provider.execute).toHaveBeenCalledTimes(1);
    expect(events.filter((event) => event.t === "execution_confirmed")).toEqual([expect.objectContaining({ executionId: "e1", purpose: "execute", roundId: "r1" })]);
  });
  it("requires broadcaster, resource, id and values and allows exact read recovery", async () => {
    const { executor, events } = setup();
    const expectation = { ...expected, resourceId: "specific" };
    await executor.run(execute);
    await executor.run({ ...awaitConfirm, expect: expectation });
    for (const confirmation of [
      { ...observation, resourceId: "wrong" },
      { ...observation, resourceId: "specific", broadcasterId: "other" },
      { ...observation, resourceId: "specific", observed: { title: "wrong" } },
      { ...observation, resourceId: "specific", via: "helix_response" as const },
    ]) await executor.observe(confirmation, 10_001);
    expect(events.filter((event) => event.t === "execution_confirmed")).toHaveLength(0);
    await executor.observe({ ...observation, resourceId: "specific", via: "helix_read" }, 10_001);
    expect(events.filter((event) => event.t === "execution_confirmed")).toHaveLength(1);
  });
  it("keeps rollback timing and confirmation independent of the original execution", async () => {
    const { executor, events } = setup();
    await executor.run(execute);
    await executor.run(awaitConfirm);
    const rollbackExpected = { ...expected, expected: { title: "Old" } };
    await executor.run({ ...execute, executionId: "e1:revert", purpose: "revert", action: { kind: "set_title", params: { title: "Old" } } });
    await executor.run({ ...awaitConfirm, executionId: "e1:revert", purpose: "revert", expect: rollbackExpected });
    executor.cancelExcept(["e1:revert"]);
    await executor.observe(observation, 10_001);
    expect(events.filter((event) => event.t === "execution_confirmed")).toHaveLength(0);
    await executor.observe({ ...observation, observed: { title: "Old" } }, 10_002);
    expect(events.filter((event) => event.t === "execution_confirmed")).toEqual([expect.objectContaining({ executionId: "e1:revert", purpose: "revert" })]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(events.filter((event) => event.t === "confirmation_timed_out")).toHaveLength(0);
  });
});

describe("executor failures and timeouts", () => {
  it.each([
    { error: new TypeError("Connection reset"), mayHaveApplied: true },
    { error: Object.assign(new Error("Provider unavailable"), { status: 503 }), mayHaveApplied: true },
    { error: Object.assign(new Error("Forbidden"), { status: 403 }), mayHaveApplied: false },
  ])("classifies ambiguous writes without blindly retrying ($mayHaveApplied)", async ({ error, mayHaveApplied }) => {
    const { executor, provider, events } = setup();
    vi.mocked(provider.execute).mockRejectedValue(error);
    await executor.run(execute);
    expect(events).toEqual([expect.objectContaining({ t: "execution_failed", roundId: "r1", executionId: "e1", purpose: "execute", mayHaveApplied })]);
    expect(provider.execute).toHaveBeenCalledTimes(1);
  });
  it("a snapshot read failure never claims that a channel write applied", async () => {
    const { executor, provider, events } = setup();
    vi.mocked(provider.snapshot).mockRejectedValue(new Error("Unavailable"));
    await executor.run({ t: "snapshot", roundId: "r1", executionId: "e1" });
    expect(events).toEqual([expect.objectContaining({ t: "execution_failed", mayHaveApplied: false })]);
    expect(provider.execute).not.toHaveBeenCalled();
  });
  it("fires a timeout once and ignores all later observations", async () => {
    const { executor, events } = setup();
    await executor.run(execute);
    await executor.run(awaitConfirm);
    await vi.advanceTimersByTimeAsync(5_000);
    await executor.observe(observation, 15_000);
    expect(events.filter((event) => event.t === "confirmation_timed_out")).toHaveLength(1);
    expect(events.filter((event) => event.t === "execution_confirmed")).toHaveLength(0);
  });
  it("enforces the confirmation deadline even when a verification read hangs", async () => {
    const { executor, provider, events } = setup();
    const pending = deferred<Confirmation | undefined>();
    vi.mocked(provider.verify).mockReturnValue(pending.promise);
    await executor.run(execute);
    await executor.run(awaitConfirm);
    await vi.advanceTimersByTimeAsync(2_250);
    expect(events.filter((event) => event.t === "confirmation_timed_out")).toHaveLength(1);
    pending.resolve(observation);
    await Promise.resolve(); await Promise.resolve();
    expect(events.filter((event) => event.t === "execution_confirmed")).toHaveLength(0);
  });
  it("canceling a waiter prevents a pending verification read from dispatching", async () => {
    const { executor, provider, events } = setup();
    const pending = deferred<Confirmation | undefined>();
    vi.mocked(provider.verify).mockReturnValue(pending.promise);
    await executor.run(execute);
    await executor.run(awaitConfirm);
    executor.cancelExcept([]);
    pending.resolve(observation);
    await Promise.resolve(); await Promise.resolve();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(events.filter((event) => event.t !== "execution_accepted")).toHaveLength(0);
  });
  it("reports a failed point refund instead of hiding it", async () => {
    const { executor, provider, errors } = setup();
    vi.mocked(provider.refund).mockRejectedValue(new Error("App does not own reward"));
    await executor.run({ t: "refund", roundId: "r1", losingProposalIds: ["p1"] });
    expect(errors).toEqual([expect.stringContaining("Points refund needs attention")]);
  });
});
