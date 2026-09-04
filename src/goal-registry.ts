import { randomUUID } from "node:crypto";
import {
  appendAudit,
  createGoalContract,
  discardUnstartedGoal,
  installGoal,
  listGoalRecords,
  loadGoalContract,
  newGoalId,
  startGoal,
  updateGoalContract,
  updateGoalState,
  withGoalRootLock,
} from "./goal-store.ts";
import { sameAgentSession } from "./identity.ts";
import type { GoalBinding } from "./types.ts";

const DEFAULT_ACCEPTANCE = "The stated objective is fully achieved with convincing evidence.";

function assertWorkerAvailable(active, worker, exceptGoalId?) {
  const candidates = active.filter((binding) => binding.goalId !== exceptGoalId);
  const paneOwner = candidates.find((binding) => binding.paneId === worker.paneId);
  if (paneOwner) {
    throw new Error(`${worker.paneId} already pursues goal ${paneOwner.goalId}; stop it before assigning another goal`);
  }
  const sessionOwner = candidates.find((binding) => sameAgentSession(binding.agentSession, worker.agentSession));
  if (sessionOwner) {
    throw new Error(`the native agent session already pursues goal ${sessionOwner.goalId}; stop it before assigning another goal`);
  }
}

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
    steerReceipt: record.state.steerReceipt ? structuredClone(record.state.steerReceipt) : undefined,
    wait: record.state.wait ? structuredClone(record.state.wait) : undefined,
    observationCursor: record.state.observationCursor,
    updatedAt: record.state.updatedAt,
  };
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
  return withGoalRootLock(root, async () => {
    const goals = await loadSupervisorGoals(root);
    if (goals.errors.length) {
      throw new Error(`repair unreadable goals before registering another: ${goals.errors.map((record) => record.goalId).join(", ")}`);
    }
    assertWorkerAvailable(goals.active, worker);
    const { goalId, contract } = await installSupervisorGoal(input, root, options);
    const state = await startGoal(goalId, worker, root, { at: options.at });
    return bindingFromRecord({ goalId, contract, state });
  });
}

export async function startInstalledGoal(goalId, worker, root?, options: any = {}) {
  return withGoalRootLock(root, async () => {
    const goals = await loadSupervisorGoals(root);
    if (goals.errors.length) {
      throw new Error(`repair unreadable goals before starting another: ${goals.errors.map((record) => record.goalId).join(", ")}`);
    }
    assertWorkerAvailable(goals.active, worker);
    const installed = goals.unstarted.find((record) => record.goalId === goalId);
    if (!installed) {
      await loadGoalContract(goalId, root);
      throw new Error(`goal ${goalId} already has local execution state`);
    }
    const state = await startGoal(goalId, worker, root, { at: options.at });
    return bindingFromRecord({ goalId, contract: installed.contract, state });
  });
}

export async function discardInstalledGoal(goalId, root?) {
  return withGoalRootLock(root, async () => {
    const goals = await loadSupervisorGoals(root);
    if (goals.errors.length) {
      throw new Error(`repair unreadable goals before discarding another: ${goals.errors.map((record) => record.goalId).join(", ")}`);
    }
    if (!goals.unstarted.some((record) => record.goalId === goalId)) {
      throw new Error(`goal ${goalId} is not an unstarted saved contract`);
    }
    return discardUnstartedGoal(goalId, root);
  });
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
  return withGoalRootLock(root, async () => {
    const goals = await loadSupervisorGoals(root);
    if (goals.errors.length) {
      throw new Error(`repair unreadable goals before relocating a worker: ${goals.errors.map((record) => record.goalId).join(", ")}`);
    }
    const current = goals.active.find((candidate) => candidate.goalId === binding.goalId);
    if (!current) throw new Error(`active goal ${binding.goalId} was not found`);
    if (!sameAgentSession(worker.agentSession, current.agentSession)) {
      throw new Error("the native agent session changed");
    }
    if (worker.paneId === current.paneId && worker.terminalId === current.terminalId) return current;
    if (binding.paneId !== current.paneId || binding.terminalId !== current.terminalId) {
      throw new Error("the worker routing changed; reread Herdr before relocating it");
    }
    assertWorkerAvailable(goals.active, worker, current.goalId);
    const state = await updateGoalState(current.goalId, (goalState) => {
      goalState.worker.paneId = worker.paneId;
      goalState.worker.terminalId = worker.terminalId;
      return goalState;
    }, root, now, { allowWorkerRelocation: true });
    return bindingFromRecord({
      goalId: current.goalId,
      contract: {
        objective: current.goal,
        context: current.context,
        acceptance: current.acceptance,
        constraints: current.constraints,
      },
      state,
    });
  });
}

export async function recordDecision(binding, decision, input, root?, now = () => new Date().toISOString()) {
  const at = now();
  const state = await updateGoalState(binding.goalId, (current) => {
    current.progress = input.progress;
    if (input.evidence) current.evidence = [...input.evidence];
    if (input.observationCursor) current.observationCursor = structuredClone(input.observationCursor);
    current.lastDecision = { decision, at, action: input.action };
    if (!input.preserveSteerReceipt) delete current.steerReceipt;
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

export async function recordSteerReceipt(binding, instruction, stateChangeSeq, root?) {
  const state = await updateGoalState(binding.goalId, (current) => {
    current.steerReceipt = { instruction, stateChangeSeq };
    return current;
  }, root);
  return bindingFromRecord({
    goalId: binding.goalId,
    contract: {
      objective: binding.goal,
      context: binding.context,
      acceptance: binding.acceptance,
      constraints: binding.constraints,
    },
    state,
  });
}
