import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { HerdrClient } from "./herdr-client.ts";
import {
  loadSupervisorGoals,
  installSupervisorGoal,
  recordDecision,
  refineSupervisorGoal,
  refreshWorkerLocation,
  registerSupervisedGoal,
  startInstalledGoal,
} from "./goal-registry.ts";
import { formatObservation, observeWorker } from "./observation.ts";
import { ReviewTurnFence } from "./review-turn.ts";
import { canRecoverAgentSession, sameAgentSession } from "./identity.ts";
import {
  nativeGoalPrompt,
  refinedGoalPrompt,
  reviewMessage,
  supervisorSystemPrompt,
  workerInitializationPrompt,
} from "./prompts.ts";
import type {
  ActiveGoal,
  GoalBinding,
  GoalLoadError,
  GoalRuntime,
  InstalledGoal,
  ReviewSignal,
} from "./types.ts";
export { pullRequestTraceability } from "./prompts.ts";
import {
  buildGlobalSnapshot,
  DEFAULT_GLOBAL_REVIEW_INTERVAL_MS,
  emptyGlobalReviewState,
  globalFindingHash,
  globalFindingSummary,
  globalReviewMessage,
  loadGlobalReviewState,
  saveGlobalReviewState,
  stableHash,
} from "./global-review.ts";
import {
  captureIdentity,
  findAgent,
  findPane,
  formatWorker,
  DEFAULT_REVIEW_INTERVAL_MS,
  dependentBindings,
  dueBindings,
  identityMismatch,
  liveWorker,
  nextReviewDelay,
  recoveryRequest,
  reviewDeadline,
  shouldWake,
} from "./supervision.ts";

const Pane = Type.String({ description: "Exact Herdr pane ID, for example w1:p2" });
const EvidenceItems = Type.Array(
  Type.String({ minLength: 1, maxLength: 4000 }),
  { minItems: 1, maxItems: 8 },
);
const Optional = <T extends TSchema>(schema: T) => Type.Optional(Type.Union([schema, Type.Null()]));
const Evidence = Optional(EvidenceItems);
const client = new HerdrClient();
const supervisorTools = [
  "supervisor_start_goal",
  "supervisor_update_goal",
  "supervisor_status",
  "supervisor_reconsider",
  "supervisor_global_result",
  "supervisor_observe",
  "supervisor_leave",
  "supervisor_steer",
  "supervisor_ask_human",
  "supervisor_finish",
];
const reviewMessageType = "herdr-supervisor-review";
const globalReviewMessageType = "herdr-supervisor-global-review";
const humanFollowUpMessageType = "herdr-supervisor-human-follow-up";
const WORKER_EVENT_SETTLE_MS = 250;
type SupervisorMode = "observe" | "dry-run" | "live";

function text(value: string, isError = false) {
  return { content: [{ type: "text" as const, text: value }], isError, details: undefined };
}

function markRecoveryPreflightError(error) {
  if (error && typeof error === "object") {
    (error as { recoveryPreflight?: boolean }).recoveryPreflight = true;
  }
  return error;
}

function isRecoveryPreflightError(error): error is Error & { recoveryPreflight: true } {
  return Boolean(error && typeof error === "object" && "recoveryPreflight" in error && error.recoveryPreflight);
}

function codexLaunchArgs(cwd?: string) {
  const args: string[] = [];
  if (process.env.HERDR_SUPERVISOR_CODEX_FULL_ACCESS === "1") {
    args.push(
      "--dangerously-bypass-approvals-and-sandbox",
      "--dangerously-bypass-hook-trust",
    );
    if (cwd) {
      args.push("-c", `projects={${JSON.stringify(resolve(cwd))}={trust_level="trusted"}}`);
    }
  }
  return args;
}

function workerNameForGoal(goalId: string) {
  const suffix = createHash("sha256").update(goalId).digest("hex").slice(0, 27);
  return `goal-${suffix}`;
}

function legacyWorkerNameForGoal(goalId: string) {
  const suffix = goalId.slice(2).replaceAll("-", "").toLowerCase();
  return `goal-${suffix.slice(0, 27)}`;
}

function exactSessionAgent(snapshot, session) {
  const matches = snapshot.agents?.filter((agent) => (
    sameAgentSession(agent.agent_session, session)
  )) || [];
  if (matches.length > 1) {
    throw new Error(`multiple Herdr agents expose the same ${session.agent} session`);
  }
  return matches[0];
}

type SupervisorServices = {
  loadGoals?: typeof loadSupervisorGoals;
  workerEventSettleMs?: number;
};

