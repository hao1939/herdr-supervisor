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
} from "../src/goal-registry.js";
import { createGoalContract, installGoal, readAudit } from "../src/goal-store.js";
import { shouldWake } from "../src/supervision.js";

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
});

test("refining a goal replaces its contract without replacing its worker", async () => {
  const directory = await root();
  await registerSupervisedGoal(worker, {
    objective: "Prepare the focused fix.",
    acceptance: ["The focused proof passes."],
  }, directory, { goalId: "g_test", at: "2026-08-28T10:00:00.000Z" });

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
  assert.deepEqual(goals.active[0].constraints, ["Use an isolated worktree and one focused PR."]);
  const audit = await readAudit("g_test", directory);
  assert.equal(audit.at(-1).type, "goal_refined");
  assert.equal(audit.at(-1).summary, "Added exact-commit ADO and collaboration requirements.");
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
  assert.equal(binding.worker, undefined);
  assert.equal(binding.paneId, "w1:p2");
  await assert.rejects(startInstalledGoal("g_copied", worker, directory), /already pursues goal/);
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

test("the same native session may refresh its transient terminal after restart", async () => {
  const directory = await root();
  const binding = await registerSupervisedGoal(worker, {
    objective: "Keep working after restart.",
  }, directory, { goalId: "g_restart", at: "2026-08-28T10:00:00.000Z" });
  const refreshed = await refreshWorkerLocation(binding, {
    ...worker,
    terminalId: "term_after_restart",
  }, directory, () => "2026-08-28T10:01:00.000Z");

  assert.equal(refreshed.terminalId, "term_after_restart");
  const [stored] = (await loadSupervisorGoals(directory)).active;
  assert.equal(stored.terminalId, "term_after_restart");
  assert.equal(stored.agentSession.value, worker.agentSession.value);
});
