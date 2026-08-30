import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isAbsolute, resolve } from "node:path";
import { HerdrClient } from "./herdr-client.ts";
import {
  loadSupervisorGoals,
  installSupervisorGoal,
  clearExternalChange,
  recordExternalChange,
  recordDecision,
  refineSupervisorGoal,
  refreshWorkerLocation,
  registerSupervisedGoal,
  startInstalledGoal,
} from "./goal-registry.ts";
import { formatObservation, observeWorker } from "./observation.ts";
import { ReviewTurnFence } from "./review-turn.ts";
import {
  ExternalPollFence,
  observeExternalWatches,
} from "./external-watch.ts";
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
const Evidence = Type.Optional(EvidenceItems);
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
const DEFAULT_EXTERNAL_WATCH_INTERVAL_MS = 5 * 60 * 1000;
type SupervisorMode = "observe" | "dry-run" | "live";

function text(value: string, isError = false) {
  return { content: [{ type: "text" as const, text: value }], isError, details: undefined };
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
  const suffix = goalId.slice(2).replaceAll("-", "").toLowerCase();
  return `goal-${suffix.slice(0, 27)}`;
}

export default function herdrSupervisor(pi: ExtensionAPI) {
  let stopSubscription: undefined | (() => void);
  let reconnectTimer: undefined | ReturnType<typeof setTimeout>;
  let reviewTimer: undefined | ReturnType<typeof setTimeout>;
  let globalReviewTimer: undefined | ReturnType<typeof setTimeout>;
  const pendingSignals = new Map<string, ReviewSignal | undefined>();
  const pendingStarts = new Map<string, string>();
  const runtimeGoals = new Map<string, GoalRuntime>();
  const externalPoll = new ExternalPollFence();
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
        nextReviewAt: binding.externalChange
          ? new Date(0).toISOString()
          : binding.wait?.reviewAt || binding.reviewAt,
        lastReviewStateChangeSeq: 0,
        awaitingHuman: binding.lastDecision?.decision === "ask_human",
        missingDecisionRetries: 0,
      };
      runtimeGoals.set(binding.goalId, runtime);
    }
    return runtime;
  }

  async function reloadGoals() {
    const goals = await loadSupervisorGoals();
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

  function clearExternalWatch(binding) {
    const pending = pendingSignals.get(binding.paneId);
    if (pending?.key.startsWith("external:")) pendingSignals.delete(binding.paneId);
    runtimeFor(binding).externalWatch = undefined;
  }

  function stopExternalWatch(binding) {
    clearExternalWatch(binding);
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
      externalChange: state.externalChange ? structuredClone(state.externalChange) : undefined,
    });
  }

  function cursorAdvanced(previous, current) {
    return previous && current && JSON.stringify(previous) !== JSON.stringify(current);
  }

  function externalRereadObserved(binding, observation) {
    if (!binding.externalChange || binding.lastDecision?.decision !== "steer") return false;
    if (Date.parse(binding.lastDecision.at) < Date.parse(binding.externalChange.observedAt)) return false;
    return observation.messages.some((message) => message.phase === "final_answer")
      && cursorAdvanced(binding.observationCursor, observation.cursor);
  }

  function workerInstruction(binding, message) {
    const change = binding.externalChange;
    if (!change) return message.trim();
    return `The watched ${change.source} ${change.subject} changed. Reread its current authoritative state before deciding what it means, then continue the same goal.\n\n${message.trim()}`;
  }

  async function saveSteerCheckpoint(binding, instruction, progress, evidence, reviewAt) {
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

  async function saveUncertainSteer(binding, instruction, progress, evidence, reviewAt) {
    try {
      return await saveSteerCheckpoint(binding, instruction, progress, evidence, reviewAt);
    } catch (error) {
      return `\nCheckpoint warning: ${error.message}.${await reconcileCacheAfterWriteFailure()}`;
    }
  }

  async function refreshObservedLocation(binding, agent) {
    if (!agent || identityMismatch(binding, agent, agent) || agent.terminal_id === binding.terminalId) {
      return binding;
    }
    const refreshed = await refreshWorkerLocation(binding, captureIdentity(agent));
    cacheBinding(refreshed);
    return { ...refreshed, ...runtimeFor(refreshed) };
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

  function clearRecoveredWatchError(watch) {
    if (!watch.lastError) return;
    const diagnostic = `Could not observe ${watch.source} ${watch.subject}: ${watch.lastError}`;
    if (lastBackgroundError === diagnostic) lastBackgroundError = "";
    watch.lastError = undefined;
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

  pi.registerFlag("supervisor-external-watch-ms", {
    description: "Interval for deterministic external PR and build observations",
    type: "string",
    default: process.env.HERDR_SUPERVISOR_EXTERNAL_WATCH_MS || String(DEFAULT_EXTERNAL_WATCH_INTERVAL_MS),
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

  function externalWatchIntervalMs() {
    const value = Number(pi.getFlag("supervisor-external-watch-ms"));
    return Number.isFinite(value) && value >= 1000 ? value : DEFAULT_EXTERNAL_WATCH_INTERVAL_MS;
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
    const watchDeadlines = externalPoll.active ? [] : goals.active
      .map((goal) => goal.externalWatch?.nextPollAt)
      .filter((deadline): deadline is number => deadline !== undefined);
    const watchDelay = watchDeadlines.length
      ? Math.max(0, Math.min(...watchDeadlines) - Date.now())
      : undefined;
    const delay = reviewDelay === undefined
      ? watchDelay
      : watchDelay === undefined ? reviewDelay : Math.min(reviewDelay, watchDelay);
    if (delay === undefined) return;
    reviewTimer = setTimeout(() => {
      reviewTimer = undefined;
      void runScheduledObservations().catch((error) => reportBackgroundFailure("Could not run the scheduled worker review", error));
    }, Math.min(delay, 2_147_483_647));
    reviewTimer.unref?.();
  }

  async function runScheduledObservations() {
    try {
      await externalPoll.run(reviewDueWorkers, pollDueExternalWatches);
    } finally {
      await armReviewTimer();
    }
  }

  async function pollDueExternalWatches() {
    const goals = await activeBindings();
    const now = Date.now();
    const due = goals.active.filter((goal) => goal.externalWatch && goal.externalWatch.nextPollAt <= now);
    if (!due.length) return;
    const observations = await observeExternalWatches(due.map((goal) => ({
      goalId: goal.goalId,
      source: goal.externalWatch!.source,
      subject: goal.externalWatch!.subject,
      revision: goal.externalWatch!.revision,
    })));
    for (const observation of observations) {
      const binding = goalCache?.active.get(observation.goalId);
      if (!binding) continue;
      const runtime = runtimeFor(binding);
      const watch = runtime.externalWatch;
      if (
        !watch
        || watch.source !== observation.source
        || watch.subject !== observation.subject
        || watch.revision !== observation.revision
      ) continue;
      watch.nextPollAt = Date.now() + Math.max(
        externalWatchIntervalMs(),
        observation.retryAfterMs || 0,
      );
      if (!observation.ok) {
        if (watch.lastError !== observation.error) {
          watch.lastError = observation.error;
          reportBackgroundFailure(
            `Could not observe ${watch.source} ${watch.subject}`,
            new Error(observation.error || "unknown provider failure"),
          );
        }
        continue;
      }
      clearRecoveredWatchError(watch);
      if (!observation.changed) {
        watch.revision = observation.observedRevision;
        continue;
      }
      const observedAt = new Date().toISOString();
      const state = await recordExternalChange(binding, {
        source: watch.source,
        subject: watch.subject,
        revision: observation.observedRevision,
        observedAt,
      });
      watch.revision = observation.observedRevision;
      cacheCheckpoint(binding, state);
      handleSignal(binding.paneId, {
        force: true,
        reason: `${observation.summary}. This external change is only a wake hint; have the same worker reread authoritative state before deciding what it means.`,
        key: `external:${watch.source}:${watch.subject}:${watch.revision}`,
      });
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

  function queueSignal(paneId: string, signal: ReviewSignal) {
    if (!pendingSignals.has(paneId) || signal.force) pendingSignals.set(paneId, signal);
  }

  async function wakeDependentWaiters(paneId: string, reason: string) {
    const goals = await activeBindings();
    for (const binding of dependentBindings(goals.active, paneId)) {
      if (runtimeFor(binding).awaitingHuman) continue;
      handleSignal(binding.paneId, {
        force: true,
        reason,
        key: `peer:${paneId}:${++workerEventSequence}`,
      });
    }
  }

  async function handleWorkerEvent(paneId: string) {
    handleSignal(paneId);
    await wakeDependentWaiters(
      paneId,
      `supervised worker ${paneId} changed; reconsider whether useful work can proceed`,
    );
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
    if (shuttingDown || reviewPumpRunning || agentTurnActive || reviewTurn.isActive() || activeGlobalReview) return;
    reviewPumpRunning = true;
    try {
      while (!shuttingDown && !reviewTurn.isActive() && !activeGlobalReview && pendingSignals.size) {
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
      if (!shuttingDown && !reviewTurn.isActive() && !activeGlobalReview && !pendingSignals.size && pendingGlobalReview) {
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
    const [goals, snapshot] = await Promise.all([activeBindings(), client.snapshot()]);
    const compactSnapshot = buildGlobalSnapshot(goals.active, snapshot, {
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
        content: globalReviewMessage(compactSnapshot, reason),
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
    const [stored, snapshot] = await Promise.all([bindingForPane(paneId), client.snapshot()]);
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
    const change = binding.externalChange;
    const decision = change && !mismatch && !signal?.key.startsWith("external:")
      ? {
          wake: true,
          reason: `${change.source} ${change.subject} changed and its authoritative reread is still pending. Have the same worker reread it before deciding what the change means.`,
          sequence: agent ? Number(agent.state_change_seq || 0) : undefined,
          key: `external-pending:${change.source}:${change.subject}:${change.revision}:${agent?.state_change_seq || "missing"}`,
        }
      : signaledDecision;
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
    if (!decision.wake || runtime.lastNoticeKey === decision.key) return;
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
          content: `${reviewMessage(binding, agent, decision.reason)}\n\nSupervisor mode: ${currentMode}.`,
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
    const goals = await activeBindings();
    const objective = params.goal.trim();
    const acceptance = params.acceptance.map((item) => item.trim()).filter(Boolean);
    const context = (params.context || []).map((item) => item.trim()).filter(Boolean);
    const constraints = (params.constraints || []).map((item) => item.trim()).filter(Boolean);
    if (!objective) throw new Error("The goal cannot be empty.");
    if (!acceptance.length) throw new Error("At least one concrete completion criterion is required.");
    const existing = goals.active.find((binding) => binding.goal.trim() === objective);
    if (existing) return { binding: existing, existing: true, warning: "" };

    if (typeof params.working_directory !== "string") {
      throw new Error("The worker working_directory is required and must be an absolute path.");
    }
    const cwd = params.working_directory.trim();
    if (!isAbsolute(cwd)) {
      throw new Error("The worker working_directory must be an absolute path.");
    }
    let installed = goals.unstarted.find((record) => record.contract.objective.trim() === objective);
    if (!installed) {
      installed = await installSupervisorGoal({
        objective,
        acceptance,
        context,
        constraints,
      });
      goalCache?.unstarted.push(installed);
    }
    const goalId = installed.goalId;
    const workerName = workerNameForGoal(goalId);
    let paneId = pendingStarts.get(goalId);
    const retryingPendingStart = Boolean(paneId);
    if (!paneId) {
      const supervisorPane = process.env.HERDR_PANE_ID;
      if (!supervisorPane) throw new Error("Start the supervisor inside a Herdr pane before creating a worker.");
      const direction = params.direction === "down" ? "down" : "right";
      const snapshot = await client.snapshot();
      const supervisor = findPane(snapshot, supervisorPane);
      if (!supervisor) throw new Error(`The supervisor pane ${supervisorPane} is not present in Herdr.`);
      const pendingAgent = snapshot.agents?.find(
        (agent) => agent.name === workerName && agent.workspace_id === supervisor.workspace_id,
      );
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
    description: "Create one Codex worker, give it one explicit goal and completion criteria, and supervise it. Use for a direct human request that needs durable work. Continue a matching existing goal instead of calling this tool again. The worker, not the supervisor, chooses and manages any Git worktrees needed by the goal.",
    parameters: Type.Object({
      goal: Type.String({ minLength: 1, description: "The durable outcome the worker must fully achieve." }),
      context: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
        maxItems: 10,
        description: "Durable facts the worker needs to pursue this goal. Keep transient worker state, credentials, waits, and coordination in current evidence instead.",
      })),
      acceptance: Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        maxItems: 10,
        description: "Concrete evidence that proves the goal is complete.",
      }),
      constraints: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
        maxItems: 10,
        description: "Boundaries the worker must preserve, such as using isolated worktrees in a shared repository.",
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
      direction: Type.Optional(Type.Union([Type.Literal("right"), Type.Literal("down")], { description: "Where to place the worker pane. Defaults to right." })),
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
      context: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
        maxItems: 10,
        description: "The complete revised set of durable facts needed to pursue the goal. Exclude transient execution evidence.",
      })),
      acceptance: Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        maxItems: 10,
        description: "The complete revised set of concrete completion criteria.",
      }),
      constraints: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
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
        cacheBinding(result.binding);
        stopExternalWatch(result.binding);
        scheduleReview(result.binding);
        let deliveryWarning = "";
        if (mode() === "live") {
          try {
            const snapshot = await client.snapshot();
            const agent = findAgent(snapshot, binding.paneId);
            const mismatch = identityMismatch(
              result.binding,
              agent,
              findPane(snapshot, binding.paneId),
            );
            if (mismatch) {
              deliveryWarning = ` The durable contract was updated, but it was not sent because ${mismatch}.`;
            } else if (typeof agent.name !== "string" || !agent.name.trim()) {
              deliveryWarning = " The durable contract was updated, but it was not sent because the Herdr worker has no stable name.";
            } else {
              await client.promptAgent(binding.paneId, refinedGoalPrompt(result.binding, agent.name));
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
    parameters: Type.Object({ pane_id: Type.Optional(Pane) }),
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
    description: "Schedule one focused event review for each affected existing goal. Use when the human supplies transient evidence, resolves a wait, or asks the supervisor to recheck current execution. The LLM selects the exact affected workers; code only queues their normal reviews. If human input arrives during another worker's focused review, retain these reviews for afterward and still finish the current review with one decision. This does not rewrite a durable goal or prompt a worker directly.",
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
          reason: `the human supplied new execution information: ${params.reason.trim()}`,
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
    description: "Finish the current compact all-goal review. Findings report relationships or system problems and name the goals they concern; they do not schedule work. Put only goals that actually need a fresh one-goal decision in reconsider. This tool never prompts or changes workers directly.",
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
      next_review_at: Type.Optional(Type.String({ minLength: 1 })),
    }),
    executionMode: "sequential",
    async execute(_id, params) {
      if (!activeGlobalReview) return text("No global supervision review is active.", true);
      if (globalDecisionApplied) return text("The global supervision review already has a result.", true);
      const goals = await activeBindings();
      const byGoalId = new Map(goals.active.map((binding) => [binding.goalId, binding]));
      const referenced = new Set([
        ...params.findings.flatMap((finding) => finding.affected_goal_ids),
        ...params.reconsider.map((item) => item.goal_id),
      ]);
      const unknown = [...referenced].filter((goalId) => !byGoalId.has(goalId));
      if (unknown.length) {
        return text(`Cannot route the global result because these goals are not active: ${unknown.join(", ")}. No focused reviews were queued.`, true);
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
      const isNewFinding = findings.length > 0 && findingHash !== globalState.lastFindingHash;
      const nextState = {
        version: 1,
        lastReviewedAt: now.toISOString(),
        nextReviewAt,
        snapshotHash: globalState.snapshotHash,
        lastFindingHash: findings.length ? findingHash : globalState.lastFindingHash,
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
          content: `Supervisor health review\n${params.summary.trim()}\n\n${findings.map((finding) => `- ${finding.problem}\n  Evidence: ${finding.evidence.join("; ")}\n  Affects: ${finding.affectedGoalIds.join(", ")}`).join("\n")}`,
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
    parameters: Type.Object({ pane_id: Pane, lines: Type.Optional(Type.Integer({ minimum: 10, maximum: 200 })) }),
    executionMode: "parallel",
    async execute(_id, params) {
      const fenceError = reviewTurn.beginObservation(params.pane_id);
      if (fenceError) return text(fenceError, true);
      let observed = false;
      try {
        const [binding, snapshot] = await Promise.all([bindingForPane(params.pane_id), client.snapshot()]);
        if (!binding) return text(`${params.pane_id} is not supervised.`, true);
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
        let currentBinding: GoalBinding = binding;
        if (externalRereadObserved(binding, observation)) {
          const state = await clearExternalChange(binding);
          cacheCheckpoint(binding, state);
          currentBinding = goalCache?.active.get(binding.goalId) || binding;
        }
        const runtime = runtimeFor(currentBinding);
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
    description: "Record acceptable progress and take no worker action until its next event or a bounded review. Leave a working worker as working and omit waiting_for; its next checkpoint belongs in progress. A settled worker may be left alone only when waiting_for names a concrete peer or external condition. For one exact GitHub PR or ADO build, external_watch lets small in-process code observe revision changes without model turns; the external event is only a wake hint and the worker must reread authority. The runtime uses the normal review interval unless review_at supplies a real exact retry time. At that review, confirm the condition still exists, seek a safe mitigation or independent useful work, and continue the worker whenever anything can move. Do not extend the same wait unless fresh current evidence establishes why and supplies the next boundary.",
    parameters: Type.Object({
      pane_id: Pane,
      progress: Type.String({ minLength: 1 }),
      waiting_for: Type.Optional(Type.String({ minLength: 1, description: "Concrete peer or external condition that can resume a settled worker." })),
      waiting_on_pane: Type.Optional(Type.String({ minLength: 1, description: "Exact different supervised worker whose change should wake this wait. Omit for self or external waits." })),
      external_watch: Type.Optional(Type.Union([
        Type.Object({
          source: Type.Literal("github-pr"),
          subject: Type.String({ minLength: 1, maxLength: 2000, pattern: "^[^/]+/[^/#]+#[1-9][0-9]*$", description: "Exact GitHub identity: owner/repository#number." }),
          revision: Type.Optional(Type.String({ minLength: 1, maxLength: 2000, description: "Last revision already observed, when known. Omit it to establish a quiet baseline." })),
        }),
        Type.Object({
          source: Type.Literal("ado-build"),
          subject: Type.String({ minLength: 1, maxLength: 2000, pattern: "^[^/]+/[^/]+/[1-9][0-9]*$", description: "Exact ADO identity: organization/project/build-id." }),
          revision: Type.Optional(Type.String({ minLength: 1, maxLength: 2000, description: "Last revision already observed, when known. Omit it to establish a quiet baseline." })),
        }),
      ], { description: "Optional deterministic observation for the exact external condition. It does not prove completion." })),
      evidence: Evidence,
      review_at: Type.Optional(Type.String({ minLength: 1, description: "Optional exact ISO 8601 retry time no more than 24 hours ahead. Omit it to use the normal bounded review interval." })),
    }),
    executionMode: "sequential",
    async execute(_id, params) {
      const fenceError = reviewTurn.guardDecision(params.pane_id);
      if (fenceError) return text(fenceError, true);
      const [binding, snapshot] = await Promise.all([bindingForPane(params.pane_id), client.snapshot()]);
      if (!binding) return text(`${params.pane_id} is not supervised.`, true);
      if (binding.externalChange) {
        return text("The watched external resource changed, but this worker has not reread it yet. Continue the same worker to read current authority before deciding whether to wait again.", true);
      }
      const agent = findAgent(snapshot, params.pane_id);
      const mismatch = identityMismatch(binding, agent, findPane(snapshot, params.pane_id));
      if (mismatch) return text(`Cannot leave this worker working: ${mismatch}.`, true);
      const waitingFor = params.waiting_for?.trim();
      const waitingOnPane = params.waiting_on_pane?.trim();
      const externalWatch = params.external_watch;
      let effectiveWaitingOnPane = waitingOnPane;
      let warning = "";
      if (waitingOnPane && !waitingFor) {
        return text("waiting_on_pane requires a concrete waiting_for condition.", true);
      }
      if (externalWatch && !waitingFor) {
        return text("external_watch requires a concrete waiting_for condition.", true);
      }
      if (waitingOnPane === params.pane_id) {
        effectiveWaitingOnPane = undefined;
        warning = "\nPeer wake warning: ignored a self-reference; the bounded review deadline remains active.";
      }
      if (externalWatch && effectiveWaitingOnPane) {
        return text("Choose either waiting_on_pane or external_watch for one wait, not both.", true);
      }
      if (agent.agent_status === "working" && waitingFor) {
        return text("A working worker is active, not waiting. Omit waiting_for and record its next checkpoint in progress; use waiting_for only after the worker settles on a concrete external or peer condition.", true);
      }
      const previousReviewAt = Date.parse(binding.wait?.reviewAt || "");
      if (
        waitingFor
        && !binding.wait?.paneId
        && agent.agent_status !== "working"
        && Number.isFinite(previousReviewAt)
        && previousReviewAt <= Date.now()
        && runtimeFor(binding).pendingObservationHasMessages === false
      ) {
        return text("Cannot extend this expired external wait without fresh worker evidence. Continue the same worker to check the condition now, or choose another concrete action.", true);
      }
      if (effectiveWaitingOnPane) {
        const peerPane = effectiveWaitingOnPane;
        const peer = await bindingForPane(peerPane);
        if (!peer) {
          warning = `\nPeer wake warning: ignored unknown worker ${peerPane}; the bounded review deadline remains active.`;
          effectiveWaitingOnPane = undefined;
        } else {
          const peerAgent = findAgent(snapshot, peerPane);
          const peerProblem = identityMismatch(peer, peerAgent, findPane(snapshot, peerPane));
          if (peerProblem || peerAgent?.agent_status !== "working") {
            const peerState = peerProblem || `worker is ${peerAgent?.agent_status || "not running"}`;
            return text(`Cannot leave ${params.pane_id} waiting on ${peerPane} because ${peerState}. Shared capacity is not reserved by an inactive worker; choose useful work that can proceed or name the real external blocker.`, true);
          }
        }
      }
      if (agent.agent_status !== "working" && !waitingFor) {
        return text(`Cannot leave ${params.pane_id} alone because it is ${agent.agent_status} and no concrete wait condition was supplied. Choose a real next action or name what can resume it.`, true);
      }
      const reviewAt = params.review_at?.trim()
        || (waitingFor ? new Date(Date.now() + reviewIntervalMs()).toISOString() : undefined);
      let deadline: number | undefined;
      try {
        if (reviewAt) deadline = reviewDeadline(reviewAt);
      } catch (error) {
        return text(`Cannot schedule review_at ${reviewAt}; ${error.message}.`, true);
      }
      const progress = waitingFor
        ? `${params.progress.trim()}\nWaiting for: ${waitingFor}`
          + (externalWatch ? `\nExternal watch target: ${externalWatch.source} ${externalWatch.subject.trim()}` : "")
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
            ...(effectiveWaitingOnPane ? { paneId: effectiveWaitingOnPane } : {}),
          } : undefined,
          reviewAt: waitingFor ? undefined : params.review_at?.trim(),
          evidence: params.evidence || binding.evidence,
          observationCursor: runtimeFor(binding).pendingCursor,
        });
        cacheCheckpoint(binding, result.state);
        const runtime = runtimeFor(binding);
        runtime.pendingCursor = undefined;
        if (externalWatch) {
          const previous = runtime.externalWatch;
          runtime.externalWatch = {
            source: externalWatch.source,
            subject: externalWatch.subject.trim(),
            revision: externalWatch.revision?.trim()
              || (previous?.source === externalWatch.source
                && previous.subject === externalWatch.subject.trim()
                ? previous.revision
                : undefined),
            nextPollAt: Date.now(),
          };
        } else {
          clearExternalWatch(binding);
        }
        if (result.auditError) warning += `\nAudit warning: ${result.auditError.message}`;
      }
      scheduleReview(binding, deadline ? deadline - Date.now() : reviewIntervalMs());
      reviewTurn.close(params.pane_id);
      try { await armReviewTimer(); }
      catch (error) { warning += `\nReview timer warning: ${error.message}`; }
      const state = waitingFor ? `waiting for ${waitingFor}` : "working";
      const watching = externalWatch
        ? `\nWatching ${externalWatch.source} ${externalWatch.subject.trim()} between model turns.`
        : "";
      return text(`${mode() === "live" ? "Left" : `${mode()} mode: would leave`} ${params.pane_id} ${state}.\n${progress}${watching}${warning}\n\nEnd this supervisor turn now.`);
    },
  });

  pi.registerTool({
    name: "supervisor_steer",
    label: "Continue worker",
    description: "Give the same supervised worker one useful next action. If its exact registered process exited but the pane is unchanged, the runtime resumes that session automatically; the model does not choose a transport.",
    parameters: Type.Object({
      pane_id: Pane,
      message: Type.String({ minLength: 1 }),
      evidence: Evidence,
      review_at: Type.Optional(Type.String({ minLength: 1, description: "Optional exact ISO 8601 time, no more than 24 hours ahead, when this instruction must be reconsidered even if the worker still appears busy. Omit it for routine event-driven supervision." })),
    }),
    executionMode: "sequential",
    async execute(_id, params) {
      const fenceError = reviewTurn.guardDecision(params.pane_id);
      if (fenceError) return text(fenceError, true);
      try {
        const [binding, snapshot] = await Promise.all([bindingForPane(params.pane_id), client.snapshot()]);
        if (!binding) return text(`${params.pane_id} is not supervised.`, true);
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
        const canResume = !agent && pane?.terminal_id === binding.terminalId;
        if (mismatch && !canResume) return text(`Refusing to continue: ${mismatch}.`, true);
        if (mode() !== "live") {
          reviewTurn.close(params.pane_id);
          const action = canResume ? `resume the exact ${binding.agentSession.agent} session in` : "prompt";
          return text(`${mode()} mode: would ${action} ${params.pane_id}: ${params.message.trim()}\n\nEnd this supervisor turn now. Wait for Herdr's next worker event; do not poll.`);
        }
        let continuedBinding = binding;
        let resumed = false;
        const instruction = workerInstruction(binding, params.message);
        if (canResume) {
          const request = recoveryRequest(binding, snapshot);
          // An interrupted native Codex Goal is paused by design. Resume that
          // lifecycle explicitly before queuing the supervisor's fresh
          // steering; otherwise Codex waits at an interactive "Resume goal?"
          // gate and the apparently recovered worker never moves.
          request.args = [...codexLaunchArgs(), ...request.args, "/goal resume"];
          let resumeAccepted = false;
          let resumedAgent;
          try {
            resumedAgent = await client.startAndWaitAgent(request, 30_000, () => {
              resumeAccepted = true;
              reviewTurn.close(params.pane_id);
            });
          } catch (error) {
            if (!resumeAccepted) throw error;
            stopExternalWatch(binding);
            scheduleReview(binding);
            return text(`Herdr accepted the exact-session resume for ${params.pane_id}, but the worker did not become ready: ${error.message}.\n\nDo not resume it again. End this supervisor turn now and wait for fresh worker evidence.`, true);
          }
          const resumedMismatch = identityMismatch(binding, resumedAgent, resumedAgent);
          if (resumedMismatch) {
            reviewTurn.close(params.pane_id);
            stopExternalWatch(binding);
            scheduleReview(binding);
            return text(`The exact-session resume ran, but the resulting worker identity did not match: ${resumedMismatch}. No further message was sent.\n\nEnd this supervisor turn now; do not retry without fresh evidence.`, true);
          }
          continuedBinding = await refreshObservedLocation(binding, resumedAgent);
          resumed = true;
          try {
            await client.promptAgent(params.pane_id, instruction);
          } catch (error) {
            stopExternalWatch(continuedBinding);
            scheduleReview(continuedBinding);
            const checkpointWarning = await saveUncertainSteer(
              continuedBinding,
              instruction,
              "The exact session resumed, but delivery of its next instruction is uncertain; fresh worker evidence is required.",
              params.evidence || continuedBinding.evidence,
              reviewAt,
            );
            return text(`Resumed the exact native Goal in ${params.pane_id}, but could not confirm whether it received the follow-up instruction: ${error.message}.${checkpointWarning}\n\nDo not send it again in this turn. End this supervisor turn now and wait for fresh worker evidence.`, true);
          }
        } else {
          try {
            await client.promptAgent(params.pane_id, instruction);
          } catch (error) {
            // A transport error cannot prove that Herdr did not accept the
            // prompt. Fail closed against duplicate delivery.
            reviewTurn.close(params.pane_id);
            stopExternalWatch(binding);
            scheduleReview(binding);
            const checkpointWarning = await saveUncertainSteer(
              binding,
              instruction,
              "Instruction delivery is uncertain; fresh worker evidence is required before another decision.",
              params.evidence || binding.evidence,
              reviewAt,
            );
            return text(`Could not confirm whether ${params.pane_id} received the instruction: ${error.message}.${checkpointWarning}\n\nDo not send it again in this turn. Wait for fresh worker evidence.`, true);
          }
        }
        // The worker action has happened. Close the turn before bookkeeping so
        // a checkpoint failure cannot cause the model to send it twice.
        reviewTurn.close(params.pane_id);
        stopExternalWatch(continuedBinding);
        try {
          const warning = await saveSteerCheckpoint(
            continuedBinding,
            instruction,
            resumed
              ? "The exact native session was resumed and asked to continue."
              : `The worker was steered to continue: ${params.message.trim()}`,
            params.evidence || continuedBinding.evidence,
            reviewAt,
          );
          scheduleReview(continuedBinding, deadline ? deadline - Date.now() : reviewIntervalMs());
          const resultText = resumed
            ? `Resumed the exact ${binding.agentSession.agent} session and native Goal in ${params.pane_id}, then asked it to continue.`
            : `Steered ${params.pane_id}: ${params.message.trim()}`;
          return text(`${resultText}${warning}\n\nEnd this supervisor turn now. Wait for Herdr's next worker event; do not poll.`);
        } catch (error) {
          const reloadWarning = await reconcileCacheAfterWriteFailure();
          scheduleReview(continuedBinding);
          return text(`Continued ${params.pane_id}, but could not save the checkpoint: ${error.message}.${reloadWarning}\n\nDo not send the instruction again. End this supervisor turn now and wait for fresh worker evidence.`);
        }
      } catch (error) { return text(`Could not continue worker: ${error.message}`, true); }
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
      review_at: Type.Optional(Type.String({ minLength: 1, description: "Bounded time to reconsider whether the human answer is still required or useful work can proceed without it." })),
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
        clearExternalWatch(binding);
        if (result.auditError) warning = `\nAudit warning: ${result.auditError.message}`;
      }
      const runtime = runtimeFor(binding);
      runtime.awaitingHuman = true;
      clearExternalWatch(binding);
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
      if (binding.externalChange) {
        return text("The watched external resource changed, but this worker has not reread it yet. Continue the same worker before accepting the goal.", true);
      }
      if (mode() !== "live") {
        reviewTurn.close(params.pane_id);
        return text(`${mode()} mode: evidence supports accepting ${params.pane_id}, but its goal binding remains active.\n${params.summary}\n\nEnd this supervisor turn now. Wait for Herdr's next worker event; do not poll.`);
      }
      const result = await recordDecision(binding, "accept", {
        progress: params.summary.trim(),
        action: "Accepted the verified goal.",
        evidence: params.evidence,
        observationCursor: runtimeFor(binding).pendingCursor,
        terminal: { state: "accepted", summary: params.summary.trim() },
      });
      runtimeFor(binding).pendingCursor = undefined;
      cacheCheckpoint(binding, result.state);
      reviewTurn.close(params.pane_id);
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
        } catch (error) {
          const reloadWarning = await reconcileCacheAfterWriteFailure();
          return ctx.ui.notify(`Could not save the request to stop supervising ${paneId}: ${error.message}.${reloadWarning}`, "error");
        }
        cacheCheckpoint(binding, result.state);
        await wakeDependentWaiters(
          paneId,
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

  pi.on("before_agent_start", (event) => {
    agentTurnActive = true;
    return { systemPrompt: supervisorSystemPrompt(event.systemPrompt) };
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
        if (insideOldReview && message.role === "user") insideOldReview = false;
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
    if (activeGlobalReview) {
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
        armGlobalReviewTimer();
      }
      await drainSignals();
      await armReviewTimer();
      armGlobalReviewTimer();
      return;
    }
    const reviewedPane = reviewTurn.isActive() ? reviewTurn.paneId : undefined;
    const decisionApplied = reviewTurn.isClosed();
    agentTurnActive = false;
    reviewTurn.end();
    if (reviewedPane) {
      const binding = await bindingForPane(reviewedPane);
      if (binding) {
        const runtime = runtimeFor(binding);
        if (decisionApplied) {
          runtime.missingDecisionRetries = 0;
        } else if (runtime.missingDecisionRetries < 1) {
          runtime.missingDecisionRetries += 1;
          handleSignal(reviewedPane, {
            force: true,
            reason: "the previous review ended without an explicit decision",
            key: `missing-decision:${binding.goalId}:${runtime.missingDecisionRetries}:${Date.now()}`,
          });
        } else {
          runtime.missingDecisionRetries = 0;
          if (!runtime.awaitingHuman) scheduleReview(binding);
        }
      }
      if (decisionApplied) {
        await wakeDependentWaiters(
          reviewedPane,
          `supervisor decision for ${reviewedPane} changed; reconsider whether useful work can proceed`,
        );
      }
    }
    await drainSignals();
    await armReviewTimer();
  });

  pi.on("session_shutdown", () => {
    shuttingDown = true;
    stopSubscription?.();
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (reviewTimer) clearTimeout(reviewTimer);
    if (globalReviewTimer) clearTimeout(globalReviewTimer);
    pendingSignals.clear();
    pendingStarts.clear();
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
