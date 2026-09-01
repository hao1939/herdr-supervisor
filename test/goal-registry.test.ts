import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadSupervisorGoals,
  recordDecision,
  refineSupervisorGoal,
  refreshWorkerLocation,
  registerSupervisedGoal,
  startInstalledGoal,
} from "../src/goal-registry.ts";
import { createGoalContract, installGoal, loadGoalState, readAudit, updateGoalState } from "../src/goal-store.ts";
import { shouldWake } from "../src/supervision.ts";

const worker = {
  paneId: "w1:p2",
  terminalId: "term_test",
  agentSession: { source: "herdr:codex", agent: "codex", kind: "id", value: "session_test" },
};

async function root() {
  return mkdtemp(join(tmpdir(), "herdr-supervisor-registry-"));
}

test("one active goal binds one exact worker and uses explicit acceptance", async () => {
  const directory = await root();
  const binding = await registerSupervisedGoal(worker, {
    objective: "Finish the focused fix.",
    acceptance: ["The focused proof passes."],
  }, directory, { goalId: "g_test", at: "2026-08-28T10:00:00.000Z" });

  assert.equal(binding.goalId, "g_test");
  assert.equal(binding.agentSession.value, "session_test");
  assert.deepEqual(binding.acceptance, ["The focused proof passes."]);
  await assert.rejects(registerSupervisedGoal(worker, {
    objective: "A different goal.",
  }, directory), /already pursues goal g_test/);
  await assert.rejects(registerSupervisedGoal({
    ...worker,
    paneId: "w1:p9",
    terminalId: "term_other",
  }, {
    objective: "Another goal with the same native session.",
  }, directory), /native agent session already pursues goal g_test/);
});

