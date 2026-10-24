import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../../src/server/event-log.js";
import { state } from "../core/fixtures.js";

let directory = "";
let path = "";
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "directors-cut-log-test-")); path = join(directory, "events.jsonl"); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe("EventLog checkpoints", () => {
  it("returns no checkpoint for a new installation", async () => {
    expect(await new EventLog(path).recover()).toBeUndefined();
  });
  it("serializes writes and restores vote sets and eligibility sets", async () => {
    const log = new EventLog(path);
    const original = state();
    await Promise.all([
      log.append({ id: "event1" }, original),
      log.append({ id: "event2" }, { ...original, context: { ...original.context, now: 2_000 } }),
    ]);
    await log.flush();
    const recovered = await new EventLog(path).recover();
    expect(recovered?.context.now).toBe(2_000);
    expect(recovered?.context.allowedActions).toBeInstanceOf(Set);
    expect(recovered?.round?.votes.p1).toEqual(new Set(["a", "b"]));
    expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(2);
  });
  it("snapshots state at append time rather than after a queued write", async () => {
    const log = new EventLog(path);
    const original = state();
    const appending = log.append({ id: "event" }, original);
    (original.round!.votes.p1 as Set<string>).add("later-voter");
    await appending;
    expect((await new EventLog(path).recover())?.round?.votes.p1?.size).toBe(2);
  });
  it("recovers from an incomplete final record across repeated restarts", async () => {
    const log = new EventLog(path);
    await log.append({ id: "complete" }, state());
    const original = await readFile(path, "utf8");
    await writeFile(path, `${original}{"version":1,"state":`, "utf8");
    const recovered = await new EventLog(path).recover();
    expect(recovered?.round?.id).toBe("r1");
    expect((await new EventLog(path).recover())?.round?.id).toBe("r1");
    const next = new EventLog(path);
    await next.append({ id: "after-recovery" }, state({ round: null }));
    expect((await new EventLog(path).recover())?.round).toBeNull();
  });
  it("accepts a complete final record without its newline", async () => {
    const log = new EventLog(path);
    await log.append({ id: "complete" }, state());
    await writeFile(path, (await readFile(path, "utf8")).trimEnd(), "utf8");
    expect((await new EventLog(path).recover())?.round?.id).toBe("r1");
    expect((await readFile(path, "utf8")).endsWith("\n")).toBe(true);
  });
  it("rejects corrupt interior records instead of resuming from an unrelated checkpoint", async () => {
    const log = new EventLog(path);
    await log.append({ id: "complete" }, state());
    const original = await readFile(path, "utf8");
    await writeFile(path, `${original}broken\n${original}`, "utf8");
    await expect(new EventLog(path).recover()).rejects.toThrow("corrupt at line 2");
  });
  it("rejects structurally invalid checkpoints even when JSON parses", async () => {
    await writeFile(path, '{"version":1,"state":{"round":null}}\n', "utf8");
    await expect(new EventLog(path).recover()).rejects.toThrow();
  });
});
