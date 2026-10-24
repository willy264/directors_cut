import { describe, expect, it } from "vitest";
import { tally } from "../../src/core/tally.js";
import { proposal, round } from "./fixtures.js";

describe("tally", () => {
  it("requires each round's captured quorum of distinct voters", () => {
    expect(tally(round({ quorum: 3 }))).toBeNull();
    expect(tally(round())?.id).toBe("p1");
    expect(tally(round({ votes: { p1: new Set(["a", "a"]) } }))).toBeNull();
  });
  it("prefers voter count over time", () => {
    const input = round({ proposals: [proposal("p1"), proposal("p2", undefined, 1_020)], votes: { p1: new Set(["a", "b"]), p2: new Set(["a", "b", "c"]) } });
    expect(tally(input)?.id).toBe("p2");
  });
  it("breaks ties by earliest time then fixed lexical id independent of input order", () => {
    const candidates = [proposal("z", undefined, 1_030), proposal("a", undefined, 1_020), proposal("B", undefined, 1_020)];
    const votes = Object.fromEntries(candidates.map((p) => [p.id, new Set(["a", "b"])]));
    expect(tally(round({ proposals: candidates, votes }))?.id).toBe("B");
    expect(tally(round({ proposals: [...candidates].reverse(), votes }))?.id).toBe("B");
    expect(candidates.map((p) => p.id)).toEqual(["z", "a", "B"]);
  });
  it("ignores proposals from another round", () => {
    expect(tally(round({ proposals: [{ ...proposal(), roundId: "wrong" }] }))).toBeNull();
  });
});