export default function herdrSupervisor(pi: ExtensionAPI, services: SupervisorServices = {}) {
  const readGoals = services.loadGoals || loadSupervisorGoals;
  let stopSubscription: undefined | (() => void);
  let reconnectTimer: undefined | ReturnType<typeof setTimeout>;
  let reviewTimer: undefined | ReturnType<typeof setTimeout>;
  let globalReviewTimer: undefined | ReturnType<typeof setTimeout>;
  const workerEventTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const pendingSignals = new Map<string, ReviewSignal | undefined>();
  const pendingStarts = new Map<string, string>();
  const runtimeGoals = new Map<string, GoalRuntime>();
  let activeGlobalReview = false;
  let globalDecisionApplied = false;
  let pendingGlobalReview: string | undefined;
  let globalMissingDecisionRetries = 0;
  let globalState = emptyGlobalReviewState();
  let reviewPumpRunning = false;
  let agentTurnActive = false;
  let shuttingDown = false;
  let lastBackgroundError = "";
  let reconnectDelay = 250;
  let observerInterrupted = false;
  let workerEventSequence = 0;
  const pendingHumanFollowUps = new Set<string>();
  const reviewTurn = new ReviewTurnFence();
  let goalCache: undefined | {
    active: Map<string, GoalBinding>;
    unstarted: InstalledGoal[];
    errors: GoalLoadError[];
  };

  function runtimeFor(binding: GoalBinding): GoalRuntime {
    let runtime = runtimeGoals.get(binding.goalId);
    if (!runtime) {
      runtime = {
        nextReviewAt: binding.wait?.reviewAt || binding.reviewAt,
        lastReviewStateChangeSeq: 0,
        awaitingHuman: binding.lastDecision?.decision === "ask_human",
        missingDecisionRetries: 0,
      };
      runtimeGoals.set(binding.goalId, runtime);
    }
    return runtime;
  }

  async function reloadGoals() {
    const goals = await readGoals();
    goalCache = {
      active: new Map(goals.active.map((binding) => [binding.goalId, binding])),
      unstarted: goals.unstarted,
      errors: goals.errors,
    };
    const activeIds = new Set(goals.active.map((binding) => binding.goalId));
    for (const goalId of runtimeGoals.keys()) {
      if (!activeIds.has(goalId)) runtimeGoals.delete(goalId);
    }
    return goals;
  }

  async function activeBindings() {
    if (!goalCache) await reloadGoals();
    return {
      active: [...goalCache!.active.values()].map((binding): ActiveGoal => ({ ...binding, ...runtimeFor(binding) })),
      unstarted: goalCache!.unstarted,
      errors: goalCache!.errors,
    };
  }

  async function bindingForPane(paneId: string) {
    const goals = await activeBindings();
    return goals.active.find((binding) => binding.paneId === paneId);
  }

  async function refreshStatus(ctx) {
    const goals = await activeBindings();
    ctx.ui.setStatus("herdr-supervisor", goals.active.length ? `supervising ${goals.active.length}` : undefined);
  }

  async function deliverNativeGoal(binding) {
    const snapshot = await client.snapshot();
    const agent = findAgent(snapshot, binding.paneId);
    const mismatch = identityMismatch(
      binding,
      agent,
      findPane(snapshot, binding.paneId),
    );
    if (mismatch) throw new Error(`refusing stale native Goal delivery: ${mismatch}`);
    if (typeof agent.name !== "string" || !agent.name.trim()) {
      throw new Error("refusing native Goal delivery because the Herdr worker has no stable name");
    }
    await client.promptAgent(binding.paneId, nativeGoalPrompt(binding, agent.name));
  }

  function reviewCandidates(goals: ActiveGoal[]) {
    return goals.filter(
      (goal) => !pendingSignals.has(goal.paneId) && !reviewTurn.isBusy(goal.paneId),
    );
  }

  function scheduleReview(binding, delay = reviewIntervalMs()) {
    const runtime = runtimeFor(binding);
    runtime.awaitingHuman = false;
    runtime.nextReviewAt = new Date(Date.now() + delay).toISOString();
  }

  function cacheBinding(binding) {
    goalCache?.active.set(binding.goalId, binding);
  }

  function cacheCheckpoint(binding, state) {
    if (state.terminal) {
      goalCache?.active.delete(binding.goalId);
      runtimeGoals.delete(binding.goalId);
      return;
    }
    cacheBinding({
      ...binding,
      updatedAt: state.updatedAt,
      evidence: [...state.evidence],
      progress: state.progress,
      reviewAt: state.reviewAt,
      lastDecision: state.lastDecision,
      wait: state.wait ? structuredClone(state.wait) : undefined,
      observationCursor: state.observationCursor,
    });
  }

  async function deliverWorkerInstruction(binding, instruction) {
    let deliveryError;
    try {
      await client.promptAgent(binding.paneId, instruction);
    } catch (error) {
      deliveryError = error;
    }
    reviewTurn.close(binding.paneId);
    return { deliveryError };
  }

  async function saveSteerCheckpoint(
    binding,
    instruction,
    progress,
    evidence,
    reviewAt,
  ) {
    const result = await recordDecision(binding, "steer", {
      progress,
      action: instruction,
      evidence,
      observationCursor: runtimeFor(binding).pendingCursor,
      reviewAt,
    });
    cacheCheckpoint(binding, result.state);
    runtimeFor(binding).pendingCursor = undefined;
    return result.auditError ? `\nAudit warning: ${result.auditError.message}` : "";
  }

  async function saveUncertainSteer(
    binding,
    instruction,
    progress,
    evidence,
    reviewAt,
  ) {
    try {
      const warning = await saveSteerCheckpoint(
        binding,
        instruction,
        progress,
        evidence,
        reviewAt,
      );
      return { saved: true, warning };
    } catch (error) {
      return {
        saved: false,
        warning: `\nCheckpoint warning: ${error.message}.${await reconcileCacheAfterWriteFailure()}`,
      };
    }
  }

  async function refreshObservedLocation(binding, agent) {
    if (
      !agent
      || identityMismatch(binding, agent, agent)
      || (agent.pane_id === binding.paneId && agent.terminal_id === binding.terminalId)
    ) {
      return binding;
    }
    const refreshed = await refreshWorkerLocation(binding, captureIdentity(agent));
    return rememberWorkerLocation(binding, refreshed);
  }

  async function rememberWorkerLocation(previous, refreshed) {
    cacheBinding(refreshed);
    if (previous.paneId !== refreshed.paneId) {
      try { await reloadGoals(); }
      catch (error) {
        goalCache = undefined;
        reportBackgroundFailure("Could not refresh relocated worker cache", error);
      }
    }
    const current = goalCache?.active.get(refreshed.goalId) || refreshed;
    return { ...current, ...runtimeFor(current) };
  }

  async function adoptExactSession(binding, snapshot) {
    const agent = exactSessionAgent(snapshot, binding.agentSession);
    if (!agent) return;
    return refreshObservedLocation(binding, agent);
  }

  function reusableRecoveryPane(snapshot, workspaceId, goalId) {
    const tabs = snapshot.tabs?.filter((tab) => (
      tab.workspace_id === workspaceId && tab.label === workerNameForGoal(goalId)
    )) || [];
    if (!tabs.length) return;
    if (tabs.length > 1) throw new Error(`multiple recovery tabs exist for goal ${goalId}`);
    const panes = snapshot.panes?.filter((pane) => pane.tab_id === tabs[0].tab_id) || [];
    if (panes.length !== 1) throw new Error(`recovery tab for goal ${goalId} does not contain one pane`);
    if (findAgent(snapshot, panes[0].pane_id)) {
      throw new Error(`recovery tab for goal ${goalId} contains a different agent session`);
    }
    return panes[0];
  }

  async function recoverWorkerRouting(binding, snapshot) {
    let recoveryMayHaveMutated = false;
    const session = binding.agentSession;
    try {
      if (!canRecoverAgentSession(session)) {
        throw new Error(`exact recovery is not available for ${session.agent} ${session.kind} sessions`);
      }
      const existingBinding = await adoptExactSession(binding, snapshot);
      if (existingBinding) return existingBinding;
      const currentPane = findPane(snapshot, binding.paneId);
      if (currentPane) {
        recoveryMayHaveMutated = true;
        const refreshed = await refreshWorkerLocation(binding, {
          paneId: currentPane.pane_id,
          terminalId: currentPane.terminal_id,
          agentSession: session,
        });
        cacheBinding(refreshed);
        return refreshed;
      }
      const supervisorPaneId = process.env.HERDR_PANE_ID;
      const supervisorPane = supervisorPaneId ? findPane(snapshot, supervisorPaneId) : undefined;
      if (!supervisorPane?.workspace_id) {
        throw new Error("the supervisor's Herdr workspace is not available for worker recovery");
      }
      let pane = reusableRecoveryPane(snapshot, supervisorPane.workspace_id, binding.goalId);
      if (!pane) {
        recoveryMayHaveMutated = true;
        const created = await client.createTab({
          workspaceId: supervisorPane.workspace_id,
          cwd: process.env.HERDR_SUPERVISOR_DIRECTORY || "/app",
          label: workerNameForGoal(binding.goalId),
          focus: false,
        });
        const paneId = created?.root_pane?.pane_id;
        if (!paneId) throw new Error("Herdr created recovery space but did not return its pane identity");
        const freshSnapshot = await client.snapshot();
        const restoredBinding = await adoptExactSession(binding, freshSnapshot);
        if (restoredBinding) return restoredBinding;
        pane = findPane(freshSnapshot, paneId);
      }
      if (!pane?.terminal_id) throw new Error(`Herdr did not expose the recovery pane for goal ${binding.goalId}`);
      recoveryMayHaveMutated = true;
      const relocated = await refreshWorkerLocation(binding, {
        paneId: pane.pane_id,
        terminalId: pane.terminal_id,
        agentSession: session,
      });
      return rememberWorkerLocation(binding, relocated);
    } catch (error) {
      if (!recoveryMayHaveMutated) throw markRecoveryPreflightError(error);
      throw error;
    }
  }

  async function reconcileCacheAfterWriteFailure() {
    try {
      await reloadGoals();
      return "";
    } catch (error) {
      goalCache = undefined;
      return ` Supervisor state also could not be reloaded: ${error.message}`;
    }
  }

  function reportBackgroundFailure(label: string, error) {
    const message = `${label}: ${error.message}`;
    if (message === lastBackgroundError || shuttingDown) return;
    lastBackgroundError = message;
    try {
      pi.sendMessage({
        customType: "herdr-supervisor-error",
        content: message,
        display: true,
      }, { triggerTurn: false, deliverAs: "followUp" });
    } catch {
      // A failed diagnostic must not become another background failure.
    }
  }

  pi.registerFlag("supervisor-mode", {
    description: "Supervision authority: observe, dry-run, or live",
    type: "string",
    default: process.env.HERDR_SUPERVISOR_MODE || "observe",
  });

  pi.registerFlag("supervisor-review-ms", {
    description: "Time without a supervision review before a stale-progress check",
    type: "string",
    default: process.env.HERDR_SUPERVISOR_REVIEW_MS || String(DEFAULT_REVIEW_INTERVAL_MS),
  });

  pi.registerFlag("supervisor-global-review-ms", {
    description: "Low-frequency interval for compact reviews across all supervised goals",
    type: "string",
    default: process.env.HERDR_SUPERVISOR_GLOBAL_REVIEW_MS || String(DEFAULT_GLOBAL_REVIEW_INTERVAL_MS),
  });

  function mode(): SupervisorMode {
    const value = pi.getFlag("supervisor-mode");
    return value === "live" || value === "dry-run" ? value : "observe";
  }

  function reviewIntervalMs() {
    const value = Number(pi.getFlag("supervisor-review-ms"));
    return Number.isFinite(value) && value >= 1000 ? value : DEFAULT_REVIEW_INTERVAL_MS;
  }

  function globalReviewIntervalMs() {
    const value = Number(pi.getFlag("supervisor-global-review-ms"));
    if (value === 0) return undefined;
    return Number.isFinite(value) && value >= 1000 ? value : DEFAULT_GLOBAL_REVIEW_INTERVAL_MS;
  }

  function scheduleGlobalReview(reason: string) {
    pendingGlobalReview ||= reason;
    void drainSignals().catch((error) => reportBackgroundFailure("Could not process the global supervision review", error));
  }

  function armGlobalReviewTimer() {
    if (globalReviewTimer) clearTimeout(globalReviewTimer);
    globalReviewTimer = undefined;
    const interval = globalReviewIntervalMs();
    if (shuttingDown || pendingGlobalReview || activeGlobalReview || interval === undefined) return;
    const due = Date.parse(globalState.nextReviewAt || "");
    const delay = Number.isFinite(due) ? Math.max(0, due - Date.now()) : 0;
    globalReviewTimer = setTimeout(() => {
      globalReviewTimer = undefined;
      scheduleGlobalReview("the low-frequency global review is due");
    }, Math.min(delay, 2_147_483_647));
    globalReviewTimer.unref?.();
  }

  async function armReviewTimer() {
    if (reviewTimer) clearTimeout(reviewTimer);
    reviewTimer = undefined;
    if (shuttingDown) return;
    const goals = await activeBindings();
    const waiting = reviewCandidates(goals.active);
    const reviewDelay = nextReviewDelay(waiting);
    if (reviewDelay === undefined) return;
    reviewTimer = setTimeout(() => {
      reviewTimer = undefined;
      void runScheduledObservations().catch((error) => reportBackgroundFailure("Could not run the scheduled worker review", error));
    }, Math.min(reviewDelay, 2_147_483_647));
    reviewTimer.unref?.();
  }

  async function runScheduledObservations() {
    try {
      await reviewDueWorkers();
    } finally {
      await armReviewTimer();
    }
  }

  async function reviewDueWorkers() {
    const goals = await activeBindings();
    const due = dueBindings(reviewCandidates(goals.active));
    for (const binding of due) scheduleReview(binding);
    try {
      for (const binding of due) {
        handleSignal(binding.paneId, {
          force: true,
          reason: "review deadline elapsed",
          key: `deadline:${binding.nextReviewAt || "recovery"}`,
          deadline: true,
        });
      }
    } finally {
      await armReviewTimer();
    }
  }

  async function status(paneId?: string) {
    const [goals, snapshot] = await Promise.all([activeBindings(), client.snapshot()]);
    const bindings = paneId ? goals.active.filter((worker) => worker.paneId === paneId) : goals.active;
    const lines = bindings.map((binding) => formatWorker(
      liveWorker(binding, snapshot),
      { detailed: Boolean(paneId) },
    ));
    if (!lines.length) lines.push(paneId ? `${paneId} is not supervised.` : "No supervised workers.");
    if (!paneId && goals.unstarted.length) {
      lines.push(`${goals.unstarted.length} portable goal contract(s) have no local worker yet.`);
    }
    if (!paneId && goals.errors.length) {
      lines.push(`Needs repair: ${goals.errors.map((record) => record.goalId).join(", ")}.`);
    }
    return lines.join("\n\n");
  }

  function handleSignal(paneId: string, signal?: ReviewSignal) {
    if (!pendingSignals.has(paneId) || signal?.force) pendingSignals.set(paneId, signal);
    void drainSignals().catch((error) => reportBackgroundFailure("Could not process a worker event", error));
  }

  function queueSignal(paneId: string, signal?: ReviewSignal) {
    if (!pendingSignals.has(paneId) || signal?.force) pendingSignals.set(paneId, signal);
  }

  async function wakeDependentWaiters(peer, reason: string) {
    const goals = await activeBindings();
    const reference = typeof peer === "string"
      ? goals.active.find((binding) => binding.paneId === peer) || { paneId: peer }
      : peer;
    for (const binding of dependentBindings(goals.active, reference)) {
      if (runtimeFor(binding).awaitingHuman) continue;
      handleSignal(binding.paneId, {
        force: true,
        reason,
        key: `peer:${reference.goalId || reference.paneId}:${++workerEventSequence}`,
      });
    }
  }

  function wakeTerminalDependents(peer, reason: string) {
    void wakeDependentWaiters(peer, reason).catch((error) => {
      reportBackgroundFailure(`Could not wake goals waiting on ${peer.goalId || peer.paneId}`, error);
    });
  }

  async function handleWorkerEvent(paneId: string) {
    const existing = workerEventTimers.get(paneId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      workerEventTimers.delete(paneId);
      handleSignal(paneId);
    }, services.workerEventSettleMs ?? WORKER_EVENT_SETTLE_MS);
    workerEventTimers.set(paneId, timer);
    timer.unref?.();
  }

  async function reconsiderCurrentBindings() {
    const [goals, snapshot] = await Promise.all([activeBindings(), client.snapshot()]);
    for (const stored of goals.active) {
      const binding = await refreshObservedLocation(stored, findAgent(snapshot, stored.paneId));
      if (runtimeFor(binding).awaitingHuman) continue;
      const decision = shouldWake(
        binding,
        findAgent(snapshot, binding.paneId),
        findPane(snapshot, binding.paneId),
      );
      if (decision.wake && runtimeFor(binding).lastNoticeKey !== decision.key) handleSignal(binding.paneId);
    }
  }

  async function drainSignals() {
    if (
      shuttingDown
      || reviewPumpRunning
      || agentTurnActive
      || pendingHumanFollowUps.size
      || reviewTurn.isActive()
      || activeGlobalReview
    ) return;
    reviewPumpRunning = true;
    try {
      while (
        !shuttingDown
        && !agentTurnActive
        && !pendingHumanFollowUps.size
        && !reviewTurn.isActive()
        && !activeGlobalReview
        && pendingSignals.size
      ) {
        const next = pendingSignals.entries().next().value as [string, ReviewSignal | undefined];
        const [paneId, signal] = next;
        pendingSignals.delete(paneId);
        reviewTurn.prepare(paneId);
        let failed = false;
        try {
          await handleSignalOnce(paneId, signal);
          lastBackgroundError = "";
        } catch (error) {
          failed = true;
          reportBackgroundFailure(`Could not review ${paneId}`, error);
          const binding = await bindingForPane(paneId).catch(() => undefined);
          if (binding) scheduleReview(binding, Math.min(reviewIntervalMs(), 5000));
        } finally {
          reviewTurn.finishPreparing();
        }
        await armReviewTimer().catch((error) => reportBackgroundFailure(
          failed ? "Could not retry the worker review" : "Could not restore the worker review timer",
          error,
        ));
      }
      if (
        !shuttingDown
        && !agentTurnActive
        && !reviewTurn.isActive()
        && !activeGlobalReview
        && !pendingSignals.size
        && pendingGlobalReview
      ) {
        const reason = pendingGlobalReview;
        pendingGlobalReview = undefined;
        await handleGlobalReview(reason);
      }
    } finally {
      reviewPumpRunning = false;
      if (!shuttingDown && !reviewTurn.isActive() && !activeGlobalReview && (pendingSignals.size || pendingGlobalReview)) {
        void drainSignals().catch((error) => reportBackgroundFailure("Could not process a worker event", error));
      }
    }
  }

  async function handleGlobalReview(reason: string) {
    const [storedGoals, snapshot] = await Promise.all([loadSupervisorGoals(), client.snapshot()]);
    if (pendingHumanFollowUps.size || agentTurnActive) {
      pendingGlobalReview ||= reason;
      return;
    }
    const bindings = storedGoals.active.map((binding): ActiveGoal => ({
      ...binding,
      ...runtimeFor(binding),
    }));
    const compactSnapshot = buildGlobalSnapshot(bindings, storedGoals.unstarted, snapshot, {
      observerConnected: Boolean(stopSubscription),
      pendingFocusedReviews: pendingSignals.size,
      activeReview: reviewTurn.isActive() ? `goal:${reviewTurn.paneId}` : "global",
      lastBackgroundError,
    });
    const snapshotHash = stableHash(compactSnapshot);
    activeGlobalReview = true;
    globalDecisionApplied = false;
    try {
      pi.sendMessage({
        customType: globalReviewMessageType,
        content: globalReviewMessage(compactSnapshot, reason, globalState.lastFinding),
        display: false,
      }, { triggerTurn: true, deliverAs: "followUp" });
      globalState.snapshotHash = snapshotHash;
    } catch (error) {
      activeGlobalReview = false;
      pendingGlobalReview ||= reason;
      throw error;
    }
    armGlobalReviewTimer();
  }

  async function handleSignalOnce(
    paneId: string,
    signal?: ReviewSignal,
  ) {
    const [goals, snapshot] = await Promise.all([activeBindings(), client.snapshot()]);
    const stored = goals.active.find((binding) => binding.paneId === paneId);
    if (!stored) return;
    const agent = findAgent(snapshot, paneId);
    const pane = findPane(snapshot, paneId);
    const binding = await refreshObservedLocation(stored, agent);
    if (runtimeFor(binding).awaitingHuman && !signal?.force) return;
    const mismatch = identityMismatch(binding, agent, pane);
    const currentDecision = shouldWake(binding, agent, pane);
    const signaledDecision = signal?.force && !mismatch
      ? {
          wake: true,
          reason: signal.reason,
          sequence: agent ? Number(agent.state_change_seq || 0) : undefined,
          key: signal.key,
        }
      : currentDecision;
    const decision = signaledDecision;
    const runtime = runtimeFor(binding);
    if (
      signal?.deadline
      && !binding.wait
      && !binding.reviewAt
      && agent?.agent_status === "working"
      && !identityMismatch(binding, agent, pane)
    ) {
      try {
        const observation = await observeWorker(binding, client);
        if (!observation.messages.length) {
          // A routine health deadline with no new evidence is not worth a
          // focused model turn. The low-frequency global review remains the
          // independent safety net for a worker that only appears healthy.
          runtime.lastReviewStateChangeSeq = Number(agent.state_change_seq || 0);
          runtime.lastNoticeKey = decision.key;
          scheduleReview(binding);
          return;
        }
      } catch {
        // If the cheap evidence check fails, review rather than hide a
        // potentially stalled worker.
      }
    }
    const waitingUntil = Date.parse(binding.wait?.reviewAt || "");
    if (
      !signal?.force
      && Number.isFinite(waitingUntil)
      && waitingUntil > Date.now()
      && (agent?.agent_status === "idle" || agent?.agent_status === "done")
      && !identityMismatch(binding, agent, pane)
      && currentDecision.wake
    ) {
      try {
        const observation = await observeWorker(binding, client);
        if (!observation.messages.length) {
          runtime.lastReviewStateChangeSeq = Number(agent.state_change_seq || 0);
          runtime.lastNoticeKey = currentDecision.key;
          return;
        }
      } catch {
        // If the cheap evidence check is unavailable, review rather than hide
        // a potentially meaningful worker transition.
      }
    }
    const missingDecisionRetry = signal?.key.startsWith("missing-decision:");
    if (!decision.wake || (runtime.lastNoticeKey === decision.key && !missingDecisionRetry)) return;
    if (pendingHumanFollowUps.size || agentTurnActive) {
      queueSignal(paneId, signal);
      return;
    }
    runtime.lastNoticeKey = decision.key;
    scheduleReview(binding);
    runtime.pendingObservationHasMessages = undefined;
    const currentMode = mode();
    if (currentMode !== "observe") {
      reviewTurn.begin(paneId, decision.reason);
    }
    try {
      pi.sendMessage(
        {
          customType: reviewMessageType,
          content: `${reviewMessage(
            binding,
            agent,
            decision.reason,
            new Date(),
            dependentBindings(goals.active, binding),
          )}\n\nSupervisor mode: ${currentMode}.`,
          display: true,
        },
        { triggerTurn: currentMode !== "observe", deliverAs: "followUp" },
      );
    } catch (error) {
      reviewTurn.end();
      throw error;
    }
    await armReviewTimer();
  }

  async function connectObserver() {
    stopSubscription?.();
    stopSubscription = undefined;
    if (shuttingDown) return;
    const goals = await activeBindings();
    if (!goals.active.length) return;
    const subscriptions = goals.active.flatMap((worker) => [
      { type: "pane.agent_status_changed", pane_id: worker.paneId },
      { type: "pane.exited", pane_id: worker.paneId },
    ]);
    stopSubscription = client.subscribe(
      subscriptions,
      (event) => {
        const paneId = event?.data?.pane_id;
        if (typeof paneId === "string") {
          void handleWorkerEvent(paneId).catch((error) => reportBackgroundFailure(
            `Could not reconsider workers waiting on ${paneId}`,
            error,
          ));
        }
      },
      () => {
        stopSubscription = undefined;
        observerInterrupted = true;
        if (shuttingDown || reconnectTimer) return;
        reconnectTimer = setTimeout(() => {
          reconnectTimer = undefined;
          void connectObserver().catch((error) => reportBackgroundFailure("Could not reconnect to Herdr", error));
        }, reconnectDelay);
        reconnectTimer.unref?.();
        reconnectDelay = Math.min(reconnectDelay * 2, 5000);
      },
      () => {
        reconnectDelay = 250;
        if (observerInterrupted) {
          observerInterrupted = false;
          scheduleGlobalReview("the Herdr event subscription recovered after an interruption");
        }
        void reconsiderCurrentBindings().catch((error) => {
          reportBackgroundFailure("Could not reconcile workers after reconnect", error);
          return armReviewTimer();
        }).catch((error) => reportBackgroundFailure("Could not restore worker review deadlines", error));
      },
    );
  }

  async function register(paneId: string, goal: string, acceptance: string[], {
    wake = true,
    context = [],
    constraints = [],
  } = {}) {
    const snapshot = await client.snapshot();
    const agent = findAgent(snapshot, paneId);
    if (!agent) throw new Error(`no observable agent in ${paneId}`);
    const binding = await registerSupervisedGoal(captureIdentity(agent), {
      objective: goal,
      acceptance,
      context,
      constraints,
    });
    cacheBinding(binding);
    scheduleReview(binding);
    let warning = "";
    try {
      await connectObserver();
      await armReviewTimer();
    } catch (error) {
      warning = ` Monitoring setup failed: ${error.message}`;
    }
    if (mode() === "live") {
      try {
        await deliverNativeGoal(binding);
      } catch (error) {
        warning += ` Native Goal delivery could not be confirmed: ${error.message}`;
      }
    }
    if (wake && shouldWake(binding, agent, findPane(snapshot, paneId)).wake) void handleSignal(binding.paneId);
    return { binding, warning };
  }

  async function startWorkerForGoal(params) {
    if (reviewTurn.isBusy()) {
      throw new Error(`Finish preparing or reviewing ${reviewTurn.paneId} before starting another goal.`);
    }
    const requestedGoalId = typeof params.goal_id === "string" ? params.goal_id.trim() : "";
    if (params.goal_id !== undefined && params.goal_id !== null && !requestedGoalId) {
      throw new Error("The saved goal_id cannot be empty.");
    }
    const hasContractInput = [params.goal, params.context, params.acceptance, params.constraints]
      .some((value) => value !== undefined && value !== null);
    if (requestedGoalId && hasContractInput) {
      throw new Error("Supply either goal_id for a saved goal or contract fields for a new goal, not both.");
    }
    if (typeof params.working_directory !== "string") {
      throw new Error("The worker working_directory is required and must be an absolute path.");
    }
    const cwd = params.working_directory.trim();
    if (!isAbsolute(cwd)) {
      throw new Error("The worker working_directory must be an absolute path.");
    }
    if (requestedGoalId) await reloadGoals();
    const goals = await activeBindings();

    let installed;
    let continuingInstalledGoal = false;
    if (requestedGoalId) {
      const existing = goals.active.find((binding) => binding.goalId === requestedGoalId);
      if (existing) return { binding: existing, existing: true, warning: "" };
      installed = goals.unstarted.find((record) => record.goalId === requestedGoalId);
      if (!installed) throw new Error(`${requestedGoalId} is not an active or unstarted goal.`);
      continuingInstalledGoal = true;
    } else {
      const objective = typeof params.goal === "string" ? params.goal.trim() : "";
      const acceptance = (params.acceptance || []).map((item) => item.trim()).filter(Boolean);
      const context = (params.context || []).map((item) => item.trim()).filter(Boolean);
      const constraints = (params.constraints || []).map((item) => item.trim()).filter(Boolean);
      if (!objective) throw new Error("The goal cannot be empty.");
      if (!acceptance.length) throw new Error("At least one concrete completion criterion is required.");
      const existing = goals.active.find((binding) => binding.goal.trim() === objective);
      if (existing) return { binding: existing, existing: true, warning: "" };
      installed = goals.unstarted.find((record) => record.contract.objective.trim() === objective);
      continuingInstalledGoal = Boolean(installed);
      if (!installed) {
        installed = await installSupervisorGoal({
          objective,
          acceptance,
          context,
          constraints,
        });
        goalCache?.unstarted.push(installed);
      }
    }

    const goalId = installed.goalId;
    const workerName = workerNameForGoal(goalId);
    const legacyWorkerName = legacyWorkerNameForGoal(goalId);
    let paneId = pendingStarts.get(goalId);
    const retryingPendingStart = Boolean(paneId);
    if (!paneId) {
      const supervisorPane = process.env.HERDR_PANE_ID;
      if (!supervisorPane) throw new Error("Start the supervisor inside a Herdr pane before creating a worker.");
      const direction = params.direction === "down" ? "down" : "right";
      const snapshot = await client.snapshot();
      const supervisor = findPane(snapshot, supervisorPane);
      if (!supervisor) throw new Error(`The supervisor pane ${supervisorPane} is not present in Herdr.`);
      const recognizedNames = new Set([workerName]);
      if (continuingInstalledGoal) recognizedNames.add(legacyWorkerName);
      const pendingAgents = snapshot.agents?.filter((agent) => (
        recognizedNames.has(agent.name)
        && agent.workspace_id === supervisor.workspace_id
        && !goals.active.some((binding) => (
          binding.paneId === agent.pane_id
          || sameAgentSession(binding.agentSession, agent.agent_session)
        ))
      )) || [];
      if (pendingAgents.length > 1) {
        throw new Error(`Multiple initialized workers could belong to installed goal ${goalId}; choose the correct worker before retrying.`);
      }
      const pendingAgent = pendingAgents[0];
      if (pendingAgent?.name === legacyWorkerName) {
        const recorded = await loadSupervisorGoals();
        const legacyNameConflict = [
          ...recorded.active,
          ...recorded.unstarted,
          ...recorded.completed,
        ].some((record) => (
          record.goalId !== goalId
          && legacyWorkerNameForGoal(record.goalId) === pendingAgent.name
        ));
        if (legacyNameConflict) {
          throw new Error(`The legacy worker name for installed goal ${goalId} is ambiguous; choose the correct worker before retrying.`);
        }
      }
      paneId = pendingAgent?.pane_id;

      if (!paneId && params.placement.mode === "related") {
        const relatedPaneId = params.placement.pane_id.trim();
        if (!goals.active.some((binding) => binding.paneId === relatedPaneId)) {
          throw new Error(`${relatedPaneId} is not an active supervised worker.`);
        }
        const anchor = findPane(snapshot, relatedPaneId);
        if (!anchor) throw new Error(`The related worker pane ${relatedPaneId} is not present in Herdr.`);
        if (anchor.workspace_id !== supervisor.workspace_id || anchor.tab_id === supervisor.tab_id) {
          throw new Error(`The related worker ${relatedPaneId} is not in a separate worker tab in this workspace.`);
        }
        const created = await client.splitPane({ paneId: anchor.pane_id, direction, cwd, focus: false });
        paneId = created?.pane?.pane_id;
      } else if (!paneId) {
        const label = params.placement.label.trim();
        const created = await client.createTab({
          workspaceId: supervisor.workspace_id,
          cwd,
          label,
          focus: false,
        });
        paneId = created?.root_pane?.pane_id;
      }
      if (!paneId) throw new Error("Herdr created worker space but did not return its pane identity.");
      pendingStarts.set(goalId, paneId);

      if (!pendingAgent) {
        try {
          await client.startAndWaitAgent({
            name: workerName,
            kind: "codex",
            paneId,
            args: [...codexLaunchArgs(cwd), workerInitializationPrompt],
          });
        } catch (error) {
          throw new Error(`Created worker pane ${paneId}, but Codex did not initialize: ${error.message}. Retry this same goal; do not create another worker.`);
        }
      } else if (!pendingAgent.agent_session) {
        await client.promptAgent(paneId, workerInitializationPrompt);
      }
    }

    if (retryingPendingStart) {
      await client.promptAgent(paneId, workerInitializationPrompt);
    }

    try {
      await client.waitForAgentSession(paneId);
    } catch (error) {
      throw new Error(`Created idle Codex worker ${paneId}, but Herdr could not identify its native session: ${error.message}. The goal was not delivered or bound; repair the Codex integration and retry this same goal to reuse the worker.`);
    }

    let result;
    try {
      result = await startInstalled(paneId, goalId, { wake: false });
      pendingStarts.delete(goalId);
    } catch (error) {
      throw new Error(`Started identified Codex worker ${paneId}, but could not record its goal: ${error.message}. The goal was not delivered; do not create another worker.`);
    }

    let promptWarning = "";
    try {
      await deliverNativeGoal(result.binding);
    } catch (error) {
      promptWarning = ` Initial native Goal delivery could not be confirmed: ${error.message}.`;
    }
    return { ...result, existing: false, warning: `${result.warning}${promptWarning}` };
  }

  async function startInstalled(paneId: string, goalId: string, {
    wake = true,
    activateNativeGoal = false,
  } = {}) {
    const snapshot = await client.snapshot();
    const agent = findAgent(snapshot, paneId);
    if (!agent) throw new Error(`no observable agent in ${paneId}`);
    const binding = await startInstalledGoal(goalId, captureIdentity(agent));
    cacheBinding(binding);
    if (goalCache) goalCache.unstarted = goalCache.unstarted.filter((record) => record.goalId !== goalId);
    scheduleReview(binding);
    let warning = "";
    try {
      await connectObserver();
      await armReviewTimer();
    } catch (error) {
      warning = ` Monitoring setup failed: ${error.message}`;
    }
    if (activateNativeGoal && mode() === "live") {
      try {
        await deliverNativeGoal(binding);
      } catch (error) {
        warning += ` Native Goal delivery could not be confirmed: ${error.message}`;
      }
    }
    if (wake && shouldWake(binding, agent, findPane(snapshot, paneId)).wake) void handleSignal(binding.paneId);
    return { binding, warning };
  }

  pi.registerTool({
    name: "supervisor_start_goal",
    label: "Start a supervised goal",
    description: "Start one new or saved goal in a Codex worker and supervise it. For a new goal, supply its contract fields. To resume an exact unstarted saved contract, supply goal_id and omit the contract fields. Continue an active goal instead of creating a sibling. The worker, not the supervisor, chooses and manages any Git worktrees needed by the goal.",
    parameters: Type.Object({
      goal_id: Optional(Type.String({ minLength: 1, description: "Exact existing goal ID to start or continue. Use null when defining a new goal." })),
      goal: Optional(Type.String({ minLength: 1, description: "The durable outcome for a new goal. Use null when goal_id names a saved goal." })),
      context: Optional(Type.Array(Type.String({ minLength: 1 }), {
        maxItems: 10,
        description: "Durable facts for a new goal. Use null with goal_id. Keep transient worker state, credentials, waits, and coordination in current evidence instead.",
      })),
      acceptance: Optional(Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        maxItems: 10,
        description: "Concrete completion evidence for a new goal. Use null with goal_id.",
      })),
      constraints: Optional(Type.Array(Type.String({ minLength: 1 }), {
        maxItems: 10,
        description: "Lasting boundaries for a new goal. Use null with goal_id.",
      })),
      placement: Type.Union([
        Type.Object({
          mode: Type.Literal("new"),
          label: Type.String({ minLength: 1, maxLength: 40, description: "Short label for the new worker tab." }),
        }),
        Type.Object({
          mode: Type.Literal("related"),
          pane_id: Pane,
        }),
      ], { description: "Create a new worker tab, or join the tab of one exact active related worker." }),
      working_directory: Type.String({ minLength: 1, description: "Absolute project or discovery root where the worker starts. It is independent of the supervisor directory; the worker manages any required worktrees." }),
      direction: Optional(Type.Union([Type.Literal("right"), Type.Literal("down")], { description: "Where to place the worker pane. Use null to default to right." })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const result = await startWorkerForGoal(params);
        await refreshStatus(ctx);
        if (result.existing) {
          return text(`Continued existing goal ${result.binding.goalId} in ${result.binding.paneId}; no worker was created.`);
        }
        return text(`Started and supervised goal ${result.binding.goalId} in Codex worker ${result.binding.paneId}.${result.warning}`);
      } catch (error) {
        return text(`Could not start the supervised goal: ${error.message}`, true);
      }
    },
  });

  pi.registerTool({
    name: "supervisor_update_goal",
    label: "Update a supervised goal",
    description: "Replace one active goal's durable contract while keeping its exact worker. Use only when the human changes the durable outcome, context, acceptance criteria, or constraints—not for a transient login, worker state, wait, or other execution evidence. Supply the complete revised contract; do not create a sibling goal and do not use temporary steering as a substitute.",
    parameters: Type.Object({
      pane_id: Pane,
      goal: Type.String({ minLength: 1, description: "The complete revised durable outcome." }),
      context: Optional(Type.Array(Type.String({ minLength: 1 }), {
        maxItems: 10,
        description: "The complete revised set of durable facts needed to pursue the goal. Exclude transient execution evidence.",
      })),
      acceptance: Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        maxItems: 10,
        description: "The complete revised set of concrete completion criteria.",
      }),
      constraints: Optional(Type.Array(Type.String({ minLength: 1 }), {
        maxItems: 10,
        description: "The complete revised set of boundaries the worker must preserve.",
      })),
      summary: Type.String({ minLength: 1, description: "A concise explanation of what the human changed and why." }),
    }),
    executionMode: "sequential",
    async execute(_id, params) {
      if (reviewTurn.isBusy()) {
        return text(`Finish preparing or reviewing ${reviewTurn.paneId} before updating a goal contract.`, true);
      }
      try {
        const binding = await bindingForPane(params.pane_id);
        if (!binding) return text(`${params.pane_id} is not supervised.`, true);
        const result = await refineSupervisorGoal(binding.goalId, {
          objective: params.goal.trim(),
          context: (params.context || []).map((item) => item.trim()).filter(Boolean),
          acceptance: params.acceptance.map((item) => item.trim()).filter(Boolean),
          constraints: (params.constraints || []).map((item) => item.trim()).filter(Boolean),
          summary: params.summary.trim(),
        });
        await reloadGoals();
        const refinedBinding = await bindingForPane(params.pane_id) || result.binding;
        scheduleReview(refinedBinding);
        let deliveryWarning = "";
        if (mode() === "live") {
          try {
            const snapshot = await client.snapshot();
            const agent = findAgent(snapshot, binding.paneId);
            const mismatch = identityMismatch(
              refinedBinding,
              agent,
              findPane(snapshot, binding.paneId),
            );
            if (mismatch) {
              deliveryWarning = ` The durable contract was updated, but it was not sent because ${mismatch}.`;
            } else if (typeof agent.name !== "string" || !agent.name.trim()) {
              deliveryWarning = " The durable contract was updated, but it was not sent because the Herdr worker has no stable name.";
            } else {
              await client.promptAgent(binding.paneId, refinedGoalPrompt(refinedBinding, agent.name));
            }
          } catch (error) {
            deliveryWarning = ` The durable contract was updated, but worker delivery could not be confirmed: ${error.message}.`;
          }
        }
        await armReviewTimer();
        const auditWarning = result.auditError ? ` Audit warning: ${result.auditError.message}.` : "";
        return text(`Updated goal ${binding.goalId} for the same worker ${binding.paneId}; no new goal or worker was created.${deliveryWarning}${auditWarning}`);
      } catch (error) {
        const reloadWarning = await reconcileCacheAfterWriteFailure();
        return text(`Could not update the supervised goal: ${error.message}.${reloadWarning}`, true);
      }
    },
  });

  pi.registerTool({
    name: "supervisor_status",
    label: "Supervised workers",
    description: "Show supervised goals against fresh Herdr worker state. The all-worker view is bounded; pass pane_id for that goal's full contract. During a focused review, peer progress is coordination context, not completion evidence for the focused goal.",
    parameters: Type.Object({ pane_id: Optional(Pane) }),
    executionMode: "parallel",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const fenceError = reviewTurn.guard();
      if (fenceError) return text(fenceError, true);
      try { return text(await status(params.pane_id)); }
      catch (error) { return text(`Could not read supervisor status: ${error.message}`, true); }
    },
  });

  pi.registerTool({
    name: "supervisor_reconsider",
    label: "Reconsider supervised goals",
    description: "Schedule one focused event review for each affected existing goal. Use when new evidence materially changes a wait or the human asks the supervisor to recheck current execution. The LLM selects the exact affected workers; code only queues their normal reviews. During another worker's focused review, retain these reviews for afterward and still finish the current review with one decision. This does not rewrite a durable goal or prompt a worker directly.",
    parameters: Type.Object({
      pane_ids: Type.Array(Pane, { minItems: 1, maxItems: 10 }),
      reason: Type.String({ minLength: 1, maxLength: 2000, description: "The concrete new fact or request each focused review must evaluate." }),
    }),
    executionMode: "sequential",
    async execute(_id, params) {
      const goals = await activeBindings();
      const requested = [...new Set(params.pane_ids.map((paneId) => paneId.trim()))];
      const activePanes = new Set(goals.active.map((binding) => binding.paneId));
      const missing = requested.filter((paneId) => !activePanes.has(paneId));
      if (missing.length) return text(`Cannot reconsider unsupervised worker(s): ${missing.join(", ")}.`, true);
      const sequence = ++workerEventSequence;
      const activeReviewPane = reviewTurn.isActive() ? reviewTurn.paneId : undefined;
      const queued = requested.filter((paneId) => paneId !== activeReviewPane);
      for (const paneId of queued) {
        queueSignal(paneId, {
          force: true,
          reason: `new execution information: ${params.reason.trim()}`,
          key: `human:${sequence}:${paneId}`,
        });
      }
      if (activeGlobalReview) {
        return text(`Retained focused reconsideration for ${requested.join(", ")} after the current global review. Finish that review with supervisor_global_result.`);
      }
      if (reviewTurn.isActive()) {
        const retained = queued.length ? ` Retained focused reconsideration for ${queued.join(", ")} after it.` : "";
        return text(`Apply the new human information to the current review of ${reviewTurn.paneId} and finish it with one decision.${retained}`);
      }
      return text(`Scheduled focused reconsideration for ${requested.join(", ")} after this turn. Their durable goals were not changed. End this supervisor turn now.`);
    },
  });

  pi.registerTool({
    name: "supervisor_global_result",
    label: "Finish global supervision review",
    description: "Finish the current compact all-goal review. Findings are the complete set of problems still proven now, including unchanged active findings; an empty set means earlier findings resolved. They name the goals they concern but do not schedule work. Put only goals that actually need a fresh one-goal decision in reconsider. This tool never prompts or changes workers directly.",
    parameters: Type.Object({
      summary: Type.String({ minLength: 1, maxLength: 4000 }),
      findings: Type.Array(Type.Object({
        problem: Type.String({ minLength: 1, maxLength: 2000 }),
        evidence: Type.Array(Type.String({ minLength: 1, maxLength: 2000 }), { minItems: 1, maxItems: 8 }),
        affected_goal_ids: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 10 }),
      }), { maxItems: 10 }),
      reconsider: Type.Array(Type.Object({
        goal_id: Type.String({ minLength: 1 }),
        reason: Type.String({ minLength: 1, maxLength: 2000 }),
      }), { maxItems: 10 }),
      next_review_at: Optional(Type.String({ minLength: 1 })),
    }),
    executionMode: "sequential",
    async execute(_id, params) {
      if (!activeGlobalReview) return text("No global supervision review is active.", true);
      if (globalDecisionApplied) return text("The global supervision review already has a result.", true);
      const goals = await loadSupervisorGoals();
      const byGoalId = new Map(goals.active.map((binding) => [binding.goalId, binding]));
      const unstartedGoalIds = new Set(goals.unstarted.map((goal) => goal.goalId));
      const knownGoalIds = new Set([...byGoalId.keys(), ...unstartedGoalIds]);
      const referenced = new Set([
        ...params.findings.flatMap((finding) => finding.affected_goal_ids),
        ...params.reconsider.map((item) => item.goal_id),
      ]);
      const unknown = [...referenced].filter((goalId) => !knownGoalIds.has(goalId));
      if (unknown.length) {
        return text(`Cannot route the global result because these goals were not found among active or unstarted goals: ${unknown.join(", ")}. No focused reviews were queued.`, true);
      }
      const unstartedReconsider = [...new Set(params.reconsider
        .map((item) => item.goal_id)
        .filter((goalId) => unstartedGoalIds.has(goalId)))];
      if (unstartedReconsider.length) {
        return text(`Cannot queue a focused review for unstarted goal(s) with no worker: ${unstartedReconsider.join(", ")}. Report them as findings without reconsideration so the human can decide whether to resume their saved contracts. No focused reviews were queued.`, true);
      }
      const now = new Date();
      const nextReviewAt = params.next_review_at?.trim()
        || new Date(now.getTime() + (globalReviewIntervalMs() ?? DEFAULT_GLOBAL_REVIEW_INTERVAL_MS)).toISOString();
      try {
        reviewDeadline(nextReviewAt, now.getTime());
      } catch (error) {
        return text(`Invalid next_review_at: ${error.message}. No focused reviews were queued.`, true);
      }
      const findings = params.findings.map((finding) => ({
        problem: finding.problem.trim(),
        evidence: finding.evidence.map((item) => item.trim()),
        affectedGoalIds: [...new Set(finding.affected_goal_ids)],
      }));
      const findingHash = globalFindingHash(findings);
      const findingSummary = findings.length ? globalFindingSummary(findings) : undefined;
      const isNewFinding = findings.length > 0 && findingHash !== globalState.lastFindingHash;
      const nextState = {
        version: 1,
        lastReviewedAt: now.toISOString(),
        nextReviewAt,
        snapshotHash: globalState.snapshotHash,
        lastFindingHash: findings.length ? findingHash : undefined,
        lastFinding: findingSummary,
      };
      try {
        await saveGlobalReviewState(nextState);
      } catch (error) {
        return text(`Could not save the global review result: ${error.message}. No focused reviews were queued.`, true);
      }
      globalState = nextState;
      const reasons = new Map<string, string[]>();
      for (const item of params.reconsider) {
        const items = reasons.get(item.goal_id) || [];
        items.push(item.reason.trim());
        reasons.set(item.goal_id, items);
      }
      const sequence = ++workerEventSequence;
      for (const [goalId, items] of reasons) {
        const binding = byGoalId.get(goalId)!;
        queueSignal(binding.paneId, {
          force: true,
          reason: `the global supervision review found: ${items.join(" | ")}`,
          key: `global:${sequence}:${goalId}`,
        });
      }
      globalDecisionApplied = true;
      globalMissingDecisionRetries = 0;
      armGlobalReviewTimer();
      if (isNewFinding) {
        pi.sendMessage({
          customType: "herdr-supervisor-global-finding",
          content: `Supervisor health review\n${params.summary.trim()}\n\n${findingSummary}`,
          display: true,
        }, { triggerTurn: false, deliverAs: "followUp" });
      }
      const routed = reasons.size ? ` Queued focused reviews for ${[...reasons.keys()].join(", ")}.` : " No focused review is needed.";
      const visibility = isNewFinding ? " The new finding was shown once." : " No new finding was shown.";
      return text(`Global review recorded.${routed}${visibility} End this turn without repeating the result.`);
    },
  });

  pi.registerTool({
    name: "supervisor_observe",
    label: "Review worker",
    description: "Read bounded current output from one supervised worker after validating its exact terminal and native agent-session identity.",
    parameters: Type.Object({ pane_id: Pane, lines: Optional(Type.Integer({ minimum: 10, maximum: 200 })) }),
    executionMode: "parallel",
    async execute(_id, params) {
      const fenceError = reviewTurn.beginObservation(params.pane_id);
      if (fenceError) return text(fenceError, true);
      let observed = false;
      try {
        const [binding, snapshot] = await Promise.all([bindingForPane(params.pane_id), client.snapshot()]);
        if (!binding) return text(`${params.pane_id} is not supervised.`, true);
        const runtime = runtimeFor(binding);
        const agent = findAgent(snapshot, params.pane_id);
        const mismatch = identityMismatch(binding, agent, findPane(snapshot, params.pane_id));
        if (mismatch) {
          // Establishing that the registered identity is gone is the complete,
          // safe observation for this turn. No replacement output is exposed.
          observed = true;
          return text(`Refusing to observe as the registered worker: ${mismatch}.`, true);
        }
        const observation = await observeWorker(binding, client, {
          terminalLines: params.lines || 40,
          fallbackWhenEmpty: agent.agent_status === "blocked" || agent.agent_status === "unknown",
        });
        const currentBinding: GoalBinding = binding;
        runtime.pendingCursor = observation.cursor;
        runtime.pendingObservationHasMessages = observation.messages.some((message) => message.text.trim().length > 0);
        runtime.lastReviewStateChangeSeq = Number(agent.state_change_seq || 0);
        scheduleReview(currentBinding);
        await armReviewTimer();
        observed = true;
        const trigger = reviewTurn.reason ? `Review trigger: ${reviewTurn.reason}\n` : "";
        const progress = currentBinding.progress ? `\nCurrent progress: ${currentBinding.progress}` : "";
        return text(`${trigger}Goal: ${currentBinding.goal}${progress}\nHerdr state: ${agent.agent_status}\n\n${formatObservation(observation)}`);
      } catch (error) { return text(`Could not observe worker: ${error.message}`, true); }
      finally { reviewTurn.finishObservation(observed); }
    },
  });

  pi.registerTool({
    name: "supervisor_leave",
    label: "Leave worker alone",
    description: "Record acceptable progress and take no worker action until its next event or a bounded review. Leave a working worker as working and use null for waiting_for; its next checkpoint belongs in progress. A settled worker may be left alone only when waiting_for names a concrete peer or external condition. Provider metadata wakes workers for supported PR and build changes; bounded review remains the safety net. Use review_at for an evidence-appropriate exact safety check, or null for the normal interval. At that review, confirm the condition still exists, seek a safe mitigation or independent useful work, and continue the worker whenever anything can move. Do not extend the same wait unless fresh current evidence establishes why and supplies the next boundary.",
    parameters: Type.Object({
      pane_id: Pane,
      progress: Type.String({ minLength: 1 }),
      waiting_for: Optional(Type.String({ minLength: 1, description: "Concrete peer or external condition that can resume a settled worker. Use null when the worker is actively working." })),
      waiting_on_pane: Optional(Type.String({ minLength: 1, description: "Exact different supervised worker this wait depends on. Its reviews receive this condition so the model can wake this goal only when materially affected. Use null for self or external waits." })),
      evidence: Evidence,
      review_at: Optional(Type.String({ minLength: 1, description: "Optional evidence-appropriate ISO 8601 safety-check time no more than 24 hours ahead. Peer decisions and watched changes wake earlier. Use null for the normal interval." })),
    }),
    executionMode: "sequential",
    async execute(_id, params) {
      const fenceError = reviewTurn.guardDecision(params.pane_id);
      if (fenceError) return text(fenceError, true);
      let binding = await bindingForPane(params.pane_id);
      if (!binding) return text(`${params.pane_id} is not supervised.`, true);
      const waitingFor = params.waiting_for?.trim();
      const waitingOnPane = params.waiting_on_pane?.trim();
      let effectiveWaitingOnPane = waitingOnPane;
      let waitingOnGoalId;
      let warning = "";
      if (waitingOnPane && !waitingFor) {
        return text("waiting_on_pane requires a concrete waiting_for condition.", true);
      }
      if (waitingOnPane === params.pane_id) {
        effectiveWaitingOnPane = undefined;
        warning = "\nPeer wake warning: ignored a self-reference; the bounded review deadline remains active.";
      }
      const previousReviewAt = Date.parse(binding.wait?.reviewAt || "");
      if (effectiveWaitingOnPane) {
        const peerPane = effectiveWaitingOnPane;
        const peer = await bindingForPane(peerPane);
        if (!peer) {
          warning = `\nPeer wake warning: ignored unknown worker ${peerPane}; the bounded review deadline remains active.`;
          effectiveWaitingOnPane = undefined;
        } else {
          waitingOnGoalId = peer.goalId;
        }
      }
      const reviewAt = params.review_at?.trim()
        || (waitingFor ? new Date(Date.now() + reviewIntervalMs()).toISOString() : undefined);
      let deadline: number | undefined;
      try {
        if (reviewAt) deadline = reviewDeadline(reviewAt);
      } catch (error) {
        return text(`Cannot schedule review_at ${reviewAt}; ${error.message}.`, true);
      }
      const [latestGoals, latestSnapshot] = await Promise.all([activeBindings(), client.snapshot()]);
      const latestBinding = latestGoals.active.find((goal) => (
        goal.goalId === binding.goalId && goal.paneId === params.pane_id
      ));
      if (!latestBinding) return text(`${params.pane_id} is no longer the supervised worker for this goal.`, true);
      binding = latestBinding;
      const latestAgent = findAgent(latestSnapshot, params.pane_id);
      const latestMismatch = identityMismatch(
        binding,
        latestAgent,
        findPane(latestSnapshot, params.pane_id),
      );
      if (latestMismatch) return text(`Cannot leave this worker working: ${latestMismatch}.`, true);
      if (latestAgent.agent_status === "working" && waitingFor) {
        return text("A working worker is active, not waiting. Use null for waiting_for and record its next checkpoint in progress; use waiting_for only after the worker settles on a concrete external or peer condition.", true);
      }
      if (latestAgent.agent_status !== "working" && !waitingFor) {
        return text(`Cannot leave ${params.pane_id} alone because it is ${latestAgent.agent_status} and no concrete wait condition was supplied. Choose a real next action or name what can resume it.`, true);
      }
      if (
        waitingFor
        && !binding.wait?.paneId
        && latestAgent.agent_status !== "working"
        && Number.isFinite(previousReviewAt)
        && previousReviewAt <= Date.now()
        && runtimeFor(binding).pendingObservationHasMessages === false
      ) {
        return text("Cannot extend this expired external wait without fresh worker evidence. Continue the same worker to check the condition now, or choose another concrete action.", true);
      }
      if (waitingOnGoalId) {
        const latestPeer = latestGoals.active.find((goal) => goal.goalId === waitingOnGoalId);
        const latestPeerAgent = latestPeer && findAgent(latestSnapshot, latestPeer.paneId);
        const latestPeerProblem = latestPeer && identityMismatch(
          latestPeer,
          latestPeerAgent,
          findPane(latestSnapshot, latestPeer.paneId),
        );
        if (!latestPeer || latestPeerProblem || latestPeerAgent?.agent_status !== "working") {
          const peerState = latestPeerProblem || `worker is ${latestPeerAgent?.agent_status || "not running"}`;
          return text(`Cannot leave ${params.pane_id} waiting on ${effectiveWaitingOnPane} because ${peerState}. Shared capacity is not reserved by an inactive worker; choose useful work that can proceed or name the real external blocker.`, true);
        }
        effectiveWaitingOnPane = latestPeer.paneId;
      }
      const progress = waitingFor
        ? `${params.progress.trim()}\nWaiting for: ${waitingFor}`
        : params.progress.trim();
      if (mode() === "live") {
        const result = await recordDecision(binding, "leave", {
          progress,
          action: waitingFor
            ? `Left the worker alone until ${waitingFor} or the next bounded review.`
            : "Left the healthy worker running until new evidence or the next review.",
          wait: waitingFor ? {
            condition: waitingFor,
            reviewAt,
            ...(effectiveWaitingOnPane ? { paneId: effectiveWaitingOnPane, goalId: waitingOnGoalId } : {}),
          } : undefined,
          reviewAt: waitingFor ? undefined : params.review_at?.trim(),
          evidence: params.evidence || binding.evidence,
          observationCursor: runtimeFor(binding).pendingCursor,
        });
        cacheCheckpoint(binding, result.state);
        const runtime = runtimeFor(binding);
        runtime.pendingCursor = undefined;
        if (result.auditError) warning += `\nAudit warning: ${result.auditError.message}`;
      }
      scheduleReview(binding, deadline ? deadline - Date.now() : reviewIntervalMs());
      reviewTurn.close(params.pane_id);
      try { await armReviewTimer(); }
      catch (error) { warning += `\nReview timer warning: ${error.message}`; }
      const state = waitingFor ? `waiting for ${waitingFor}` : "working";
      return text(`${mode() === "live" ? "Left" : `${mode()} mode: would leave`} ${params.pane_id} ${state}.\n${progress}${warning}\n\nEnd this supervisor turn now.`);
    },
  });

  pi.registerTool({
    name: "supervisor_steer",
    label: "Continue worker",
    description: "Give the same supervised worker one useful next action. The runtime keeps an exact Codex worker's native Goal active and recovers its exact session when needed; the model does not choose a transport.",
    parameters: Type.Object({
      pane_id: Pane,
      message: Type.String({ minLength: 1 }),
      evidence: Evidence,
      review_at: Optional(Type.String({ minLength: 1, description: "Optional exact ISO 8601 time, no more than 24 hours ahead, when this instruction must be reconsidered even if the worker still appears busy. Use null for routine event-driven supervision." })),
    }),
    executionMode: "sequential",
    async execute(_id, params) {
      const fenceError = reviewTurn.guardDecision(params.pane_id);
      if (fenceError) return text(fenceError, true);
      let relocatedBinding: ActiveGoal | undefined;
      try {
        const [initialBinding, snapshot] = await Promise.all([bindingForPane(params.pane_id), client.snapshot()]);
        if (!initialBinding) return text(`${params.pane_id} is not supervised.`, true);
        let binding = initialBinding;
        const reviewAt = params.review_at?.trim();
        let deadline: number | undefined;
        try {
          if (reviewAt) deadline = reviewDeadline(reviewAt);
        } catch (error) {
          return text(`Cannot schedule review_at ${reviewAt}; ${error.message}.`, true);
        }
        const agent = findAgent(snapshot, params.pane_id);
        const pane = findPane(snapshot, params.pane_id);
        const mismatch = identityMismatch(
          binding,
          agent,
          pane,
        );
        const canRecover = !agent && canRecoverAgentSession(binding.agentSession);
        if (mismatch && !canRecover) return text(`Refusing to continue: ${mismatch}.`, true);
        if (mode() !== "live") {
          reviewTurn.close(params.pane_id);
          const action = canRecover && !pane
            ? `create a new routing pane and resume the exact ${binding.agentSession.agent} session for`
            : canRecover
              ? `resume the exact ${binding.agentSession.agent} session in`
              : "prompt";
          return text(`${mode()} mode: would ${action} ${params.pane_id}: ${params.message.trim()}\n\nEnd this supervisor turn now. Wait for Herdr's next worker event; do not poll.`);
        }
        let liveSnapshot = await client.snapshot();
        let liveAgent = findAgent(liveSnapshot, params.pane_id);
        let livePane = findPane(liveSnapshot, params.pane_id);
        let relocated = false;
        if (!liveAgent) {
          const previousPaneId = binding.paneId;
          try {
            binding = await recoverWorkerRouting(binding, liveSnapshot);
          } catch (error) {
            if (isRecoveryPreflightError(error)) {
              return text(`Could not start worker recovery: ${error.message}. No routing action was attempted, so you may decide again in this review turn.`, true);
            }
            reviewTurn.close(params.pane_id);
            scheduleReview(binding);
            let warning = "";
            try { await armReviewTimer(); }
            catch (timerError) { warning = ` Review timer warning: ${timerError.message}.`; }
            return text(`Could not confirm worker recovery: ${error.message}. Routing recovery may have partly applied, but no worker instruction was sent.${warning}\n\nDo not retry in this turn. The bounded review will reread current state and continue safely.`, true);
          }
          relocated = binding.paneId !== previousPaneId;
          if (relocated) {
            reviewTurn.retarget(params.pane_id, binding.paneId);
            relocatedBinding = binding;
          }
          liveSnapshot = await client.snapshot();
          const latestBinding = await adoptExactSession(binding, liveSnapshot);
          if (latestBinding && latestBinding.paneId !== binding.paneId) {
            reviewTurn.retarget(binding.paneId, latestBinding.paneId);
            binding = latestBinding;
            relocated = true;
            relocatedBinding = binding;
          } else if (latestBinding) {
            binding = latestBinding;
          }
          if (relocated) {
            try {
              await connectObserver();
            } catch (error) {
              reportBackgroundFailure("Could not watch the relocated worker", error);
            }
          }
          liveAgent = findAgent(liveSnapshot, binding.paneId);
          livePane = findPane(liveSnapshot, binding.paneId);
        }
        const liveMismatch = identityMismatch(binding, liveAgent, livePane);
        const canResumeNow = !liveAgent && livePane?.terminal_id === binding.terminalId;
        const canResumeNativeGoal = Boolean(
          liveAgent
          && binding.agentSession.agent === "codex"
          && ["idle", "done"].includes(liveAgent.agent_status),
        );
        if (liveMismatch && !canResumeNow) {
          if (relocatedBinding) throw new Error(liveMismatch);
          return text(`Refusing to continue after rereading worker identity: ${liveMismatch}.`, true);
        }
        let continuedBinding = binding;
        let resumed = false;
        const instruction = params.message.trim();
        if (canResumeNow) {
          const request = recoveryRequest(binding, liveSnapshot);
          if (relocated) request.name = workerNameForGoal(binding.goalId);
          // An interrupted native Codex Goal is paused by design. Resume that
          // lifecycle explicitly before queuing the supervisor's fresh
          // steering; otherwise Codex waits at an interactive "Resume goal?"
          // gate and the apparently recovered worker never moves.
          request.args = [...codexLaunchArgs(), ...request.args, "/goal resume"];
          reviewTurn.close(binding.paneId);
          let resumedAgent;
          try {
            resumedAgent = await client.startAndWaitAgent(request, 31_000);
          } catch (error) {
            scheduleReview(binding);
            let warning = "";
            try { await armReviewTimer(); }
            catch (timerError) { warning = ` Review timer warning: ${timerError.message}.`; }
            return text(`Could not confirm the exact-session resume for ${binding.paneId}: ${error.message}. The resume may have started, but no follow-up instruction was sent.${warning}\n\nDo not resume it again in this turn. The bounded review will reread current worker state and continue safely.`, true);
          }
          const resumedMismatch = identityMismatch(binding, resumedAgent, resumedAgent);
          if (resumedMismatch) {
            reviewTurn.close(binding.paneId);
            scheduleReview(binding);
            return text(`The exact-session resume ran, but the resulting worker identity did not match: ${resumedMismatch}. No further message was sent.\n\nEnd this supervisor turn now; do not retry without fresh evidence.`, true);
          }
          continuedBinding = await refreshObservedLocation(binding, resumedAgent);
          resumed = true;
        } else if (canResumeNativeGoal) {
          try {
            await client.promptAgent(binding.paneId, "/goal resume", {
              until: ["working"],
              timeout_ms: 5000,
            });
          } catch (error) {
            reviewTurn.close(binding.paneId);
            scheduleReview(binding);
            return text(`Could not confirm that the native Goal resumed in ${binding.paneId}: ${error.message}. No follow-up instruction was sent.\n\nDo not resume it again in this turn. End this supervisor turn now and wait for fresh worker evidence.`, true);
          }
          reviewTurn.close(binding.paneId);
          let resumedSnapshot;
          try {
            resumedSnapshot = await client.snapshot();
          } catch (error) {
            scheduleReview(binding);
            return text(`The native Goal resumed in ${binding.paneId}, but its updated worker state could not be observed: ${error.message}. No follow-up instruction was sent.\n\nDo not resume it again in this turn. End this supervisor turn now and wait for fresh worker evidence.`, true);
          }
          const resumedAgent = findAgent(resumedSnapshot, binding.paneId);
          const resumedMismatch = identityMismatch(
            binding,
            resumedAgent,
            findPane(resumedSnapshot, binding.paneId),
          );
          if (resumedMismatch) {
            reviewTurn.close(binding.paneId);
            scheduleReview(binding);
            return text(`The native Goal resumed, but the resulting worker identity did not match: ${resumedMismatch}. No follow-up instruction was sent.\n\nEnd this supervisor turn now and wait for fresh evidence.`, true);
          }
          if (resumedAgent.agent_status !== "working") {
            scheduleReview(binding);
            return text(`The native Goal resumed in ${binding.paneId}, but it settled again before the follow-up instruction could be sent.\n\nDo not resume it again in this turn. End this supervisor turn now and wait for fresh worker evidence.`, true);
          }
          continuedBinding = await refreshObservedLocation(binding, resumedAgent);
          resumed = true;
        }
        const delivery = await deliverWorkerInstruction(continuedBinding, instruction);
        relocatedBinding = undefined;
        if (delivery.deliveryError) {
          // A transport error cannot prove that Herdr did not accept the
          // prompt. Fail closed against duplicate delivery.
          scheduleReview(continuedBinding);
          const checkpoint = await saveUncertainSteer(
            continuedBinding,
            instruction,
            "Instruction delivery is uncertain; fresh worker evidence is required before another decision.",
            params.evidence || continuedBinding.evidence,
            reviewAt,
          );
          return text(`Could not confirm whether ${continuedBinding.paneId} received the instruction: ${delivery.deliveryError.message}.${checkpoint.warning}\n\nDo not send it again in this turn. Wait for fresh worker evidence.`, true);
        }
        // The worker action has happened. Close the turn before bookkeeping so
        // a checkpoint failure cannot cause the model to send it twice.
        reviewTurn.close(params.pane_id);
        try {
          const warning = await saveSteerCheckpoint(
            continuedBinding,
            instruction,
            `The worker was steered to continue: ${params.message.trim()}`,
            params.evidence || continuedBinding.evidence,
            reviewAt,
          );
          scheduleReview(continuedBinding, deadline ? deadline - Date.now() : reviewIntervalMs());
          const resultText = resumed
            ? `${relocated
              ? canResumeNow
                ? `Relocated and resumed the exact ${binding.agentSession.agent} session and native Goal`
                : `Relocated the exact ${binding.agentSession.agent} session and resumed its native Goal`
              : canResumeNow
                ? `Resumed the exact ${binding.agentSession.agent} session and native Goal`
                : "Resumed the exact native Goal"} in ${continuedBinding.paneId}, then asked it to continue.`
            : relocated
              ? `Relocated the exact ${binding.agentSession.agent} session to ${continuedBinding.paneId}, then steered it: ${params.message.trim()}`
              : `Steered ${params.pane_id}: ${params.message.trim()}`;
          return text(`${resultText}${warning}\n\nEnd this supervisor turn now. Wait for Herdr's next worker event; do not poll.`);
        } catch (error) {
          const reloadWarning = await reconcileCacheAfterWriteFailure();
          scheduleReview(continuedBinding);
          return text(`Continued ${params.pane_id}, but could not save the checkpoint: ${error.message}.${reloadWarning}\n\nDo not send the instruction again. End this supervisor turn now and wait for fresh worker evidence.`);
        }
      } catch (error) {
        if (relocatedBinding) {
          reviewTurn.close(relocatedBinding.paneId);
          scheduleReview(relocatedBinding);
          let warning = "";
          try { await armReviewTimer(); }
          catch (timerError) { warning = ` Review timer warning: ${timerError.message}.`; }
          return text(`Could not finish the relocated worker action: ${error.message}. Recovery may have partly applied, but no action was retried.${warning}\n\nDo not retry in this turn. The bounded review will reread current state and continue safely.`, true);
        }
        return text(`Could not continue worker: ${error.message}`, true);
      }
    },
  });

  pi.registerTool({
    name: "supervisor_ask_human",
    label: "Ask for a decision",
    description: "Ask the human one concrete question only when their authority or missing information is genuinely required. An accepted goal already delegates normal reversible in-scope steps needed to satisfy it; do not ask again for those steps unless the goal explicitly reserves the decision or forbids the action. Missing convenience tooling, a default credential helper, or one failed approach is not enough: steer the worker to exhaust safe in-scope capabilities first. For an access blocker, evidence must identify the failed operation, execution location, effective identity or authority, target, and observed error; authentication somewhere else is not proof that this boundary is authorized. This ends the review turn without prompting the worker.",
    parameters: Type.Object({
      pane_id: Pane,
      question: Type.String({ minLength: 1 }),
      evidence: Evidence,
      review_at: Optional(Type.String({ minLength: 1, description: "Bounded time to reconsider whether the human answer is still required or useful work can proceed without it. Use null for the normal bounded review interval." })),
    }),
    executionMode: "sequential",
    async execute(_id, params) {
      const fenceError = reviewTurn.guardDecision(params.pane_id);
      if (fenceError) return text(fenceError, true);
      const binding = await bindingForPane(params.pane_id);
      if (!binding) return text(`${params.pane_id} is not supervised.`, true);
      const now = Date.now();
      const reviewAt = params.review_at?.trim()
        || new Date(now + reviewIntervalMs()).toISOString();
      try {
        reviewDeadline(reviewAt, now);
      } catch (error) {
        return text(`Cannot schedule review_at ${reviewAt}; ${error.message}.`, true);
      }
      let warning = "";
      if (mode() === "live") {
        const result = await recordDecision(binding, "ask_human", {
          progress: `Human input is required: ${params.question.trim()}`,
          action: params.question.trim(),
          evidence: params.evidence || binding.evidence,
          observationCursor: runtimeFor(binding).pendingCursor,
          wait: {
            condition: `the human's answer to: ${params.question.trim()}`,
            reviewAt,
          },
        });
        cacheCheckpoint(binding, result.state);
        runtimeFor(binding).pendingCursor = undefined;
        if (result.auditError) warning = `\nAudit warning: ${result.auditError.message}`;
      }
      const runtime = runtimeFor(binding);
      runtime.awaitingHuman = true;
      runtime.nextReviewAt = reviewAt;
      reviewTurn.close(params.pane_id);
      try { await armReviewTimer(); }
      catch (error) { warning += `\nReview timer warning: ${error.message}`; }
      return text(`Needs your input for ${params.pane_id}:\n${params.question.trim()}\nThe supervisor will reconsider this at ${reviewAt} instead of forgetting it.${warning}\n\nEnd this supervisor turn now. Wait for the human's answer; do not prompt or poll the worker.`);
    },
  });

  pi.registerTool({
    name: "supervisor_finish",
    label: "Accept worker goal",
    description: "Stop supervision only when current evidence covers the whole objective and every acceptance criterion at the same declared scope and time horizon. A final message, PR, run, report, fixed backlog, raised threshold, or one review cycle is evidence, not completion by itself. An idle or done agent state is not evidence. A standing improvement goal cannot finish until the human explicitly stops or replaces it.",
    parameters: Type.Object({
      pane_id: Pane,
      summary: Type.String({ minLength: 1 }),
      evidence: EvidenceItems,
    }),
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const fenceError = reviewTurn.guardDecision(params.pane_id);
      if (fenceError) return text(fenceError, true);
      const binding = await bindingForPane(params.pane_id);
      if (!binding) return text(`${params.pane_id} is not supervised.`, true);
      if (mode() !== "live") {
        reviewTurn.close(params.pane_id);
        return text(`${mode()} mode: evidence supports accepting ${params.pane_id}, but its goal binding remains active.\n${params.summary}\n\nEnd this supervisor turn now. Wait for Herdr's next worker event; do not poll.`);
      }
      const latestSnapshot = await client.snapshot();
      const latestAgent = findAgent(latestSnapshot, binding.paneId);
      const latestMismatch = identityMismatch(
        binding,
        latestAgent,
        findPane(latestSnapshot, binding.paneId),
      );
      if (latestMismatch) {
        return text(`Cannot accept ${params.pane_id}: ${latestMismatch}. Review the current exact worker first.`, true);
      }
      const observedSequence = runtimeFor(binding).lastReviewStateChangeSeq;
      const latestSequence = Number(latestAgent.state_change_seq || 0);
      if (latestAgent.agent_status === "working" || latestSequence !== observedSequence) {
        scheduleReview(binding, 0);
        return text(`Cannot accept ${params.pane_id}: the worker changed after it was observed. Review its current evidence before deciding again.`, true);
      }
      let result;
      try {
        result = await recordDecision(binding, "accept", {
          progress: params.summary.trim(),
          action: "Accepted the verified goal.",
          evidence: params.evidence,
          observationCursor: runtimeFor(binding).pendingCursor,
          terminal: { state: "accepted", summary: params.summary.trim() },
        });
      } catch (error) {
        const reloadWarning = await reconcileCacheAfterWriteFailure();
        scheduleReview(binding);
        return text(`Cannot accept ${params.pane_id}: ${error.message}.${reloadWarning} Review the latest worker evidence before deciding again.`, true);
      }
      runtimeFor(binding).pendingCursor = undefined;
      cacheCheckpoint(binding, result.state);
      reviewTurn.close(params.pane_id);
      wakeTerminalDependents(
        binding,
        `goal ${binding.goalId} finished; reconsider whether useful work can proceed`,
      );
      let warning = result.auditError ? `\nAudit warning: ${result.auditError.message}` : "";
      try {
        await connectObserver();
        await armReviewTimer();
        await refreshStatus(ctx);
      } catch (error) {
        warning += `\nRuntime view warning: ${error.message}`;
      }
      return text(`Goal accepted for ${params.pane_id}.\n${params.summary}\nEvidence:\n${params.evidence.map((item) => `- ${item}`).join("\n")}${warning}\n\nEnd this supervisor turn now. Wait for Herdr's next worker event; do not poll.`);
    },
  });

  pi.registerCommand("supervise", {
    description: "Supervise a pane: /supervise <pane> <goal> or /supervise <pane> --goal-id <id>",
    async handler(args, ctx) {
      const [paneId, ...goalParts] = args.trim().split(/\s+/);
      const goal = goalParts.join(" ");
      if (!paneId || !goal) return ctx.ui.notify("Usage: /supervise <pane> <goal>", "warning");
      if (goalParts[0] === "--goal-id" && (goalParts.length !== 2 || !goalParts[1])) {
        return ctx.ui.notify("Usage: /supervise <pane> --goal-id <id>", "warning");
      }
      try {
        const result = goalParts[0] === "--goal-id"
          ? await startInstalled(paneId, goalParts[1], { activateNativeGoal: true })
          : await register(paneId, goal, []);
        let warning = result.warning;
        try { await refreshStatus(ctx); }
        catch (error) { warning += ` Status refresh failed: ${error.message}`; }
        ctx.ui.notify(
          `Supervising ${result.binding.paneId}: ${result.binding.goal}${warning}`,
          warning ? "warning" : "info",
        );
      } catch (error) { ctx.ui.notify(error.message, "error"); }
    },
  });

  pi.registerCommand("supervised", {
    description: "Show supervised workers and goals",
    async handler(_args, ctx) {
      try { ctx.ui.notify(await status(), "info"); }
      catch (error) { ctx.ui.notify(error.message, "error"); }
    },
  });

  pi.registerCommand("unsupervise", {
    description: "Stop supervising a pane without stopping it",
    async handler(args, ctx) {
      const paneId = args.trim();
      if (!paneId) return ctx.ui.notify("Usage: /unsupervise <pane>", "warning");
      try {
        const binding = await bindingForPane(paneId);
        if (!binding) return ctx.ui.notify(`${paneId} was not supervised.`, "info");
        let result;
        try {
          result = await recordDecision(binding, "stop", {
            progress: "The human stopped supervision.",
            action: "Stopped supervision without stopping the worker.",
            evidence: binding.evidence,
            terminal: { state: "stopped", summary: "Stopped explicitly by the human." },
          });
          cacheCheckpoint(binding, result.state);
        } catch (error) {
          const reloadWarning = await reconcileCacheAfterWriteFailure();
          return ctx.ui.notify(`Could not save the request to stop supervising ${paneId}: ${error.message}.${reloadWarning}`, "error");
        }
        wakeTerminalDependents(
          binding,
          `supervision of ${paneId} stopped; reconsider whether useful work can proceed`,
        );
        let refreshWarning = "";
        try {
          await connectObserver();
          await armReviewTimer();
          await refreshStatus(ctx);
        } catch (error) {
          refreshWarning = ` Runtime view refresh failed: ${error.message}`;
        }
        const warning = [
          result.auditError ? `Audit failed: ${result.auditError.message}` : "",
          refreshWarning.trim(),
        ].filter(Boolean).join(" ");
        ctx.ui.notify(
          warning ? `Stopped supervising ${paneId}. ${warning}` : `Stopped supervising ${paneId}.`,
          warning ? "warning" : "info",
        );
      } catch (error) {
        ctx.ui.notify(`Could not stop supervising ${paneId}: ${error.message}`, "error");
      }
    },
  });

  pi.on("input", (event) => {
    const automaticReview = reviewTurn.isBusy() || activeGlobalReview || reviewPumpRunning;
    if (
      event.source === "extension"
      || !automaticReview
      || !["steer", "followUp"].includes(event.streamingBehavior || "")
    ) {
      return { action: "continue" };
    }
    const content = event.images?.length
      ? [{ type: "text" as const, text: event.text }, ...event.images]
      : event.text;
    const deliveryId = randomUUID();
    pendingHumanFollowUps.add(deliveryId);
    try {
      pi.sendMessage({
        customType: humanFollowUpMessageType,
        content,
        display: true,
        details: { deliveryId },
      }, {
        triggerTurn: true,
        deliverAs: "followUp",
      });
    } catch (error) {
      pendingHumanFollowUps.delete(deliveryId);
      throw error;
    }
    return { action: "handled" };
  });

  pi.on("before_agent_start", (event) => {
    agentTurnActive = true;
    return { systemPrompt: supervisorSystemPrompt(event.systemPrompt) };
  });

  async function settleGlobalReview() {
    if (!activeGlobalReview) return false;
    const decisionApplied = globalDecisionApplied;
    activeGlobalReview = false;
    globalDecisionApplied = false;
    if (!decisionApplied && globalMissingDecisionRetries < 1) {
      globalMissingDecisionRetries += 1;
      pendingGlobalReview ||= "the previous global review ended without supervisor_global_result";
    } else if (!decisionApplied) {
      globalMissingDecisionRetries = 0;
      globalState.nextReviewAt = new Date(Date.now() + Math.min(globalReviewIntervalMs() ?? DEFAULT_GLOBAL_REVIEW_INTERVAL_MS, 5000)).toISOString();
      try { await saveGlobalReviewState(globalState); }
      catch (error) { reportBackgroundFailure("Could not save the global review retry", error); }
    }
    return true;
  }

  async function settleFocusedReview() {
    const reviewedPane = reviewTurn.isActive() ? reviewTurn.paneId : undefined;
    const decisionApplied = reviewTurn.isClosed();
    reviewTurn.end();
    if (!reviewedPane) return false;
    const binding = await bindingForPane(reviewedPane);
    if (binding) {
      const runtime = runtimeFor(binding);
      if (decisionApplied) {
        runtime.missingDecisionRetries = 0;
      } else if (runtime.missingDecisionRetries < 1) {
        runtime.missingDecisionRetries += 1;
        queueSignal(reviewedPane, {
          force: true,
          reason: "the previous review ended without an explicit decision",
          key: `missing-decision:${binding.goalId}:${runtime.missingDecisionRetries}:${Date.now()}`,
        });
      } else {
        runtime.missingDecisionRetries = 0;
        if (!runtime.awaitingHuman) scheduleReview(binding);
      }
    }
    return true;
  }

  pi.on("message_start", async (event) => {
    if (event.message.role !== "custom" || event.message.customType !== humanFollowUpMessageType) return;
    const deliveryId = (event.message.details as { deliveryId?: unknown } | undefined)?.deliveryId;
    if (typeof deliveryId !== "string" || !pendingHumanFollowUps.delete(deliveryId)) return;
    agentTurnActive = true;
    if (!activeGlobalReview && !reviewTurn.isBusy() && !reviewTurn.isClosed()) return;
    const settledGlobal = await settleGlobalReview();
    if (!settledGlobal) await settleFocusedReview();
    await armReviewTimer();
    armGlobalReviewTimer();
  });

  pi.on("context", (event) => {
    let latestReview = -1;
    for (let index = event.messages.length - 1; index >= 0; index -= 1) {
      if ([reviewMessageType, globalReviewMessageType].includes((event.messages[index] as any).customType)) {
        latestReview = index;
        break;
      }
    }
    if (latestReview < 0) return;

    let insideOldReview = false;
    return {
      messages: event.messages.filter((message, index) => {
        if ([reviewMessageType, globalReviewMessageType].includes((message as any).customType)) {
          insideOldReview = index !== latestReview;
          return index === latestReview;
        }
        const humanMessage = message.role === "user"
          || (message.role === "custom" && message.customType === humanFollowUpMessageType);
        if (insideOldReview && humanMessage) insideOldReview = false;
        return !insideOldReview;
      }),
    };
  });

  pi.on("session_start", async (_event, ctx) => {
    // This Pi session is a supervisor, not a second implementation worker.
    pi.setActiveTools(supervisorTools);
    shuttingDown = false;
    globalState = await loadGlobalReviewState();
    await reloadGoals();
    const goals = await activeBindings();
    for (const binding of goals.active) {
      const runtime = runtimeFor(binding);
      if (!runtime.nextReviewAt) {
        if (runtime.awaitingHuman) {
          runtime.nextReviewAt = new Date(Date.now() + reviewIntervalMs()).toISOString();
        } else {
          scheduleReview(binding);
        }
      }
    }
    await connectObserver();
    await reconsiderCurrentBindings();
    await armReviewTimer();
    const globalDue = Date.parse(globalState.nextReviewAt || "");
    if (globalReviewIntervalMs() !== undefined && (!Number.isFinite(globalDue) || globalDue <= Date.now())) {
      scheduleGlobalReview(
        globalState.lastReviewedAt ? "the persisted global review is overdue" : "no global supervision review has been recorded",
      );
    } else {
      armGlobalReviewTimer();
    }
    ctx.ui.setStatus("herdr-supervisor", goals.active.length ? `supervising ${goals.active.length}` : undefined);
  });

  pi.on("agent_settled", async () => {
    agentTurnActive = false;
    if (await settleGlobalReview()) {
      await drainSignals();
      await armReviewTimer();
      armGlobalReviewTimer();
      return;
    }
    await settleFocusedReview();
    await drainSignals();
    await armReviewTimer();
  });

  pi.on("session_shutdown", () => {
    shuttingDown = true;
    stopSubscription?.();
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (reviewTimer) clearTimeout(reviewTimer);
    if (globalReviewTimer) clearTimeout(globalReviewTimer);
    for (const timer of workerEventTimers.values()) clearTimeout(timer);
    workerEventTimers.clear();
    pendingSignals.clear();
    pendingStarts.clear();
    pendingHumanFollowUps.clear();
    runtimeGoals.clear();
    goalCache = undefined;
    agentTurnActive = false;
    activeGlobalReview = false;
    globalDecisionApplied = false;
    pendingGlobalReview = undefined;
    reviewTurn.end();
    lastBackgroundError = "";
    observerInterrupted = false;
  });
}
