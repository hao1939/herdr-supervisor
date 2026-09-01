import { canRecoverAgentSession, sameAgentSession } from "./identity.ts";

export const DEFAULT_REVIEW_INTERVAL_MS = 60 * 60 * 1000;
const MAX_REVIEW_DELAY_MS = 24 * 60 * 60 * 1000;
const ISO_8601_WITH_TIMEZONE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function validCalendarTime(match) {
  const [, year, month, day, hour, minute, second] = match;
  const value = new Date(0);
  value.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  value.setUTCHours(Number(hour), Number(minute), Number(second), 0);
  return value.getUTCFullYear() === Number(year)
    && value.getUTCMonth() === Number(month) - 1
    && value.getUTCDate() === Number(day)
    && value.getUTCHours() === Number(hour)
    && value.getUTCMinutes() === Number(minute)
    && value.getUTCSeconds() === Number(second);
}

export function reviewDeadline(reviewAt, now = Date.now()) {
  const match = ISO_8601_WITH_TIMEZONE.exec(reviewAt);
  const deadline = Date.parse(reviewAt);
  if (
    !match
    || !validCalendarTime(match)
    || !Number.isFinite(deadline)
    || deadline < now + 1000
    || deadline > now + MAX_REVIEW_DELAY_MS
  ) {
    throw new Error("review time must be a timezone-bearing ISO 8601 timestamp between one second and 24 hours from now");
  }
  return deadline;
}

export function findAgent(snapshot, paneId) {
  return snapshot?.agents?.find((agent) => agent.pane_id === paneId);
}

export function findPane(snapshot, paneId) {
  return snapshot?.panes?.find((pane) => pane.pane_id === paneId);
}

export function captureIdentity(agent) {
  if (!agent?.pane_id || !agent?.terminal_id || !agent?.agent_session) {
    throw new Error("the pane does not contain an observable agent session");
  }
  return {
    paneId: agent.pane_id,
    terminalId: agent.terminal_id,
    agentSession: { ...agent.agent_session },
  };
}

export function identityMismatch(binding, agent, pane?) {
  if (!agent && !pane) return "worker pane is no longer present";
  if (!agent && pane.terminal_id !== binding.terminalId) return "pane now refers to a different terminal";
  if (!agent) return "worker agent process is no longer detected";
  const expected = binding.agentSession;
  const actual = agent.agent_session;
  if (!actual) return "worker has no native agent-session identity";
  if (!sameAgentSession(actual, expected)) {
    const field = ["source", "agent", "kind", "value"].find((key) => actual[key] !== expected[key]);
    return `worker ${field} changed`;
  }
  return undefined;
}

export function dueBindings(workers, now = new Date()) {
  const timestamp = now.getTime();
  return workers.filter((worker) => {
    const deadline = Date.parse(worker.nextReviewAt || "");
    return !Number.isFinite(deadline) || deadline <= timestamp;
  });
}

export function nextReviewDelay(workers, now = new Date()) {
  if (!workers.length) return undefined;
  const timestamp = now.getTime();
  const deadlines = workers.map((worker) => Date.parse(worker.nextReviewAt || ""));
  if (deadlines.some((deadline) => !Number.isFinite(deadline))) return 0;
  return Math.max(0, Math.min(...deadlines) - timestamp);
}

export function dependentBindings(workers, peer) {
  return workers.filter((worker) => (
    worker.goalId !== peer.goalId
    && (
      (peer.goalId && worker.wait?.goalId === peer.goalId)
      || (!worker.wait?.goalId && worker.wait?.paneId === peer.paneId)
    )
  ));
}

export function liveWorker(binding, snapshot) {
  const agent = findAgent(snapshot, binding.paneId);
  const pane = findPane(snapshot, binding.paneId);
  return {
    binding,
    agent,
    mismatch: identityMismatch(binding, agent, pane),
  };
}

export function shouldWake(binding, agent, pane) {
  const mismatch = identityMismatch(binding, agent, pane);
  if (mismatch) return { wake: true, reason: mismatch, sequence: undefined, key: `identity:${mismatch}` };
  const sequence = Number(agent.state_change_seq || 0);
  if (binding.legacyExternalChange) {
    const change = binding.legacyExternalChange;
    return {
      wake: true,
      reason: `${change.source} ${change.subject} changed before the metadata watcher upgrade; have this worker reread current provider authority`,
      sequence,
      key: `legacy-external:${change.source}:${change.subject}:${change.revision}`,
    };
  }
  if (sequence > 0 && sequence <= Number(binding.lastReviewStateChangeSeq || 0)) {
    return { wake: false, reason: "transition already reviewed", sequence, key: `state:${sequence}` };
  }
  if (agent.agent_status === "working") {
    return { wake: false, reason: "worker is working", sequence, key: `state:${sequence}:working` };
  }
  return {
    wake: true,
    reason: `worker is ${agent.agent_status}`,
    sequence,
    key: `state:${sequence}:${agent.agent_status}`,
  };
}

