import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  appendAudit,
  createGoalContract,
  GOAL_STORE_GUIDE,
  goalPaths,
  goalStoreGuidePath,
  initializeGoalStore,
  installGoal,
  listGoalRecords,
  loadGoal,
  loadGoalContract,
  loadGoalState,
  readAudit,
  startGoal,
  updateGoalContract,
  updateGoalState,
  validateGoalContract,
  validateGoalState,
} from "../src/goal-store.ts";

const worker = {
  paneId: "w1:p2",
  terminalId: "term_test",
  agentSession: {
    source: "herdr:codex",
    agent: "codex",
    kind: "id",
    value: "session_test",
  },
};

async function goalsRoot() {
  return mkdtemp(join(tmpdir(), "herdr-supervisor-goals-"));
}

function contract() {
  return createGoalContract({
    objective: "Produce the verified result.",
    context: ["Repository revision: abc123."],
    acceptance: ["The focused proof passes."],
    constraints: ["Do not deploy."],
  });
}

async function runningGoal(root, goalId = "g_test", selectedWorker = worker) {
  await installGoal(goalId, contract(), root);
  await startGoal(goalId, selectedWorker, root, { at: "2026-08-28T10:00:00.000Z" });
}

function audit(goalRevision = 1) {
  return {
    v: 1,
    id: `audit_${goalRevision}`,
    at: "2026-08-28T10:05:00.000Z",
    type: "review_completed",
    goalId: "g_test",
    goalRevision,
    summary: "The implementation exists but the proof has not run.",
    decision: "steer",
    action: "Asked the worker to run the focused proof.",
    evidence: ["The worker reported the implementation path."],
  };
}

test("the portable contract rejects runtime and audit fields", () => {
  assert.throws(() => validateGoalContract({ ...contract(), worker }), /unsupported field worker/);
  assert.throws(() => validateGoalContract({ ...contract(), progress: "working" }), /unsupported field progress/);
  assert.throws(() => validateGoalContract({ ...contract(), journal: [] }), /unsupported field journal/);
});

test("the first installed goal makes the store self-explaining", async () => {
  const root = await goalsRoot();
  await installGoal("g_test", contract(), root);

  assert.equal(await readFile(goalStoreGuidePath(root), "utf8"), GOAL_STORE_GUIDE);
  assert.deepEqual(await loadGoalContract("g_test", root), contract());
  assert.match(GOAL_STORE_GUIDE, /goal\.json.*portable authority/s);
  assert.match(GOAL_STORE_GUIDE, /current\.json.*not live runtime truth/s);
  assert.match(GOAL_STORE_GUIDE, /journal\.jsonl.*audit history/s);
  assert.match(GOAL_STORE_GUIDE, /do not edit them manually/i);
});

test("goal-store reads create nothing", async () => {
  const root = await goalsRoot();

  assert.deepEqual(await listGoalRecords(root), []);
  await assert.rejects(readFile(goalStoreGuidePath(root), "utf8"), { code: "ENOENT" });
});

test("explicit initialization creates only the shared guide", async () => {
  const root = await goalsRoot();

  await initializeGoalStore(root);

  assert.equal(await readFile(goalStoreGuidePath(root), "utf8"), GOAL_STORE_GUIDE);
  assert.deepEqual(await listGoalRecords(root), []);
});

test("installing a goal preserves an existing root guide", async () => {
  const root = await goalsRoot();
  await writeFile(goalStoreGuidePath(root), "Local operator notes.\n");

  await installGoal("g_test", contract(), root);

  assert.equal(await readFile(goalStoreGuidePath(root), "utf8"), "Local operator notes.\n");
  assert.deepEqual(await loadGoalContract("g_test", root), contract());
});

test("the local checkpoint rejects contract and unknown fields", async () => {
  const root = await goalsRoot();
  await runningGoal(root);
  await assert.rejects(updateGoalState("g_test", (current) => {
    current.objective = "A copied contract field.";
    return current;
  }, root), /unsupported field objective/);
  await assert.rejects(updateGoalState("g_test", (current) => {
    current.status = "working";
    return current;
  }, root), /unsupported field status/);
  const current = await loadGoalState("g_test", root);
  current.worker.agent_status = "working";
  assert.throws(() => validateGoalState(current), /goal worker contains unsupported field agent_status/);
});

test("v1 checkpoints retain read compatibility with the legacy recover decision", async () => {
  const root = await goalsRoot();
  await runningGoal(root);
  await updateGoalState("g_test", (current) => {
    current.lastDecision = {
      decision: "recover",
      at: "2026-08-28T10:05:00.000Z",
      action: "Resumed the exact worker session.",
    };
    return current;
  }, root, () => "2026-08-28T10:05:00.000Z");

  assert.equal((await loadGoalState("g_test", root)).lastDecision.decision, "recover");
});