test("concurrent registration cannot assign one native session twice", async () => {
  const directory = await root();
  const results = await Promise.allSettled([
    registerSupervisedGoal(worker, { objective: "Finish Alpha." }, directory, { goalId: "g_alpha" }),
    registerSupervisedGoal({
      ...worker,
      paneId: "w1:p9",
      terminalId: "term_other",
    }, { objective: "Finish Beta." }, directory, { goalId: "g_beta" }),
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.match((results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason.message, /native agent session already pursues goal/);
  assert.equal((await loadSupervisorGoals(directory)).active.length, 1);
});

test("concurrent relocation and registration cannot assign one pane twice", async () => {
  const directory = await root();
  const binding = await registerSupervisedGoal(worker, {
    objective: "Keep the existing goal moving.",
  }, directory, { goalId: "g_existing" });
  const destination = {
    paneId: "w1:p9",
    terminalId: "term_destination",
    agentSession: worker.agentSession,
  };
  const newcomer = {
    paneId: destination.paneId,
    terminalId: destination.terminalId,
    agentSession: { source: "herdr:codex", agent: "codex", kind: "id", value: "session_new" },
  };

  const results = await Promise.allSettled([
    refreshWorkerLocation(binding, destination, directory),
    registerSupervisedGoal(newcomer, {
      objective: "Start another goal.",
    }, directory, { goalId: "g_new" }),
  ]);

  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.match((results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason.message, /already pursues goal/);
  const active = (await loadSupervisorGoals(directory)).active;
  assert.equal(new Set(active.map((goal) => goal.paneId)).size, active.length);
});

test("a queued stale relocation cannot overwrite a newer worker route", async () => {
  const directory = await root();
  const binding = await registerSupervisedGoal(worker, {
    objective: "Keep the newest observed worker route.",
  }, directory, { goalId: "g_route" });
  const results = await Promise.allSettled([
    refreshWorkerLocation(binding, {
      ...worker,
      paneId: "w1:p9",
      terminalId: "term_newest",
    }, directory),
    refreshWorkerLocation(binding, {
      ...worker,
      paneId: "w1:p10",
      terminalId: "term_stale",
    }, directory),
  ]);

  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  assert.match((results[1] as PromiseRejectedResult).reason.message, /routing changed; reread Herdr/);
  const [stored] = (await loadSupervisorGoals(directory)).active;
  assert.equal(stored.paneId, "w1:p9");
  assert.equal(stored.terminalId, "term_newest");
});

test("refining a goal replaces its contract without replacing its worker", async () => {
  const directory = await root();
  const binding = await registerSupervisedGoal(worker, {
    objective: "Prepare the focused fix.",
    acceptance: ["The focused proof passes."],
  }, directory, { goalId: "g_test", at: "2026-08-28T10:00:00.000Z" });
  await recordDecision(binding, "leave", {
    progress: "Waiting for the earlier requirement.",
    action: "Wait for the earlier requirement.",
    wait: {
      condition: "the earlier requirement",
      reviewAt: "2026-08-28T11:00:00.000Z",
    },
  }, directory, () => "2026-08-28T10:01:00.000Z");
  const result = await refineSupervisorGoal("g_test", {
    objective: "Prepare and validate the focused fix.",
    context: ["Another worker owns the adjacent component."],
    acceptance: ["The focused proof passes.", "The exact commit passes ADO."],
    constraints: ["Use an isolated worktree and one focused PR."],
    summary: "Added exact-commit ADO and collaboration requirements.",
  }, directory, { at: "2026-08-28T10:02:00.000Z" });

  assert.equal(result.auditError, undefined);
  assert.equal(result.binding.paneId, worker.paneId);
  assert.equal(result.binding.agentSession.value, worker.agentSession.value);
  assert.equal(result.binding.goal, "Prepare and validate the focused fix.");
  assert.deepEqual(result.binding.acceptance, ["The focused proof passes.", "The exact commit passes ADO."]);
  const goals = await loadSupervisorGoals(directory);
  assert.equal(goals.active.length, 1);
  assert.equal(goals.active[0].goalId, "g_test");
  assert.equal(goals.active[0].wait, undefined);
  assert.deepEqual(goals.active[0].constraints, ["Use an isolated worktree and one focused PR."]);
  const audit = await readAudit("g_test", directory);
  assert.equal(audit.at(-1).type, "goal_refined");
  assert.equal(audit.at(-1).summary, "Added exact-commit ADO and collaboration requirements.");
});

test("a legacy provider change survives until the worker is steered to reread it", async () => {
  const directory = await root();
  const binding = await registerSupervisedGoal(worker, {
    objective: "Continue a goal created before metadata discovery.",
  }, directory, { goalId: "g_legacy_watch" });
  await updateGoalState(binding.goalId, (state) => {
    state.externalChange = {
      source: "github-pr",
      subject: "hao1939/herdr-supervisor#16",
      revision: "legacy-revision",
      observedAt: "2026-08-30T05:01:00.000Z",
    };
    return state;
  }, directory);

  const [pending] = (await loadSupervisorGoals(directory)).active;
  assert.equal(pending.legacyExternalChange?.revision, "legacy-revision");
  await assert.rejects(recordDecision(pending, "leave", {
    progress: "The worker is continuing under the replacement watcher.",
    action: "Keep the healthy worker running.",
  }, directory), /must be reread by the worker/);
  assert.equal((await loadGoalState(binding.goalId, directory)).externalChange.revision, "legacy-revision");

  await recordDecision(pending, "steer", {
    progress: "The worker was asked to reread current provider authority.",
    action: "Reread the exact legacy provider resource and continue.",
  }, directory);

  assert.equal((await loadGoalState(binding.goalId, directory)).externalChange, undefined);
});

test("refining a goal resolves its previous human question", async () => {
  const directory = await root();
  const current = await registerSupervisedGoal(worker, {
    objective: "Prepare the focused fix.",
    acceptance: ["The focused proof passes."],
  }, directory, { goalId: "g_test", at: "2026-08-28T10:00:00.000Z" });
  await recordDecision(current, "ask_human", {
    progress: "Human input is required: should the proof include the slow suite?",
    action: "Should the proof include the slow suite?",
  }, directory, () => "2026-08-28T10:01:00.000Z");

  await refineSupervisorGoal("g_test", {
    objective: "Prepare and validate the focused fix with the slow suite.",
    acceptance: ["The focused and slow suites pass."],
    summary: "The human added the slow suite requirement.",
  }, directory, { at: "2026-08-28T10:02:00.000Z" });

  const [refined] = (await loadSupervisorGoals(directory)).active;
  assert.equal(refined.lastDecision, undefined);
});

test("a terminal decision removes only that goal from active supervision", async () => {
  const directory = await root();
  const binding = await registerSupervisedGoal(worker, {
    objective: "Finish the focused fix.",
  }, directory, { goalId: "g_test", at: "2026-08-28T10:00:00.000Z" });
  const result = await recordDecision(binding, "accept", {
    progress: "The focused result is verified.",
    action: "Accepted the goal.",
    evidence: ["Focused proof passed."],
    terminal: { state: "accepted", summary: "Focused proof passed." },
  }, directory, () => "2026-08-28T10:05:00.000Z");

  assert.equal(result.auditError, undefined);
  const goals = await loadSupervisorGoals(directory);
  assert.equal(goals.active.length, 0);
  assert.equal(goals.completed.length, 1);
  assert.equal(goals.completed[0].state.terminal.state, "accepted");
});

test("corrupt and contract-only goals do not hide valid active goals", async () => {
  const directory = await root();
  await registerSupervisedGoal(worker, { objective: "Keep working." }, directory, { goalId: "g_valid" });
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(join(directory, "g_broken"));
  await writeFile(join(directory, "g_broken", "goal.json"), "not-json\n");
  const goals = await loadSupervisorGoals(directory);
  assert.equal(goals.active.length, 1);
  assert.equal(goals.errors.length, 1);
});

test("the supervisor starts a copied contract through its single writer", async () => {
  const directory = await root();
  await installGoal("g_copied", createGoalContract({
    objective: "Run the copied goal.",
    acceptance: ["The copied goal is verified."],
  }), directory);
  const binding = await startInstalledGoal("g_copied", worker, directory, {
    at: "2026-08-28T10:00:00.000Z",
  });
  assert.equal(binding.goal, "Run the copied goal.");
  assert.equal((binding as any).worker, undefined);
  assert.equal(binding.paneId, "w1:p2");
  await assert.rejects(startInstalledGoal("g_copied", worker, directory), /already pursues goal/);

  await installGoal("g_other", createGoalContract({
    objective: "Run another copied goal.",
    acceptance: ["The other copied goal is verified."],
  }), directory);
  await assert.rejects(startInstalledGoal("g_other", {
    ...worker,
    paneId: "w1:p9",
    terminalId: "term_other",
  }, directory), /native agent session already pursues goal g_copied/);
});

test("concurrent installed goals cannot claim one native session twice", async () => {
  const directory = await root();
  for (const goalId of ["g_alpha", "g_beta"]) {
    await installGoal(goalId, createGoalContract({
      objective: `Finish ${goalId}.`,
      acceptance: ["The goal is verified."],
    }), directory);
  }
  const results = await Promise.allSettled([
    startInstalledGoal("g_alpha", worker, directory),
    startInstalledGoal("g_beta", {
      ...worker,
      paneId: "w1:p9",
      terminalId: "term_other",
    }, directory),
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.match((results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason.message, /native agent session already pursues goal/);
  assert.equal((await loadSupervisorGoals(directory)).active.length, 1);
});

test("restart reloads concurrent goals independently and reconsiders fresh Herdr state", async () => {
  const directory = await root();
  const secondWorker = {
    paneId: "w1:p3",
    terminalId: "term_second",
    agentSession: { source: "herdr:codex", agent: "codex", kind: "id", value: "session_second" },
  };
  const first = await registerSupervisedGoal(worker, {
    objective: "Finish Alpha.",
  }, directory, { goalId: "g_alpha" });
  const second = await registerSupervisedGoal(secondWorker, {
    objective: "Finish Beta.",
  }, directory, { goalId: "g_beta" });
  await Promise.all([
    recordDecision(first, "leave", {
      progress: "Alpha is running its proof.",
      action: "Left Alpha working.",
      observationCursor: { kind: "codex-jsonl", offset: 40 },
    }, directory),
    recordDecision(second, "steer", {
      progress: "Beta needs its focused proof.",
      action: "Asked Beta for the proof.",
      observationCursor: { kind: "codex-jsonl", offset: 80 },
    }, directory),
  ]);

  // A fresh registry load represents a restarted supervisor process. It needs
  // no in-memory signal queue or audit replay.
  const restarted = await loadSupervisorGoals(directory);
  assert.deepEqual(restarted.active.map((goal) => goal.goalId), ["g_alpha", "g_beta"]);
  assert.equal(restarted.active[0].observationCursor.offset, 40);
  assert.equal(restarted.active[1].observationCursor.offset, 80);
  assert.equal(restarted.active[0].progress, "Alpha is running its proof.");
  assert.equal(restarted.active[1].progress, "Beta needs its focused proof.");

  const alphaAgent = {
    pane_id: "w1:p2",
    terminal_id: "term_test",
    agent_status: "working",
    state_change_seq: 11,
    agent_session: worker.agentSession,
  };
  const betaAgent = {
    pane_id: "w1:p3",
    terminal_id: "term_second",
    agent_status: "blocked",
    state_change_seq: 12,
    agent_session: secondWorker.agentSession,
  };
  assert.equal(shouldWake({ ...restarted.active[0], lastReviewStateChangeSeq: 0 }, alphaAgent, alphaAgent).wake, false);
  assert.equal(shouldWake({ ...restarted.active[1], lastReviewStateChangeSeq: 0 }, betaAgent, betaAgent).wake, true);
});

test("the same native session may refresh its transient routing location", async () => {
  const directory = await root();
  const binding = await registerSupervisedGoal(worker, {
    objective: "Keep working after restart.",
  }, directory, { goalId: "g_restart", at: "2026-08-28T10:00:00.000Z" });
  const dependentWorker = {
    paneId: "w1:p3",
    terminalId: "term_dependent",
    agentSession: { source: "herdr:codex", agent: "codex", kind: "id", value: "session_dependent" },
  };
  const dependent = await registerSupervisedGoal(dependentWorker, {
    objective: "Continue when the peer changes.",
  }, directory, { goalId: "g_dependent", at: "2026-08-28T10:00:10.000Z" });
  await recordDecision(dependent, "leave", {
    progress: "Waiting for the peer.",
    action: "Wait for the peer.",
    wait: {
      condition: "the peer result",
      paneId: worker.paneId,
      reviewAt: "2026-08-28T11:00:00.000Z",
    },
  }, directory, () => "2026-08-28T10:00:20.000Z");
  const refreshed = await refreshWorkerLocation(binding, {
    ...worker,
    paneId: "w1:p9",
    terminalId: "term_after_restart",
  }, directory, () => "2026-08-28T10:01:00.000Z");

  assert.equal(refreshed.paneId, "w1:p9");
  assert.equal(refreshed.terminalId, "term_after_restart");
  assert.equal(refreshed.updatedAt, "2026-08-28T10:01:00.000Z");
  const storedGoals = (await loadSupervisorGoals(directory)).active;
  const stored = storedGoals.find((goal) => goal.goalId === binding.goalId);
  const storedDependent = storedGoals.find((goal) => goal.goalId === dependent.goalId);
  assert.equal(stored.paneId, "w1:p9");
  assert.equal(stored.terminalId, "term_after_restart");
  assert.equal(stored.agentSession.value, worker.agentSession.value);
  assert.equal(storedDependent.wait.goalId, binding.goalId);
  assert.equal(storedDependent.wait.paneId, worker.paneId);
});
