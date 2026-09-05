import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { atomicReplaceFile } from "./atomic-file.ts";
import { defaultGoalsRoot } from "./goal-store.ts";
import { findAgent, findPane, identityMismatch } from "./supervision.ts";

export const DEFAULT_GLOBAL_REVIEW_INTERVAL_MS = 60 * 60 * 1000;
const MAX_GLOBAL_STATE_BYTES = 64 * 1024;
const MAX_FINDING_CONTEXT = 12_000;

export function globalReviewPath(root = defaultGoalsRoot()) {
  return join(root, ".supervisor", "global-review.json");
}

export function emptyGlobalReviewState() {
  return {
    version: 1,
    lastReviewedAt: undefined,
    nextReviewAt: undefined,
    snapshotHash: undefined,
    lastFindingHash: undefined,
    lastFinding: undefined,
  };
}

function validateOptionalTime(value, label) {
  if (value !== undefined && (typeof value !== "string" || !Number.isFinite(Date.parse(value)))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
}

export function validateGlobalReviewState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1) {
    throw new Error("invalid global review state");
  }
  const allowed = new Set(["version", "lastReviewedAt", "nextReviewAt", "snapshotHash", "lastFindingHash", "lastFinding"]);
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) throw new Error(`global review state contains unsupported field ${field}`);
  }
  validateOptionalTime(value.lastReviewedAt, "lastReviewedAt");
  validateOptionalTime(value.nextReviewAt, "nextReviewAt");
  for (const field of ["snapshotHash", "lastFindingHash"]) {
    if (value[field] !== undefined && (typeof value[field] !== "string" || !value[field])) {
      throw new Error(`${field} must be a non-empty string`);
    }
  }
  if (value.lastFinding !== undefined && (
    typeof value.lastFinding !== "string"
    || !value.lastFinding
    || value.lastFinding.length > MAX_FINDING_CONTEXT
  )) {
    throw new Error(`lastFinding must be a non-empty string no longer than ${MAX_FINDING_CONTEXT} characters`);
  }
  return value;
}

export async function loadGlobalReviewState(root = defaultGoalsRoot()) {
  try {
    return validateGlobalReviewState(JSON.parse(await readFile(globalReviewPath(root), "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") return emptyGlobalReviewState();
    throw error;
  }
}

export async function saveGlobalReviewState(state, root = defaultGoalsRoot()) {
  validateGlobalReviewState(state);
  const path = globalReviewPath(root);
  const content = `${JSON.stringify(state, null, 2)}\n`;
  if (Buffer.byteLength(content) > MAX_GLOBAL_STATE_BYTES) throw new Error("global review state is too large");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await atomicReplaceFile(path, content);
  return state;
}

export function stableHash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function globalFindingHash(findings) {
  const normalized = findings.map((finding) => ({
    problem: finding.problem.trim(),
    evidence: finding.evidence.map((item) => item.trim()).sort(),
    affectedGoalIds: [...finding.affectedGoalIds].sort(),
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return stableHash(normalized);
}

export function globalFindingSummary(findings) {
  const summary = findings.map((finding) => (
    `- ${finding.problem}\n  Evidence: ${finding.evidence.join("; ")}\n  Affects: ${finding.affectedGoalIds.join(", ")}`
  )).join("\n");
  if (summary.length <= MAX_FINDING_CONTEXT) return summary;
  return `${summary.slice(0, MAX_FINDING_CONTEXT - 13)}…[truncated]`;
}

export function buildGlobalSnapshot(bindings, unstarted, herdr, health, now = new Date()) {
  const timestamp = now.getTime();
  return {
    supervisorHealth: {
      observerConnected: Boolean(health.observerConnected),
      pendingFocusedReviews: Number(health.pendingFocusedReviews || 0),
      activeReview: health.activeReview || "none",
      lastBackgroundError: health.lastBackgroundError || undefined,
      unreadableGoals: (health.goalErrors || []).map(({ goalId, error }) => ({
        goalId,
        error: String(error?.message || error).slice(0, 1000),
      })),
    },
    pendingHumanInput: bindings
      .filter((binding) => binding.lastDecision?.decision === "ask_human")
      .map((binding) => binding.goalId),
    goals: bindings.map((binding) => {
      const agent = findAgent(herdr, binding.paneId);
      const pane = findPane(herdr, binding.paneId);
      const updated = Date.parse(binding.updatedAt || "");
      return {
        goalId: binding.goalId,
        outcome: binding.goal,
        workerState: identityMismatch(binding, agent, pane) || agent?.agent_status || "missing",
        checkpointAgeMs: Number.isFinite(updated) ? Math.max(0, timestamp - updated) : undefined,
        progress: binding.progress || undefined,
        wait: binding.wait ? {
          condition: binding.wait.condition,
          reviewAt: binding.wait.reviewAt,
          goalId: binding.wait.goalId,
        } : undefined,
        nextReviewAt: binding.nextReviewAt,
        lastDecision: binding.lastDecision ? {
          decision: binding.lastDecision.decision,
          at: binding.lastDecision.at,
          action: binding.lastDecision.action,
        } : undefined,
        currentResources: { paneId: binding.paneId, agent: binding.agentSession.agent },
      };
    }).concat(unstarted.map((goal) => ({
      goalId: goal.goalId,
      outcome: goal.contract.objective,
      workerState: "unstarted",
    }))),
  };
}

export function globalReviewMessage(snapshot, reason, previousFinding?, now = new Date()) {
  const previous = previousFinding
    ? `\n\nPreviously active finding:\n${previousFinding}\n\nReturn it again if the current snapshot still proves it, even when unchanged. Omit it only when the current snapshot proves it is resolved. Exact unchanged findings are suppressed after your decision.`
    : "";
  return `Global supervision review\nReview time: ${now.toISOString()} (UTC)\nReason: ${reason}\n\nThis is a compact current snapshot across all unfinished goals:\n${JSON.stringify(snapshot, null, 2)}${previous}\n\nLook for cross-goal waits, lost or stalled work, missing recovery, supervisor/runtime failure, and duplicated or conflicting activity that a one-goal review cannot see. A goal whose workerState is unstarted has a saved contract but no local worker; report unexpected unstarted work as a finding, but do not put it in reconsider because there is no worker to review. Do not inspect full logs and do not act on workers here. Call supervisor_global_result exactly once. Findings are the complete set of problems still proven by this snapshot; include active findings even when they are unchanged, and return none only when no problem remains. Findings report facts; reconsider routes action. Do not merely repeat an actionable finding: when an active goal needs current execution or its durable contract reconciled, put that exact fact and goal in reconsider. The focused review can decide from exact goal evidence or ask the human one concrete question when durable authority is needed. Leave reconsider empty only when no fresh goal decision is needed, such as when a healthy focused review or future bounded wait already covers it. If the system is healthy, return no findings and schedule the next low-frequency review.`;
}