test("copying goal.json is sufficient to start fresh in another instance", async () => {
  const source = await goalsRoot();
  const target = await goalsRoot();
  await installGoal("g_source", contract(), source);
  const targetPaths = goalPaths("g_target", target);
  await mkdir(targetPaths.directory, { recursive: true });
  await copyFile(goalPaths("g_source", source).contract, targetPaths.contract);

  const copied = await loadGoalContract("g_target", target);
  await assert.rejects(readFile(goalStoreGuidePath(target), "utf8"), { code: "ENOENT" });
  assert.deepEqual(copied, contract());
  assert.equal("goalId" in copied, false);
  assert.equal("worker" in copied, false);
  assert.equal("progress" in copied, false);

  const targetWorker = {
    ...worker,
    paneId: "w2:p4",
    terminalId: "term_target",
    agentSession: { ...worker.agentSession, value: "session_target" },
  };
  await startGoal("g_target", targetWorker, target, { at: "2026-08-29T10:00:00.000Z" });
  assert.equal(await readFile(goalStoreGuidePath(target), "utf8"), GOAL_STORE_GUIDE);
  assert.equal((await loadGoalState("g_target", target)).worker.agentSession.value, "session_target");
  assert.deepEqual(await readAudit("g_target", target), []);
});

test("goal contract and current state continue without audit history", async () => {
  const root = await goalsRoot();
  await runningGoal(root);
  const loaded = await loadGoal("g_test", root);

  assert.equal(loaded.contract.objective, "Produce the verified result.");
  assert.deepEqual(loaded.contract.acceptance, ["The focused proof passes."]);
  assert.equal(loaded.state.worker.agentSession.value, "session_test");
  assert.deepEqual(await readAudit("g_test", root), []);
});

test("listing isolates malformed and not-yet-started goals", async () => {
  const root = await goalsRoot();
  await runningGoal(root, "g_running");
  await installGoal("g_portable", contract(), root);
  await mkdir(goalPaths("g_broken", root).directory, { recursive: true });
  await writeFile(goalPaths("g_broken", root).contract, "not-json\n");

  const records = await listGoalRecords(root);
  assert.deepEqual(records.map((record) => record.goalId), ["g_broken", "g_portable", "g_running"]);
  assert.match(records[0].error.message, /JSON/);
  assert.equal(records[1].state, undefined);
  assert.equal(records[2].state.worker.paneId, "w1:p2");
});

test("material goal context can change without absorbing execution state", async () => {
  const root = await goalsRoot();
  await runningGoal(root);
  await updateGoalContract("g_test", (current) => {
    current.context.push("The API must retain backward compatibility.");
    return current;
  }, root);

  const loaded = await loadGoal("g_test", root);
  assert.equal(loaded.contract.context.at(-1), "The API must retain backward compatibility.");
  assert.equal("progress" in loaded.contract, false);
  assert.equal(loaded.state.revision, 1);
});

test("state updates atomically replace the current view and advance its revision", async () => {
  const root = await goalsRoot();
  await runningGoal(root);
  const updated = await updateGoalState("g_test", (current) => {
    current.progress = "The focused proof passes; live behavior remains.";
    current.reviewAt = "2026-08-28T10:10:00.000Z";
    current.evidence.push("test output: 12/12 passed");
    current.lastDecision = {
      decision: "steer",
      at: "2026-08-28T10:05:00.000Z",
      action: "Asked the worker to verify live behavior.",
    };
    current.observationCursor = { kind: "codex-jsonl", offset: 120 };
    return current;
  }, root, () => "2026-08-28T10:05:00.000Z");

  assert.equal(updated.revision, 2);
  assert.equal(updated.reviewAt, "2026-08-28T10:10:00.000Z");
  assert.equal((await loadGoalState("g_test", root)).progress, "The focused proof passes; live behavior remains.");
  assert.equal(JSON.parse(await readFile(goalPaths("g_test", root).current, "utf8")).revision, 2);
});

test("the local checkpoint retains one unresolved external change", async () => {
  const root = await goalsRoot();
  await runningGoal(root);
  await updateGoalState("g_test", (current) => {
    current.externalChange = {
      source: "github-pr",
      subject: "owner/repository#16",
      revision: "revision-2",
      observedAt: "2026-08-30T10:05:00.000Z",
    };
    return current;
  }, root, () => "2026-08-30T10:05:00.000Z");

  assert.deepEqual((await loadGoalState("g_test", root)).externalChange, {
    source: "github-pr",
    subject: "owner/repository#16",
    revision: "revision-2",
    observedAt: "2026-08-30T10:05:00.000Z",
  });
});

