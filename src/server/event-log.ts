import { appendFile, mkdir, readFile, truncate } from "node:fs/promises";
import { dirname } from "node:path";
import type { EngineState } from "../core/types.js";

// Checkpoints and their input events are one append. Replaying never reissues writes.
export class EventLog {
  private pending: Promise<void> = Promise.resolve();
  constructor(readonly path: string) {}
  async recover(): Promise<EngineState | undefined> {
    let data: string;
    try { data = await readFile(this.path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    let last: EngineState | undefined;
    const lines = data.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i]?.trim()) continue;
      try {
        const record = JSON.parse(lines[i]!, (_key, value: unknown) => {
          if (value && typeof value === "object" && "$set" in value && Array.isArray(value.$set)) return new Set(value.$set);
          return value;
        }) as { version?: number; state?: EngineState };
        if (record.version !== 1 || !record.state || !isCheckpoint(record.state)) throw new Error("Invalid checkpoint");
        last = record.state;
      } catch (error) {
        // Only an incomplete final line can result from an interrupted append.
        if (!(error instanceof SyntaxError) || i < lines.length - 1 || data.endsWith("\n")) throw new Error(`Event log is corrupt at line ${i + 1}. Preserve it before starting a new log.`);
      }
    }
    // Repair only the interrupted final append, preserving all complete records.
    if (data && !data.endsWith("\n")) {
      const final = lines.at(-1)!;
      try { JSON.parse(final); await appendFile(this.path, "\n"); }
      catch { await truncate(this.path, Buffer.byteLength(data.slice(0, data.lastIndexOf("\n") + 1), "utf8")); }
    }
    return last;
  }
  append(event: unknown, state: EngineState): Promise<void> {
    const line = JSON.stringify({ version: 1, event, state }, (_key, value: unknown) => value instanceof Set ? { $set: [...value] } : value) + "\n";
    const next = this.pending.then(async () => { await mkdir(dirname(this.path), { recursive: true }); await appendFile(this.path, line, { encoding: "utf8", mode: 0o600 }); });
    this.pending = next;
    return next;
  }
  flush(): Promise<void> { return this.pending; }
}

function isCheckpoint(state: EngineState): boolean {
  const context = state.context;
  return Boolean(context && Number.isFinite(context.now) && context.config && Number.isFinite(context.config.quorum)
    && context.cooldowns && Number.isFinite(context.cooldowns.globalUntil) && context.allowedActions instanceof Set
    && context.resolvedCategoryIds instanceof Set && Array.isArray(context.blockedTerms) && Array.isArray(context.predictionOutcomeIds)
    && (state.round === null || (state.round && typeof state.round.id === "string" && Array.isArray(state.round.proposals)
      && state.round.votes && Object.values(state.round.votes).every(voters => voters instanceof Set))));
}
