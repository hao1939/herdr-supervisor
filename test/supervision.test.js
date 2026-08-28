import assert from "node:assert/strict";
import test from "node:test";
import {
  captureIdentity,
  dueBindings,
  findPane,
  formatWorker,
  identityMismatch,
  liveWorker,
  nextReviewDelay,
  recoveryRequest,
  reviewMessage,
  shouldWake,
} from "../src/supervision.js";

function agent(overrides = {}) {
  return {
    pane_id: "w1:p2",
    terminal_id: "term-1",
    agent: "codex",
    agent_status: "working",
    state_change_seq: 10,
    agent_session: { source: "herdr:codex", agent: "codex", kind: "id", value: "session-1" },
    ...overrides,
  };
}

function snapshot(currentAgent = agent(), overrides = {}) {
  return {
    agents: currentAgent ? [currentAgent] : [],
    panes: [{ pane_id: "w1:p2", terminal_id: "term-1" }],
    ...overrides,
  };
}

function binding(overrides = {}) {
  return {
    goalId: "g_test",
    ...captureIdentity(agent()),
    goal: "goal",
    context: [],
    acceptance: [],
    constraints: [],
    evidence: [],
    progress: "Goal started; awaiting the first review.",
    lastReviewStateChangeSeq: 0,
    ...overrides,
  };
}

test("worker identity captures the exact native session", () => {
  assert.deepEqual(captureIdentity(agent()), {
    paneId: "w1:p2",
    terminalId: "term-1",
    agentSession: { source: "herdr:codex", agent: "codex", kind: "id", value: "session-1" },
  });
});

test("one nearest deadline selects only workers due for review", () => {
  const now = new Date("2026-08-28T00:00:00.000Z");
  const workers = [
    { paneId: "w1:p1", nextReviewAt: "2026-08-28T00:02:00.000Z" },
    { paneId: "w1:p2", nextReviewAt: "2026-08-27T23:59:00.000Z" },
    { paneId: "w1:p3", nextReviewAt: "2026-08-28T00:05:00.000Z" },
  ];
  assert.equal(nextReviewDelay(workers, now), 0);
  assert.deepEqual(dueBindings(workers, now).map((worker) => worker.paneId), ["w1:p2"]);
  assert.equal(nextReviewDelay(workers.filter((worker) => worker.paneId !== "w1:p2"), now), 120_000);
  assert.equal(nextReviewDelay([], now), undefined);
});

test("bindings without a deadline receive one recovery review", () => {
  const workers = [{ paneId: "w1:p1" }];
  assert.equal(nextReviewDelay(workers), 0);
  assert.deepEqual(dueBindings(workers).map((worker) => worker.paneId), ["w1:p1"]);
});

test("working is quiet while settled and blocked states wake review", () => {
  const current = binding();
  const pane = findPane(snapshot(), "w1:p2");
  assert.equal(shouldWake(current, agent(), pane).wake, false);
  assert.deepEqual(shouldWake(current, agent({ agent_status: "idle", state_change_seq: 11 }), pane), {
    wake: true,
    reason: "worker is idle",
    sequence: 11,
    key: "state:11:idle",
  });
  assert.equal(shouldWake(current, agent({ agent_status: "blocked", state_change_seq: 12 }), pane).wake, true);
  current.lastReviewStateChangeSeq = 12;
  assert.equal(shouldWake(current, agent({ agent_status: "blocked", state_change_seq: 12 }), pane).wake, false);
});

test("a restored idle worker with no transition sequence is reviewed once", () => {
  const current = binding({ lastReviewStateChangeSeq: 0 });
  const currentPane = findPane(snapshot(), "w1:p2");
  const decision = shouldWake(current, agent({ agent_status: "idle", state_change_seq: 0 }), currentPane);
  assert.equal(decision.wake, true);
  assert.equal(decision.key, "state:0:idle");
});

test("replaced worker fails closed", () => {
  const current = binding();
  assert.equal(identityMismatch(current, agent()), undefined);
  assert.equal(identityMismatch(current, agent({ terminal_id: "term-2" })), undefined);
  assert.match(
    identityMismatch(current, agent({ agent_session: { ...agent().agent_session, value: "session-2" } })),
    /value changed/,
  );
  assert.match(identityMismatch(current, undefined, findPane(snapshot(null), "w1:p2")), /process is no longer detected/);
  assert.match(identityMismatch(current, undefined, undefined), /pane is no longer present/);
  assert.equal(shouldWake(current, undefined, findPane(snapshot(null), "w1:p2")).wake, true);
});

test("recovery resumes only the exact supported session in the same terminal", () => {
  const current = binding();
  assert.deepEqual(recoveryRequest(current, snapshot(null)), {
    name: "codex",
    kind: "codex",
    paneId: "w1:p2",
    args: ["resume", "session-1"],
  });
  assert.throws(() => recoveryRequest(current, snapshot()), /still present/);
  assert.throws(() => recoveryRequest(current, snapshot(null, { panes: [] })), /pane is no longer present/);
  assert.throws(
    () => recoveryRequest(current, snapshot(null, { panes: [{ pane_id: "w1:p2", terminal_id: "term-2" }] })),
    /different terminal/,
  );
  assert.throws(
    () => recoveryRequest({ ...current, agentSession: { agent: "claude", kind: "id", value: "session-1" } }, snapshot(null)),
    /not available/,
  );
});

test("stopped process is shown as recoverable supervision work, not changed identity", () => {
  const current = binding({ goalId: undefined, goal: "finish the goal", progress: undefined });
  assert.equal(
    formatWorker(liveWorker(current, snapshot(null))),
    [
      "codex w1:p2 · process stopped",
      "  Goal: finish the goal",
      "  Next: supervisor should review whether the exact session can resume",
    ].join("\n"),
  );
});

test("review notice explains the goal and signal in plain language", () => {
  const current = binding({ goal: "Fix cancellation", acceptance: ["focused test passes"] });
  const message = reviewMessage(current, agent({ agent_status: "idle" }), "worker is idle");
  assert.match(message, /Worker review · codex w1:p2/);
  assert.match(message, /Goal\n  Fix cancellation/);
  assert.match(message, /Why review now\n  worker is idle; Herdr reports idle/);
  assert.match(message, /Worker acceptance criteria\n- focused test passes/);
  assert.match(message, /Observe this exact worker/);
  assert.match(message, /Your own response is not worker evidence/);
  assert.doesNotMatch(message, /supervisor_observe/);
});

test("each shared-session review request re-establishes one worker context", () => {
  const first = binding({ goalId: "g_first", goal: "Fix API cancellation", acceptance: ["API test passes"] });
  const second = binding({
    goalId: "g_second",
    paneId: "w1:p3",
    terminalId: "term-3",
    agentSession: { ...agent().agent_session, value: "session-3" },
    goal: "Simplify the console view",
    acceptance: ["console output is readable"],
  });
  const firstRequest = reviewMessage(first, agent({ agent_status: "idle" }), "worker is idle");
  const secondRequest = reviewMessage(
    second,
    agent({ pane_id: "w1:p3", terminal_id: "term-3", agent_status: "blocked", agent_session: { ...agent().agent_session, value: "session-3" } }),
    "worker is blocked",
  );

  assert.match(firstRequest, /w1:p2/);
  assert.match(firstRequest, /Fix API cancellation/);
  assert.doesNotMatch(firstRequest, /Simplify the console view|w1:p3/);
  assert.match(secondRequest, /w1:p3/);
  assert.match(secondRequest, /Simplify the console view/);
  assert.doesNotMatch(secondRequest, /Fix API cancellation|w1:p2/);
});
