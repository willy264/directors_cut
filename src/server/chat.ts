import type { Action } from "../core/types.js";

export type ChatInput = { kind: "vote"; roundId: string; proposalId: string } | { kind: "proposal"; roundId: string; action: Action };
export function parseChat(text: string): ChatInput | null {
  const vote = /^!vote\s+(\S+)\s+(\S+)\s*$/i.exec(text);
  if (vote) return { kind: "vote", roundId: vote[1]!, proposalId: vote[2]! };
  const proposal = /^!propose\s+(\S+)\s+(\w+)(?:\s+([\s\S]*))?$/i.exec(text);
  if (!proposal) return null;
  return { kind: "proposal", roundId: proposal[1]!, action: parseAction(proposal[2]!.toLowerCase(), (proposal[3] || "").trim()) };
}
export function parseAction(alias: string, input: string): Action {
  const parts = input.split("|").map(x => x.trim());
  switch (alias) {
    case "title": return { kind: "set_title", params: { title: input } };
    case "category": return { kind: "set_category", params: { categoryId: input } };
    case "poll": return { kind: "create_poll", params: { title: parts[0] || "", choices: parts.slice(1), durationSeconds: 60 } };
    case "prediction": return { kind: "create_prediction", params: { title: parts[0] || "", outcomes: parts.slice(1), predictionWindowSeconds: 60 } };
    case "clip": return { kind: "create_clip", params: {} };
    case "marker": return { kind: "create_marker", params: { description: input } };
    case "shoutout": return { kind: "shoutout", params: { toBroadcasterId: input } };
    case "snooze": return { kind: "snooze_ad", params: {} };
    case "raid": return { kind: "raid", params: { toBroadcasterId: input } };
    case "resolve": { const [predictionId = "", winningOutcomeId = ""] = input.split(/\s+/); return { kind: "resolve_prediction", params: { predictionId, winningOutcomeId } }; }
    default: throw new Error("Unknown action. Use title, category, poll, prediction, clip, marker, shoutout, snooze, raid or resolve.");
  }
}