export function recoveryRequest(binding, snapshot) {
  const agent = findAgent(snapshot, binding.paneId);
  const pane = findPane(snapshot, binding.paneId);
  const mismatch = identityMismatch(binding, agent, pane);
  if (agent) throw new Error(mismatch || "the registered worker is still present");
  if (!pane) throw new Error("the registered worker pane is no longer present");
  if (pane.terminal_id !== binding.terminalId) throw new Error("the pane now refers to a different terminal");
  const session = binding.agentSession;
  if (!canRecoverAgentSession(session)) {
    throw new Error(`exact recovery is not available for ${session.agent} ${session.kind} sessions`);
  }
  return {
    name: "codex",
    kind: "codex",
    paneId: binding.paneId,
    args: ["resume", session.value],
  };
}

function compact(value, limit) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

export function formatWorker({ binding, agent, mismatch }, { detailed = true } = {}) {
  const processStopped = mismatch === "worker agent process is no longer detected";
  const paneMissing = mismatch === "worker pane is no longer present";
  const terminalReplaced = mismatch === "pane now refers to a different terminal";
  const sessionRecoverable = canRecoverAgentSession(binding.agentSession);
  const workerUnavailable = !agent && Boolean(mismatch);
  const routingRecoverable = !agent && sessionRecoverable;
  const awaitingHuman = binding.lastDecision?.decision === "ask_human";
  const goalState = workerUnavailable && awaitingHuman
    ? "waiting for you"
    : mismatch
    ? "needs attention"
    : awaitingHuman
      ? "waiting for you"
      : binding.wait
        ? "waiting"
        : agent.agent_status === "working"
          ? "working"
          : "needs review";
  const workerState = processStopped
    ? "process stopped"
    : paneMissing
      ? "pane missing"
    : terminalReplaced
      ? "terminal replaced"
    : mismatch
      ? "identity changed"
      : agent.agent_status === "done"
        ? "turn finished"
        : agent.agent_status;
  const goalLabel = binding.goalId ? `Goal ${binding.goalId}` : "Goal";
  const worker = `${binding.agentSession.agent} ${binding.paneId}`;
  const goal = detailed ? binding.goal : compact(binding.goal, 240);
  const lines = [
    `${goalLabel} · ${goalState}`,
    `  Objective: ${goal}`,
    `  Worker: ${worker} · ${workerState}`,
  ];
  if (detailed && binding.acceptance.length) lines.push(`  Accept when: ${binding.acceptance.join("; ")}`);
  if (binding.progress) lines.push(`  Progress: ${detailed ? binding.progress : compact(binding.progress, 600)}`);
  if (workerUnavailable && awaitingHuman) {
    lines.push(sessionRecoverable
      ? "  Next: answer the supervisor's question above; worker recovery can follow your answer"
      : "  Next: answer the supervisor's question above; afterward the unsupported worker session still needs repair");
    const reviewAt = binding.wait?.reviewAt || binding.nextReviewAt;
    if (reviewAt) lines.push(`  Supervisor rechecks at: ${reviewAt}`);
  } else if (routingRecoverable) lines.push(paneMissing
    ? "  Next: supervisor should review whether the exact session can resume in a new pane"
    : "  Next: supervisor should review whether the exact session can resume");
  else if (mismatch) lines.push(`  Needs you: ${mismatch}; supervision is paused`);
  else if (awaitingHuman) {
    lines.push("  Next: answer the supervisor's question above");
    const reviewAt = binding.wait?.reviewAt || binding.nextReviewAt;
    if (reviewAt) lines.push(`  Supervisor rechecks at: ${reviewAt}`);
  }
  else if (agent.agent_status === "working") {
    lines.push("  Next: review when the worker settles or blocks");
    if (binding.reviewAt) lines.push(`  Supervisor rechecks at: ${binding.reviewAt}`);
  }
  else if (binding.wait) {
    const condition = detailed ? binding.wait.condition : compact(binding.wait.condition, 360);
    lines.push(`  Next: wait for ${condition}`);
    lines.push(`  Review at: ${binding.wait.reviewAt}`);
  }
  else lines.push(`  Next: supervisor should review current evidence`);
  return lines.join("\n");
}
