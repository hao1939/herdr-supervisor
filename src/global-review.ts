import { createHash, randomUUID } from "node:crypto";
import { open, mkdir, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defaultGoalsRoot } from "./goal-store.ts";
import { findAgent, findPane, identityMismatch } from "./supervision.ts";

export const DEFAULT_GLOBAL_REVIEW_INTERVAL_MS = 60 * 60 * 1000;
const MAX_GLOBAL_STATE_BYTES = 64 * 1024;

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
  const allowed = new Set(["version", "lastReviewedAt", "nextReviewAt", "snapshotHash", "lastFindingHash"]);
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
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await open(temporary, "wx", 0o600);
    await file.writeFile(content);
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await file?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
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

export function buildGlobalSnapshot(bindings, unstarted, herdr, health, now = new Date()) {
  const timestamp = now.getTime();
  return {
    supervisorHealth: {
      observerConnected: Boolean(health.observerConnected),
      pendingFocusedReviews: Number(health.pendingFocusedReviews || 0),
      activeReview: health.activeReview || "none",
      lastBackgroundError: health.lastBackgroundError || undefined,
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
        progressAgeMs: Number.isFinite(updated) ? Math.max(0, timestamp - updated) : undefined,
        progress: binding.progress || undefined,
        wait: binding.wait ? {
          condition: binding.wait.condition,
          reviewAt: binding.wait.reviewAt,
          goalId: binding.wait.goalId
            || bindings.find((candidate) => candidate.paneId === binding.wait.paneId)?.goalId,
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

export function globalReviewMessage(snapshot, reason, now = new Date()) {
  return `Global supervision review\nReview time: ${now.toISOString()} (UTC)\nReason: ${reason}\n\nThis is a compact current snapshot across all unfinished goals:\n${JSON.stringify(snapshot, null, 2)}\n\nLook for cross-goal waits, lost or stalled work, missing recovery, supervisor/runtime failure, and duplicated or conflicting activity that a one-goal review cannot see. A goal whose workerState is unstarted has a saved contract but no local worker; report unexpected unstarted work as a finding, but do not put it in reconsider because there is no worker to review. Do not inspect full logs and do not act on workers here. Call supervisor_global_result exactly once. Findings may name the existing goals they affect, but findings are reports and do not schedule work. Add an active goal to reconsider only when it actually needs a fresh ordinary focused review now; otherwise leave reconsider empty. If the system is healthy, return no findings and schedule the next low-frequency review.`;
}
