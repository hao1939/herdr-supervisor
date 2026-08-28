import { randomUUID } from "node:crypto";
import {
  appendAudit,
  createGoalContract,
  installGoal,
  listGoalRecords,
  loadGoalContract,
  newGoalId,
  startGoal,
  updateGoalState,
} from "./goal-store.js";

export const DEFAULT_ACCEPTANCE = "The stated objective is fully achieved with convincing evidence.";

export function bindingFromRecord(record) {
  if (!record?.contract || !record?.state) throw new Error("goal has no local execution");
  return {
    goalId: record.goalId,
    paneId: record.state.worker.paneId,
    terminalId: record.state.worker.terminalId,
    agentSession: structuredClone(record.state.worker.agentSession),
    goal: record.contract.objective,
    context: [...record.contract.context],
    acceptance: [...record.contract.acceptance],
    constraints: [...record.contract.constraints],
    evidence: [...record.state.evidence],
    progress: record.state.progress,
    lastDecision: record.state.lastDecision,
    observationCursor: record.state.observationCursor,
  };
}

export async function loadSupervisorGoals(root) {
  const records = await listGoalRecords(root);
  return {
    active: records.filter((record) => record.state && !record.state.terminal).map(bindingFromRecord),
    unstarted: records.filter((record) => record.contract && !record.state),
    completed: records.filter((record) => record.state?.terminal),
    errors: records.filter((record) => record.error),
  };
}

export async function registerSupervisedGoal(worker, input, root, options = {}) {
  const goals = await loadSupervisorGoals(root);
  if (goals.errors.length) {
    throw new Error(`repair unreadable goals before registering another: ${goals.errors.map((record) => record.goalId).join(", ")}`);
  }
  const existing = goals.active.find((binding) => binding.paneId === worker.paneId);
  if (existing) {
    throw new Error(`${worker.paneId} already pursues goal ${existing.goalId}; stop it before assigning another goal`);
  }
  const goalId = options.goalId || newGoalId();
  const acceptance = input.acceptance?.length ? input.acceptance : [DEFAULT_ACCEPTANCE];
  const contract = createGoalContract({
    objective: input.objective,
    context: input.context || [],
    acceptance,
    constraints: input.constraints || [],
  });
  await installGoal(goalId, contract, root);
  const state = await startGoal(goalId, worker, root, { at: options.at });
  return bindingFromRecord({ goalId, contract, state });
}

export async function startInstalledGoal(goalId, worker, root, options = {}) {
  const goals = await loadSupervisorGoals(root);
  if (goals.errors.length) {
    throw new Error(`repair unreadable goals before starting another: ${goals.errors.map((record) => record.goalId).join(", ")}`);
  }
  const existing = goals.active.find((binding) => binding.paneId === worker.paneId);
  if (existing) {
    throw new Error(`${worker.paneId} already pursues goal ${existing.goalId}; stop it before assigning another goal`);
  }
  const installed = goals.unstarted.find((record) => record.goalId === goalId);
  if (!installed) {
    await loadGoalContract(goalId, root);
    throw new Error(`goal ${goalId} already has local execution state`);
  }
  const state = await startGoal(goalId, worker, root, { at: options.at });
  return bindingFromRecord({ goalId, contract: installed.contract, state });
}

export async function refreshWorkerLocation(binding, worker, root, now) {
  if (worker.paneId !== binding.paneId) throw new Error("the worker pane changed");
  if (["source", "agent", "kind", "value"].some(
    (field) => worker.agentSession?.[field] !== binding.agentSession?.[field],
  )) {
    throw new Error("the native agent session changed");
  }
  if (worker.terminalId === binding.terminalId) return binding;
  const state = await updateGoalState(binding.goalId, (current) => {
    current.worker.terminalId = worker.terminalId;
    return current;
  }, root, now);
  return { ...binding, terminalId: state.worker.terminalId };
}

export async function recordDecision(binding, decision, input, root, now = () => new Date().toISOString()) {
  const at = now();
  const state = await updateGoalState(binding.goalId, (current) => {
    current.progress = input.progress;
    if (input.evidence) current.evidence = [...input.evidence];
    if (input.observationCursor) current.observationCursor = structuredClone(input.observationCursor);
    current.lastDecision = { decision, at, action: input.action };
    if (input.terminal) current.terminal = { ...input.terminal, at };
    return current;
  }, root, () => at);
  let auditError;
  try {
    await appendAudit({
      v: 1,
      id: `audit_${randomUUID()}`,
      at,
      type: input.terminal ? `goal_${input.terminal.state}` : "review_completed",
      goalId: binding.goalId,
      goalRevision: state.revision,
      summary: input.progress,
      decision,
      action: input.action,
      evidence: input.evidence || [],
    }, root);
  } catch (error) {
    auditError = error;
  }
  return { state, auditError };
}
