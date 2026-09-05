import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildGlobalSnapshot,
  emptyGlobalReviewState,
  globalFindingHash,
  globalReviewMessage,
  loadGlobalReviewState,
  saveGlobalReviewState,
} from "../src/global-review.ts";

const session = { source: "herdr:codex", agent: "codex", kind: "id", value: "session_one" };

test("global snapshot bounds goal-read errors without inventing worker state", () => {
  const snapshot = buildGlobalSnapshot([], [], { agents: [], panes: [] }, {
    goalErrors: [{ goalId: "g_broken", error: new Error("x".repeat(2000)) }],
  });
  assert.equal(snapshot.supervisorHealth.unreadableGoals[0].goalId, "g_broken");
  assert.equal(snapshot.supervisorHealth.unreadableGoals[0].error.length, 1000);
  assert.deepEqual(snapshot.goals, []);
});

test("global snapshot is compact current state rather than goal history", () => {
  const snapshot = buildGlobalSnapshot([{
    goalId: "g_one",
    paneId: "w1:p2",
    terminalId: "term_one",
    agentSession: session,
    goal: "Finish the release proof.",
    progress: "The focused tests pass.",
    updatedAt: "2026-08-29T00:00:00.000Z",
    nextReviewAt: "2026-08-29T02:00:00.000Z",
    evidence: ["stored evidence is intentionally not replayed here"],
    wait: { condition: "the pipeline result", reviewAt: "2026-08-29T02:00:00.000Z" },
  }], [{
    goalId: "g_unstarted",
    contract: { objective: "Run the saved migration." },
  }], {
    agents: [{ pane_id: "w1:p2", terminal_id: "term_one", agent_session: session, agent_status: "idle" }],
    panes: [{ pane_id: "w1:p2", terminal_id: "term_one" }],
  }, { observerConnected: true, pendingFocusedReviews: 0 }, new Date("2026-08-29T01:00:00.000Z"));

  assert.equal(snapshot.goals[0].workerState, "idle");
  assert.equal(snapshot.goals[0].checkpointAgeMs, 3_600_000);
  assert.equal("progressAgeMs" in snapshot.goals[0], false);
  assert.equal(snapshot.goals[0].wait.condition, "the pipeline result");
  assert.deepEqual(snapshot.goals[1], {
    goalId: "g_unstarted",
    outcome: "Run the saved migration.",
    workerState: "unstarted",
  });
  assert.doesNotMatch(JSON.stringify(snapshot), /stored evidence|journal|messages|terminal output/);
});

test("global checkpoint is small supervisor-local state and survives restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "herdr-global-review-"));
  assert.deepEqual(await loadGlobalReviewState(root), emptyGlobalReviewState());
  const state = {
    version: 1,
    lastReviewedAt: "2026-08-29T01:00:00.000Z",
    nextReviewAt: "2026-08-29T02:00:00.000Z",
    snapshotHash: "snapshot",
    lastFindingHash: "finding",
    lastFinding: "- One known finding",
  };
  await saveGlobalReviewState(state, root);
  assert.deepEqual(await loadGlobalReviewState(root), state);
});

test("finding hashes ignore finding and goal ordering", () => {
  const first = [
    { problem: "Two goals wait on each other", evidence: ["g_one -> g_two"], affectedGoalIds: ["g_two", "g_one"] },
    { problem: "One worker is lost", evidence: ["pane missing", "session saved"], affectedGoalIds: ["g_three"] },
  ];
  const second = [
    { problem: "One worker is lost", evidence: ["session saved", "pane missing"], affectedGoalIds: ["g_three"] },
    { problem: "Two goals wait on each other", evidence: ["g_one -> g_two"], affectedGoalIds: ["g_one", "g_two"] },
  ];
  assert.equal(globalFindingHash(first), globalFindingHash(second));
});

test("global review routes an actionable finding into ordinary focused review", () => {
  const message = globalReviewMessage({ goals: [{
    goalId: "g_active",
    outcome: "Keep the release healthy.",
    workerState: "idle",
  }] }, "bounded system review", [
    "- The active goal still names a retired owner.",
    "  Affects: g_active",
  ].join("\n"), new Date("2026-09-05T01:00:00.000Z"));

  assert.match(message, /Findings report facts; reconsider routes action/);
  assert.match(message, /Record exactly one successful result with supervisor_global_result/);
  assert.match(message, /rejects a result before routing worker action, correct it and retry in this turn/);
  assert.match(message, /never repeat a successful result/);
  assert.match(message, /Do not merely repeat an actionable finding/);
  assert.match(message, /put that exact fact and goal in reconsider/);
  assert.match(message, /ask the human one concrete question when durable authority is needed/);
  assert.match(message, /healthy focused review or future bounded wait already covers it/);
});
