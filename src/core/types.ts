/** All timestamps are epoch milliseconds supplied by the caller. */
export type Timestamp = number;
export type RoundId = string;
export type ProposalId = string;
export type UserId = string;
export type ExecutionId = string;
export type ExecutionPurpose = "execute" | "revert";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** Domain parameters; the effects adapter maps camelCase to Helix fields. */
export interface ActionParams {
  set_title: { readonly title: string };
  set_category: { readonly categoryId: string };
  create_poll: {
    readonly title: string;
    readonly choices: readonly string[];
    readonly durationSeconds: number;
  };
  create_prediction: {
    readonly title: string;
    readonly outcomes: readonly string[];
    readonly predictionWindowSeconds: number;
  };
  create_clip: { readonly hasDelay?: boolean };
  create_marker: { readonly description: string };
  shoutout: { readonly toBroadcasterId: string };
  snooze_ad: Readonly<Record<string, never>>;
  resolve_prediction: {
    readonly predictionId: string;
    readonly winningOutcomeId: string;
  };
  raid: { readonly toBroadcasterId: string };
}

export type ActionKind = keyof ActionParams;

export type Action = {
  [K in ActionKind]: { readonly kind: K; readonly params: ActionParams[K] };
}[ActionKind];

/** Only these actions have a channel-state snapshot that can be restored. */
export type ReversibleAction = Extract<Action, { kind: "set_title" | "set_category" }>;
export type GatedActionKind = "resolve_prediction" | "raid";

export interface Actor {
  readonly userId: UserId;
  readonly userName: string;
}

export interface Proposal {
  readonly id: ProposalId;
  readonly roundId: RoundId;
  readonly action: Action;
  readonly proposedBy: Actor;
  readonly at: Timestamp;
  readonly redemption?: {
    readonly rewardId: string;
    readonly redemptionId: string;
  };
}

export type RoundState =
  | "collecting"
  | "resolving"
  | "executing"
  | "confirmed"
  | "failed"
  | "vetoed";

export interface ChannelSnapshot {
  readonly broadcasterId: string;
  readonly title: string;
  readonly categoryId: string;
  readonly capturedAt: Timestamp;
}

/** Expected fields/resource IDs must match; a topic alone is insufficient. */
export interface ConfirmationExpectation {
  readonly via: "eventsub" | "helix_read" | "helix_response";
  readonly resource: string;
  readonly broadcasterId: string;
  readonly resourceId?: string;
  readonly expected: Readonly<Record<string, JsonValue>>;
}

export interface Confirmation {
  readonly via: ConfirmationExpectation["via"];
  readonly resource: string;
  readonly broadcasterId: string;
  readonly resourceId?: string;
  readonly providerEventId?: string;
  readonly observed: Readonly<Record<string, JsonValue>>;
}

export interface Execution {
  readonly id: ExecutionId;
  readonly purpose: ExecutionPurpose;
  readonly startedAt: Timestamp;
  readonly phase:
    | "snapshot_pending"
    | "request_pending"
    | "awaiting_confirmation"
    | "confirmed"
    | "failed"
    | "reverting"
    | "reverted";
  readonly expect?: ConfirmationExpectation;
}

export interface Round {
  readonly id: RoundId;
  readonly state: RoundState;
  readonly opensAt: Timestamp;
  readonly closesAt: Timestamp;
  /** Capture config.quorum when opening a round; tally needs no global config. */
  readonly quorum: number;
  readonly proposals: readonly Proposal[];
  /** Copy sets before updates; serialize them as arrays in JSONL/SSE adapters. */
  readonly votes: Readonly<Record<ProposalId, ReadonlySet<UserId>>>;
  readonly winner?: Proposal;
  readonly snapshot?: ChannelSnapshot;
  readonly revert?: ReversibleAction;
  readonly execution?: Execution;
}

export interface EngineConfig {
  readonly roundWindowMs: number;
  readonly quorum: number;
  readonly cooldownMs: number;
  readonly confirmTimeoutMs: number;
  readonly minRateLimitRemaining: number;
  readonly actionCooldownMs: Readonly<Partial<Record<ActionKind, number>>>;
  readonly shoutoutTargetCooldownMs: number;
}

export interface Cooldowns {
  readonly globalUntil: Timestamp;
  readonly byActionUntil: Readonly<Partial<Record<ActionKind, Timestamp>>>;
  readonly shoutoutTargetUntil: Readonly<Record<string, Timestamp>>;
}