test("the local checkpoint rejects a malformed exact review time", async () => {
  const root = await goalsRoot();
  await runningGoal(root);
  await assert.rejects(updateGoalState("g_test", (current) => {
    current.reviewAt = "later";
    return current;
  }, root), /reviewAt must be an ISO timestamp/);
});

test("concurrent local updates for one goal are serialized", async () => {
  const root = await goalsRoot();
  await runningGoal(root);
  await Promise.all(Array.from({ length: 20 }, (_, index) => updateGoalState("g_test", (current) => {
    current.evidence.push(`evidence ${index}`);
    return current;
  }, root)));

  const stored = await loadGoalState("g_test", root);
  assert.equal(stored.revision, 21);
  assert.deepEqual(stored.evidence, Array.from({ length: 20 }, (_, index) => `evidence ${index}`));
});

test("audit history is append-only and does not alter contract or state", async () => {
  const root = await goalsRoot();
  await runningGoal(root);
  await Promise.all([appendAudit(audit(), root), appendAudit({ ...audit(), id: "audit_2" }, root)]);

  assert.deepEqual((await readAudit("g_test", root)).map((entry) => entry.id), ["audit_1", "audit_2"]);
  assert.equal((await loadGoalState("g_test", root)).revision, 1);
  assert.deepEqual(await loadGoalContract("g_test", root), contract());
});

test("malformed audit history cannot prevent goal recovery", async () => {
  const root = await goalsRoot();
  await runningGoal(root);
  await writeFile(goalPaths("g_test", root).journal, "not-json\n");

  await assert.rejects(readAudit("g_test", root), /line 1/);
  assert.equal((await loadGoal("g_test", root)).state.goalId, "g_test");
});

test("an interrupted final audit record is repaired by the next append", async () => {
  const root = await goalsRoot();
  await runningGoal(root);
  await appendAudit(audit(), root);
  const paths = goalPaths("g_test", root);
  await writeFile(paths.journal, `${await readFile(paths.journal, "utf8")}{"v":1,"id":`);

  assert.deepEqual((await readAudit("g_test", root)).map((entry) => entry.id), ["audit_1"]);
  await appendAudit({ ...audit(), id: "audit_2" }, root);
  assert.deepEqual((await readAudit("g_test", root)).map((entry) => entry.id), ["audit_1", "audit_2"]);
});

test("audit history cannot create execution state or claim an unknown revision", async () => {
  const root = await goalsRoot();
  await installGoal("g_test", contract(), root);
  await assert.rejects(appendAudit(audit(), root), /ENOENT/);
  await startGoal("g_test", worker, root);
  await assert.rejects(appendAudit(audit(2), root), /unknown future goal revision/);
});

test("terminal state remains local and in the same goal directory", async () => {
  const root = await goalsRoot();
  await runningGoal(root);
  await updateGoalState("g_test", (current) => {
    current.progress = "The result is complete and verified.";
    current.terminal = {
      state: "accepted",
      at: "2026-08-28T10:10:00.000Z",
      summary: "Focused and live proofs passed.",
    };
    return current;
  }, root, () => "2026-08-28T10:10:00.000Z");

  const stored = await loadGoalState("g_test", root);
  assert.equal(stored.terminal.state, "accepted");
  assert.equal(goalPaths("g_test", root).directory, join(root, "g_test"));
  await assert.rejects(updateGoalState("g_test", (current) => current, root), /already accepted/);
});

test("portable contract and local state are independently bounded", async () => {
  const root = await goalsRoot();
  const oversizedContract = contract();
  oversizedContract.context.push("x".repeat(150 * 1024));
  await assert.rejects(installGoal("g_contract", oversizedContract, root), /contract is too large/);

  await runningGoal(root);
  await assert.rejects(updateGoalState("g_test", (current) => {
    current.progress = "x".repeat(300 * 1024);
    return current;
  }, root), /state is too large/);
});

test("an active local execution keeps its exact worker and Codex session", async () => {
  const root = await goalsRoot();
  await runningGoal(root);
  await assert.rejects(updateGoalState("g_test", (current) => {
    current.worker.agentSession.value = "replacement_session";
    return current;
  }, root), /cannot replace its worker pane or native session/);
  assert.equal((await loadGoalState("g_test", root)).worker.agentSession.value, "session_test");
});
