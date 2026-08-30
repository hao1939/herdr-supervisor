import { randomUUID } from "node:crypto";
import {
  appendAudit,
  createGoalContract,
  installGoal,
  listGoalRecords,
  loadGoalContract,
  newGoalId,
  startGoal,
  updateGoalContract,
  updateGoalState,
} from "./goal-store.ts";
import type { GoalBinding } from "./types.ts";

export const DEFAULT_ACCEPTANCE = "The stated objective is fully achieved with convincing evidence.";

export function bindingFromRecord(record): GoalBinding {
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
    reviewAt: record.state.reviewAt,
    lastDecision: record.state.lastDecision,
    wait: record.state.wait ? structuredClone(record.state.wait) : undefined,
    observationCursor: record.state.observationCursor,
    externalChange: record.state.externalChange ? structuredClone(record.state.externalChange) : undefined,
    updatedAt: record.state.updatedAt,
  };
}

export async function recordExternalChange(binding, change, root?, now?) {
  return updateGoalState(binding.goalId, (current) => {
    current.externalChange = structuredClone(change);
    return current;
  }, root, now);
}

export async function clearExternalChange(binding, observationCursor, root?, now?) {
  return updateGoalState(binding.goalId, (current) => {
    const pending = current.externalChange;
    const expected = binding.externalChange;
    if (
      !pending
      || !expected
      || ["source", "subject", "revision", "observedAt", "workerSequence"].some(
        (field) => pending[field] !== expected[field],
      )
    ) {
      throw new Error("the watched external resource changed again before its reread was recorded");
    }
    current.observationCursor = structuredClone(observationCursor);
    delete current.externalChange;
    return current;
  }, root, now);
}

export async function loadSupervisorGoals(root?) {
  const records = await listGoalRecords(root);
  return {
    active: records.filter((record) => record.state && !record.state.terminal).map(bindingFromRecord),
    unstarted: records.filter((record) => record.contract && !record.state),
    completed: records.filter((record) => record.state?.terminal),
    errors: records.filter((record) => record.error),
  };
}

export async function installSupervisorGoal(input, root?, options: any = {}) {
  const goals = await loadSupervisorGoals(root);
  if (goals.errors.length) {
    throw new Error(`repair unreadable goals before installing another: ${goals.errors.map((record) => record.goalId).join(", ")}`);
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
  return { goalId, contract };
}

export async function registerSupervisedGoal(worker, input, root?, options: any = {}) {
  const goals = await loadSupervisorGoals(root);
  if (goals.errors.length) {
    throw new Error(`repair unreadable goals before registering another: ${goals.errors.map((record) => record.goalId).join(", ")}`);
  }
  const existing = goals.active.find((binding) => binding.paneId === worker.paneId);
  if (existing) {
    throw new Error(`${worker.paneId} already pursues goal ${existing.goalId}; stop it before assigning another goal`);
  }
  const { goalId, contract } = await installSupervisorGoal(input, root, options);
  const state = await startGoal(goalId, worker, root, { at: options.at });
  return bindingFromRecord({ goalId, contract, state });
}

export async function startInstalledGoal(goalId, worker, root?, options: any = {}) {
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

export async function refineSupervisorGoal(goalId, input, root?, options: any = {}) {
  const goals = await loadSupervisorGoals(root);
  if (goals.errors.length) {
    throw new Error(`repair unreadable goals before refining another: ${goals.errors.map((record) => record.goalId).join(", ")}`);
  }
  const current = goals.active.find((binding) => binding.goalId === goalId);
  if (!current) throw new Error(`active goal ${goalId} was not found`);
  const contract = createGoalContract({
    objective: input.objective,
    context: input.context || [],
    acceptance: input.acceptance,
    constraints: input.constraints || [],
  });
  const updated = await updateGoalContract(goalId, () => contract, root);
  const binding = {
    ...current,
    goal: updated.objective,
    context: [...updated.context],
    acceptance: [...updated.acceptance],
    constraints: [...updated.constraints],
  };
  const at = options.at || new Date().toISOString();
  const answeredPreviousQuestion = binding.lastDecision?.decision === "ask_human";
  if (binding.wait || binding.reviewAt || answeredPreviousQuestion) {
    await updateGoalState(goalId, (state) => {
      delete state.wait;
      delete state.reviewAt;
      if (answeredPreviousQuestion) delete state.lastDecision;
      return state;
    }, root, () => at);
    delete binding.wait;
    delete binding.reviewAt;
    if (answeredPreviousQuestion) {
      delete binding.lastDecision;
    }
  }
  let auditError;
  try {
    const record = (await listGoalRecords(root)).find((item) => item.goalId === goalId);
    await appendAudit({
      v: 1,
      id: `audit_${randomUUID()}`,
      at,
      type: "goal_refined",
      goalId,
      goalRevision: record.state.revision,
      summary: input.summary,
      action: "Replaced the portable goal contract and kept the same worker.",
      evidence: [],
    }, root);
  } catch (error) {
    auditError = error;
  }
  return { binding, contract: updated, auditError };
}

export async function refreshWorkerLocation(binding, worker, root?, now?) {
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

export async function recordDecision(binding, decision, input, root?, now = () => new Date().toISOString()) {
  const at = now();
  const state = await updateGoalState(binding.goalId, (current) => {
    if (decision === "accept" && current.externalChange) {
      throw new Error("the watched external resource changed before acceptance");
    }
    if (
      decision === "steer"
      && current.externalChange?.revision !== input.externalChangeRevision
    ) {
      throw new Error("a steer must acknowledge the current external change revision before it can be recorded");
    }
    if (decision === "steer" && current.externalChange) {
      if (!Number.isInteger(input.workerSequence) || input.workerSequence < 0) {
        throw new Error("external-change steering requires the observed worker sequence");
      }
      current.externalChange.workerSequence = input.workerSequence;
    }
    current.progress = input.progress;
    if (input.evidence) current.evidence = [...input.evidence];
    if (input.observationCursor) current.observationCursor = structuredClone(input.observationCursor);
    current.lastDecision = { decision, at, action: input.action };
    if (input.reviewAt) current.reviewAt = input.reviewAt;
    else delete current.reviewAt;
    if (input.wait) current.wait = structuredClone(input.wait);
    else delete current.wait;
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
