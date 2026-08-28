export const DEFAULT_REVIEW_INTERVAL_MS = 10 * 60 * 1000;

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

export function identityMismatch(binding, agent, pane) {
  if (!agent && !pane) return "worker pane is no longer present";
  if (!agent && pane.terminal_id !== binding.terminalId) return "pane now refers to a different terminal";
  if (!agent) return "worker agent process is no longer detected";
  const expected = binding.agentSession;
  const actual = agent.agent_session;
  if (!actual) return "worker has no native agent-session identity";
  for (const field of ["source", "agent", "kind", "value"]) {
    if (actual[field] !== expected[field]) return `worker ${field} changed`;
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
  if (session.agent !== "codex" || session.kind !== "id") {
    throw new Error(`exact recovery is not available for ${session.agent} ${session.kind} sessions`);
  }
  return {
    name: "codex",
    kind: "codex",
    paneId: binding.paneId,
    args: ["resume", session.value],
  };
}

export function formatWorker({ binding, agent, mismatch }) {
  const processStopped = mismatch === "worker agent process is no longer detected";
  const state = processStopped ? "process stopped" : mismatch ? "identity changed" : agent.agent_status;
  const name = `${binding.agentSession.agent} ${binding.paneId}`;
  const goalLabel = binding.goalId ? `Goal ${binding.goalId}` : "Goal";
  const lines = [`${name} · ${state}`, `  ${goalLabel}: ${binding.goal}`];
  if (binding.acceptance.length) lines.push(`  Accept when: ${binding.acceptance.join("; ")}`);
  if (binding.progress) lines.push(`  Progress: ${binding.progress}`);
  if (binding.awaitingHuman) lines.push("  Needs you: answer the supervisor's latest question");
  if (processStopped) lines.push("  Next: supervisor should review whether the exact session can resume");
  else if (mismatch) lines.push(`  Needs you: ${mismatch}; supervision is paused`);
  else if (agent.agent_status === "working") lines.push("  Next: review when the worker settles or blocks");
  else lines.push(`  Next: supervisor should review current evidence`);
  return lines.join("\n");
}

export function reviewMessage(binding, agent, reason) {
  const criteria = binding.acceptance.length
    ? binding.acceptance.map((item) => `- ${item}`).join("\n")
    : "- The stated goal is fully achieved with convincing evidence.";
  const context = binding.context?.length ? binding.context.map((item) => `- ${item}`).join("\n") : "- No additional context.";
  const constraints = binding.constraints?.length ? binding.constraints.map((item) => `- ${item}`).join("\n") : "- No additional constraints.";
  const progress = binding.progress || "No completed review has recorded progress yet.";
  const evidence = binding.evidence?.length
    ? binding.evidence.slice(-8).map((item) => `- ${item.length > 1000 ? `${item.slice(0, 985)}…[truncated]` : item}`).join("\n")
    : "- No evidence has been preserved yet.";
  const wait = binding.wait
    ? `\n\nCurrent wait\n  ${binding.wait.condition}\n  Review at: ${binding.wait.reviewAt}`
    : "";
  return `Worker review · ${binding.agentSession.agent} ${binding.paneId}\n\nThis turn decides only goal ${binding.goalId || "(local)"}. Other supervised goals may provide coordination context through supervisor_status, but only this worker's evidence can prove this goal complete.\n\nGoal\n  ${binding.goal}\n\nRequired context\n${context}\n\nConstraints\n${constraints}\n\nCurrent progress\n  ${progress}${wait}\n\nCurrent evidence\n${evidence}\n\nWhy review now\n  ${reason}; Herdr reports ${agent?.agent_status || "missing"}.\n\nWorker acceptance criteria\n${criteria}\n\nReview\n  Observe this exact worker once. If its next action depends on another supervised worker, use supervisor_status to read current recorded peer progress; do not ask the human for information or coordination already available there. If a wait deadline elapsed, continue the due work; leave it waiting again only when fresh current evidence establishes why and supplies the next exact boundary. Then call exactly one decision tool. Your own response is not worker evidence and cannot satisfy these criteria.`;
}
