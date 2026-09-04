export type AgentSession = {
  source: string;
  agent: string;
  kind: string;
  value: string;
};

export type WorkerIdentity = {
  paneId: string;
  terminalId: string;
  agentSession: AgentSession;
};

export type GoalContract = {
  schema: "herdr.goal/v1";
  objective: string;
  context: string[];
  acceptance: string[];
  constraints: string[];
};

export type InstalledGoal = {
  goalId: string;
  contract: GoalContract;
};

export type GoalLoadError = {
  goalId: string;
  error: unknown;
};

export type ReviewDecision = "leave" | "steer" | "ask_human" | "accept";
export type RecordedDecision = ReviewDecision | "stop";

export type GoalWait = {
  condition: string;
  reviewAt: string;
  goalId?: string;
};

export type LastDecision = {
  decision: RecordedDecision;
  at: string;
  action: string;
};

export type PendingSteer = {
  action: string;
  delivery: "pending" | "confirmed" | "uncertain";
  stateChangeSeq: number;
};

export type ObservationCursor = {
  kind: string;
  [field: string]: unknown;
};

/** Durable goal data loaded from goal.json and current.json. */
export type GoalBinding = WorkerIdentity & {
  goalId: string;
  goal: string;
  context: string[];
  acceptance: string[];
  constraints: string[];
  evidence: string[];
  progress?: string;
  reviewAt?: string;
  lastDecision?: LastDecision;
  pendingSteer?: PendingSteer;
  wait?: GoalWait;
  observationCursor?: ObservationCursor;
  updatedAt: string;
};

/** Process-local scheduling state. It is disposable and never written to goal.json. */
export type GoalRuntime = {
  nextReviewAt?: string;
  lastNoticeKey?: string;
  lastReviewStateChangeSeq?: number;
  awaitingHuman: boolean;
  missingDecisionRetries: number;
  pendingCursor?: ObservationCursor;
  pendingObservationHasMessages?: boolean;
};

export type ActiveGoal = GoalBinding & GoalRuntime;

export type ReviewSignal = {
  force: boolean;
  reason: string;
  key: string;
  deadline?: boolean;
};
