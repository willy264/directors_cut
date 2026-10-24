import { randomUUID } from "node:crypto";
import type { Action, ChannelSnapshot, Confirmation, ConfirmationExpectation, ValidationContext } from "../core/types.js";
import type { ActionProvider, ActionReceipt } from "./executor.js";

/** A deliberately labeled simulation, using the same engine and verification flow. */
export class DemoProvider implements ActionProvider {
  channel: ChannelSnapshot = { broadcasterId: "100", title: "Tonight, chat takes the director's chair", categoryId: "509658", capturedAt: Date.now() };
  private results = new Map<string, { readyAt: number; confirmation: Confirmation }>();
  private pollUntil = 0;
  private prediction = false;
  private snoozes = 3;
  async readFacts(): Promise<Partial<ValidationContext>> {
    return { channel: await this.snapshot(), activePollId: this.pollUntil > Date.now() ? "301" : null,
      activePredictionId: this.prediction ? "101" : null, predictionOutcomeIds: this.prediction ? ["201", "202"] : [], adSnoozesRemaining: this.snoozes };
  }
  async snapshot(): Promise<ChannelSnapshot> { return { ...this.channel, capturedAt: Date.now() }; }
  async execute(action: Action): Promise<ActionReceipt> {
    const id = randomUUID();
    let resource: string = action.kind;
    let observed: Confirmation["observed"] = {};
    switch (action.kind) {
      case "set_title": this.channel = { ...this.channel, title: action.params.title }; resource = "channel.update"; observed = { title: action.params.title }; break;
      case "set_category": this.channel = { ...this.channel, categoryId: action.params.categoryId }; resource = "channel.update"; observed = { categoryId: action.params.categoryId }; break;
      case "create_poll": this.pollUntil = Date.now() + action.params.durationSeconds * 1000; resource = "channel.poll.begin"; observed = { title: action.params.title }; break;
      case "create_prediction": this.prediction = true; resource = "channel.prediction.begin"; observed = { title: action.params.title }; break;
      case "create_clip": resource = "clip"; observed = { url: `/demo/clips/${id}` }; break;
      case "create_marker": resource = "stream.marker"; observed = { description: action.params.description, positionSeconds: 123 }; break;
      case "snooze_ad": this.snoozes--; resource = "ad.snooze"; observed = { snoozesRemaining: this.snoozes, nextAdAt: Date.now() + 300000 }; break;
      case "shoutout": resource = "channel.shoutout.create"; observed = { toBroadcasterId: action.params.toBroadcasterId }; break;
      case "raid": resource = "channel.raid"; observed = { toBroadcasterId: action.params.toBroadcasterId }; break;
      case "resolve_prediction": this.prediction = false; resource = "channel.prediction.end"; observed = { status: "resolved", winningOutcomeId: action.params.winningOutcomeId }; break;
    }
    const expect: ConfirmationExpectation = { via: "helix_read", resource, broadcasterId: this.channel.broadcasterId, resourceId: id, expected: resource === "clip" ? {} : observed };
    const confirmation: Confirmation = { ...expect, observed };
    this.results.set(id, { readyAt: Date.now() + 900, confirmation });
    return { expect };
  }
  async verify(expect: ConfirmationExpectation): Promise<Confirmation | undefined> {
    const result = this.results.get(expect.resourceId || "");
    return result && Date.now() >= result.readyAt ? result.confirmation : undefined;
  }
  async refund(): Promise<void> { /* Demo redemptions never spend Twitch points. */ }
}