/** Created only by the authenticated control adapter, never by chat/AI input. */
export interface StreamerApproval {
  readonly roundId: RoundId;
  readonly proposalId: ProposalId;
  readonly actionKind: GatedActionKind;
  readonly approvedBy: UserId;
  readonly approvedAt: Timestamp;
}

export interface ValidationContext {
  readonly now: Timestamp;
  readonly config: EngineConfig;
  readonly broadcasterId: string;
  readonly isLive: boolean;
  /** Intersection of implemented actions, granted scopes and account eligibility. */
  readonly allowedActions: ReadonlySet<ActionKind>;
  readonly resolvedCategoryIds: ReadonlySet<string>;
  readonly blockedTerms: readonly string[];
  /** Optional external moderation verdicts keyed by exact submitted text. */
  readonly textVerdicts: Readonly<Record<string, "allowed" | "blocked" | "pending">>;
  readonly cooldowns: Cooldowns;
  readonly rateLimit: { readonly remaining: number; readonly resetsAt: Timestamp };
  readonly channel: ChannelSnapshot | null;
  readonly activePollId: string | null;
  readonly activePredictionId: string | null;
  readonly predictionOutcomeIds: readonly string[];
  readonly adSnoozesRemaining: number;
  readonly roundId?: RoundId;
  readonly proposalId?: ProposalId;
  readonly approval?: StreamerApproval;
}

export type ValidationErrorCode =
  | "invalid_action"
  | "invalid_params"
  | "action_unavailable"
  | "category_not_found"
  | "text_blocked"
  | "moderation_pending"
  | "cooldown_active"
  | "rate_limit_exhausted"
  | "stream_offline"
  | "snapshot_required"
  | "streamer_confirmation_required"
  | "resource_conflict";

export interface ValidationError {
  readonly code: ValidationErrorCode;
  readonly message: string;
  readonly field?: string;
  readonly retryAt?: Timestamp;
}

export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E> = Ok<T> | Err<E>;

export interface EngineState {
  readonly round: Round | null;
  readonly context: ValidationContext;
}

/** Adapter-created IDs/time make replay deterministic; the core generates neither. */
export type CoreEvent = { readonly id: string; readonly at: Timestamp } & (
  | { readonly t: "round_opened"; readonly roundId: RoundId }
  | { readonly t: "proposal_submitted"; readonly proposal: Proposal }
  | { readonly t: "vote_cast"; readonly roundId: RoundId; readonly proposalId: ProposalId; readonly userId: UserId }
  | { readonly t: "round_closed"; readonly roundId: RoundId; readonly executionId: ExecutionId }
  | { readonly t: "snapshot_ready"; readonly roundId: RoundId; readonly executionId: ExecutionId; readonly snapshot: ChannelSnapshot }
  | { readonly t: "execution_accepted"; readonly roundId: RoundId; readonly executionId: ExecutionId; readonly purpose: ExecutionPurpose; readonly expect: ConfirmationExpectation }
  | { readonly t: "execution_confirmed"; readonly roundId: RoundId; readonly executionId: ExecutionId; readonly purpose: ExecutionPurpose; readonly confirmation: Confirmation }
  | { readonly t: "execution_failed"; readonly roundId: RoundId; readonly executionId: ExecutionId; readonly purpose: ExecutionPurpose; readonly message: string; readonly mayHaveApplied: boolean }
  | { readonly t: "confirmation_timed_out"; readonly roundId: RoundId; readonly executionId: ExecutionId; readonly purpose: ExecutionPurpose }
  | { readonly t: "veto_requested"; readonly roundId: RoundId }
  | { readonly t: "streamer_approved"; readonly approval: StreamerApproval }
  | { readonly t: "context_updated"; readonly context: ValidationContext }
);

/** Effects execute commands and return normalized CoreEvents. */
export type Command =
  | { readonly t: "snapshot"; readonly roundId: RoundId; readonly executionId: ExecutionId }
  | { readonly t: "helix"; readonly action: Action; readonly roundId: RoundId; readonly executionId: ExecutionId; readonly purpose: ExecutionPurpose }
  | { readonly t: "await_confirm"; readonly roundId: RoundId; readonly executionId: ExecutionId; readonly purpose: ExecutionPurpose; readonly expect: ConfirmationExpectation; readonly timeoutMs: number }
  | { readonly t: "refund"; readonly roundId: RoundId; readonly losingProposalIds: readonly ProposalId[] }
  | { readonly t: "render"; readonly payload: JsonValue };

export interface TransitionResult {
  readonly state: EngineState;
  readonly commands: readonly Command[];
}
