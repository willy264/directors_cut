import { randomUUID } from "node:crypto";
import type { Action, ChannelSnapshot, Command, Confirmation, ConfirmationExpectation, CoreEvent, ValidationContext } from "../core/types.js";

export interface ActionReceipt { expect: ConfirmationExpectation; confirmation?: Confirmation }
export interface ActionProvider {
  readFacts?(): Promise<Partial<ValidationContext>>;
  snapshot(): Promise<ChannelSnapshot>;
  execute(action: Action): Promise<ActionReceipt>;
  verify(expect: ConfirmationExpectation): Promise<Confirmation | undefined>;
  refund(proposalIds: readonly string[]): Promise<void>;
}
type Waiting = Extract<Command, { t: "await_confirm" }> & { deadline: number; polling: boolean; timer: ReturnType<typeof setInterval> };
export function matches(expect: ConfirmationExpectation, confirmation: Confirmation): boolean {
  return (expect.via === confirmation.via || (expect.via === "eventsub" && confirmation.via === "helix_read"))
    && expect.resource === confirmation.resource && expect.broadcasterId === confirmation.broadcasterId
    && (expect.resourceId === undefined || expect.resourceId === confirmation.resourceId)
    && Object.entries(expect.expected).every(([key, value]) => JSON.stringify(value) === JSON.stringify(confirmation.observed[key]));
}
export class Executor {
  private waiting = new Map<string, Waiting>();
  private issued = new Set<string>();
  private startedAt = new Map<string, number>();
  private recent: { at: number; confirmation: Confirmation }[] = [];
  private stopped = false;
  constructor(private provider: ActionProvider, private dispatch: (event: CoreEvent) => Promise<void>, private onError: (message: string) => void) {}
  private event() { return { id: randomUUID(), at: Date.now() }; }
  async run(command: Command): Promise<void> {
    if (this.stopped || command.t === "render") return;
    if (command.t === "refund") { try { await this.provider.refund(command.losingProposalIds); } catch (error) { this.onError(`Points refund needs attention: ${errorMessage(error)}`); } return; }
    const key = `${command.t}:${command.executionId}`;
    if (this.issued.has(key)) return;
    this.issued.add(key);
    if (command.t === "await_confirm") {
      const resourceMinimum = command.expect.resource === "clip" ? 60000 : command.expect.resource === "channel.raid" ? 120000 : 0;
      const waiter: Waiting = { ...command, deadline: Date.now() + Math.max(command.timeoutMs, resourceMinimum), polling: false,
        timer: setInterval(() => { void this.poll(command.executionId); }, 750) };
      this.waiting.set(command.executionId, waiter);
      const buffered = this.recent.find(item => item.at >= (this.startedAt.get(command.executionId) ?? Infinity) && matches(command.expect, item.confirmation));
      if (buffered) await this.confirm(command.executionId, buffered.confirmation);
      else void this.poll(command.executionId);
      return;
    }
    try {
      if (command.t === "snapshot") {
        const snapshot = await this.provider.snapshot();
        await this.dispatch({ ...this.event(), t: "snapshot_ready", roundId: command.roundId, executionId: command.executionId, snapshot });
      } else {
        this.startedAt.set(command.executionId, Date.now());
        const receipt = await this.provider.execute(command.action);
        if (this.stopped) return;
        await this.dispatch({ ...this.event(), t: "execution_accepted", roundId: command.roundId, executionId: command.executionId, purpose: command.purpose, expect: receipt.expect });
        if (receipt.confirmation) await this.confirm(command.executionId, receipt.confirmation);
      }
    } catch (error) {
      if (this.stopped) return;
      const mayHaveApplied = command.t === "helix" && (error instanceof Error && "mayHaveApplied" in error
        ? error.mayHaveApplied === true : !(error instanceof Error) || !("status" in error) || Number(error.status) >= 500);
      await this.dispatch({ ...this.event(), t: "execution_failed", roundId: command.roundId, executionId: command.executionId,
        purpose: command.t === "helix" ? command.purpose : "execute", message: errorMessage(error), mayHaveApplied });
    }
  }
  async observe(confirmation: Confirmation, at = Date.now()): Promise<void> {
    this.recent = this.recent.filter(item => item.at > Date.now() - 120000).slice(-99);
    this.recent.push({ at, confirmation });
    for (const [id, waiter] of this.waiting) if (at >= (this.startedAt.get(id) ?? Infinity) && matches(waiter.expect, confirmation)) await this.confirm(id, confirmation);
  }
  private async confirm(id: string, confirmation: Confirmation): Promise<void> {
    const waiter = this.waiting.get(id);
    if (!waiter || Date.now() >= waiter.deadline || !matches(waiter.expect, confirmation) || this.stopped) return;
    clearInterval(waiter.timer); this.waiting.delete(id);
    await this.dispatch({ ...this.event(), t: "execution_confirmed", roundId: waiter.roundId, executionId: id, purpose: waiter.purpose, confirmation });
  }
  private async poll(id: string): Promise<void> {
    const waiter = this.waiting.get(id);
    if (!waiter || this.stopped) return;
    if (Date.now() >= waiter.deadline) {
      clearInterval(waiter.timer); this.waiting.delete(id);
      await this.dispatch({ ...this.event(), t: "confirmation_timed_out", roundId: waiter.roundId, executionId: id, purpose: waiter.purpose });
      return;
    }
    if (waiter.polling) return;
    waiter.polling = true;
    try { const confirmation = await this.provider.verify(waiter.expect); if (confirmation) await this.confirm(id, confirmation); }
    catch (error) { if (Date.now() + 1000 >= waiter.deadline) this.onError(`Verification: ${errorMessage(error)}`); }
    finally { waiter.polling = false; }
  }
  cancelExcept(executionIds: readonly string[]): void {
    for (const [id, waiter] of this.waiting) if (!executionIds.includes(id)) { clearInterval(waiter.timer); this.waiting.delete(id); }
  }
  stop(): void { this.stopped = true; this.cancelExcept([]); }
}
export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "Unexpected provider failure"; }
