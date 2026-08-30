import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildGlobalSnapshot,
  emptyGlobalReviewState,
  globalFindingHash,
  loadGlobalReviewState,
  saveGlobalReviewState,
} from "../src/global-review.ts";

const session = { source: "herdr:codex", agent: "codex", kind: "id", value: "session_one" };

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
  assert.equal(snapshot.goals[0].progressAgeMs, 3_600_000);
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
  };
  await saveGlobalReviewState(state, root);
  assert.deepEqual(await loadGlobalReviewState(root), state);
});

test("finding hashes coalesce the same semantic report", () => {
  const first = [{ problem: "Two goals wait on each other", evidence: ["g_one -> g_two"], affectedGoalIds: ["g_two", "g_one"] }];
  const second = [{ problem: "Two goals wait on each other", evidence: ["g_one -> g_two"], affectedGoalIds: ["g_one", "g_two"] }];
  assert.equal(globalFindingHash(first), globalFindingHash(second));
});
