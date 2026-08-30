import assert from "node:assert/strict";
import test from "node:test";
import { sameAgentSession } from "../src/identity.ts";
import {
  captureIdentity,
  dependentBindings,
  dueBindings,
  findPane,
  formatWorker,
  identityMismatch,
  liveWorker,
  nextReviewDelay,
  recoveryRequest,
  reviewDeadline,
  shouldWake,
} from "../src/supervision.ts";
import { reviewMessage, supervisorSystemPrompt } from "../src/prompts.ts";

test("review deadlines share one bounded validation rule", () => {
  const now = Date.parse("2026-08-28T00:00:00.000Z");
  assert.equal(reviewDeadline("2026-08-28T00:01:00.000Z", now), now + 60_000);
  assert.equal(reviewDeadline("2026-08-28T08:01:00+08:00", now), now + 60_000);
  assert.throws(() => reviewDeadline("later", now), /between one second and 24 hours/);
  assert.throws(() => reviewDeadline("2026-08-28T00:01:00", now), /timezone-bearing ISO 8601/);
  assert.throws(() => reviewDeadline("08\/28\/2026 00:01:00 UTC", now), /timezone-bearing ISO 8601/);
  assert.throws(() => reviewDeadline("2026-02-29T00:00:00Z", Date.parse("2026-02-28T00:00:00Z")), /timezone-bearing ISO 8601/);
  assert.equal(
    reviewDeadline("2028-02-29T00:00:00Z", Date.parse("2028-02-28T23:59:00Z")),
    Date.parse("2028-02-29T00:00:00Z"),
  );
  assert.throws(() => reviewDeadline("2026-08-30T00:00:00.000Z", now), /between one second and 24 hours/);
});

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

test("native session equality has one exact identity contract", () => {
  const session = agent().agent_session;
  assert.equal(sameAgentSession(session, { ...session }), true);
  assert.equal(sameAgentSession(session, { ...session, value: "replacement" }), false);
  assert.equal(sameAgentSession(session, undefined), false);
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

test("a durable peer identity selects only waits linked to that exact goal", () => {
  const workers = [
    { goalId: "g_waiting", paneId: "w1:p2", wait: { goalId: "g_peer", paneId: "w1:p7" } },
    { goalId: "g_other", paneId: "w1:p3", wait: { goalId: "g_else", paneId: "w1:p8" } },
    { goalId: "g_external", paneId: "w1:p4", wait: { condition: "an external approval" } },
    { goalId: "g_peer", paneId: "w1:p9" },
  ];
  assert.deepEqual(
    dependentBindings(workers, workers[3]).map((worker) => worker.paneId),
    ["w1:p2"],
  );
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
  const current = binding({
    goalId: undefined,
    goal: "finish the goal",
    progress: undefined,
    externalChange: {
      source: "github-pr",
      subject: "hao1939/herdr-supervisor#16",
      revision: "revision-2",
      observedAt: "2026-08-30T05:01:00.000Z",
      workerSequence: 7,
    },
  });
  assert.equal(
    formatWorker(liveWorker(current, snapshot(null))),
    [
      "Goal · needs attention",
      "  Objective: finish the goal",
      "  Worker: codex w1:p2 · process stopped",
      "  Next: supervisor should review whether the exact session can resume",
    ].join("\n"),
  );
});

test("a missing pane is recoverable supervision work, not human work", () => {
  const current = binding({ goalId: "g_open" });
  const output = formatWorker(liveWorker(current, { agents: [], panes: [] }));

  assert.match(output, /Worker: codex w1:p2 · pane missing/);
  assert.match(output, /Next: supervisor should review whether the exact session can resume in a new pane/);
  assert.doesNotMatch(output, /Needs you/);
});

test("a finished worker turn is not presented as a finished goal", () => {
  const current = binding({
    goalId: "g_open",
    progress: "Repository work is complete, but required external proof is still pending.",
    wait: {
      condition: "the external evaluation to publish its result",
      reviewAt: "2026-08-29T09:53:30.000Z",
    },
  });
  const output = formatWorker(liveWorker(current, snapshot(agent({ agent_status: "done" }))));
  assert.match(output, /^Goal g_open · waiting$/m);
  assert.match(output, /Worker: codex w1:p2 · turn finished/);
  assert.doesNotMatch(output, /^Goal g_open · (done|completed)$/m);
});

test("a persisted human question is the next action shown after restart", () => {
  const current = binding({
    progress: "Human input is required: may this worker use shared capacity?",
    lastDecision: {
      decision: "ask_human",
      at: "2026-08-28T10:00:00.000Z",
      action: "May this worker use shared capacity?",
    },
  });
  const output = formatWorker(liveWorker(current, snapshot(agent({ agent_status: "idle" }))));
  assert.match(output, /Next: answer the supervisor's question above/);
  assert.doesNotMatch(output, /review current evidence/);
});

test("a missing pane does not hide an outstanding human question", () => {
  const current = binding({
    lastDecision: {
      decision: "ask_human",
      at: "2026-08-28T10:00:00.000Z",
      action: "May this worker use shared capacity?",
    },
  });
  const output = formatWorker(liveWorker(current, { agents: [], panes: [] }));

  assert.match(output, /^Goal g_test · waiting for you$/m);
  assert.match(output, /Next: answer the supervisor's question above/);
  assert.match(output, /worker recovery can follow your answer/);
});

test("the all-worker view stays bounded while one-worker detail stays complete", () => {
  const current = binding({
    goal: `Review the system ${"goal detail ".repeat(80)}`,
    acceptance: ["The complete acceptance evidence remains available in detail."],
    progress: `Current finding ${"progress detail ".repeat(80)}`,
  });
  const live = liveWorker(current, snapshot());
  const summary = formatWorker(live, { detailed: false });
  const detail = formatWorker(live);

  assert.ok(summary.length < 1000);
  assert.match(summary, /Review the system goal detail/);
  assert.doesNotMatch(summary, /Accept when:/);
  assert.match(summary, /…/);
  assert.match(detail, /Accept when: The complete acceptance evidence remains available in detail/);
  assert.ok(detail.length > summary.length);
});

test("a settled future wait shows its condition and review time", () => {
  const current = binding({
    progress: "Local proof is complete.",
    wait: {
      condition: "the capacity owner to release the shared pipeline slot",
      reviewAt: "2026-08-29T09:53:30.000Z",
    },
    externalWatch: {
      source: "github-pr",
      subject: "hao1939/herdr-supervisor#16",
      nextPollAt: Date.parse("2026-08-29T09:50:00.000Z"),
    },
  });
  const output = formatWorker(liveWorker(current, snapshot(agent({ agent_status: "idle" }))));
  assert.match(output, /Next: wait for the capacity owner to release the shared pipeline slot/);
  assert.match(output, /Watching: github-pr hao1939\/herdr-supervisor#16/);
  assert.match(output, /Review at: 2026-08-29T09:53:30.000Z/);
  assert.doesNotMatch(output, /review current evidence/);
});

test("an unresolved external change is the visible next action", () => {
  const current = binding({
    progress: "The old PR snapshot was reviewed.",
    wait: {
      condition: "the old PR checks to finish",
      reviewAt: "2026-08-30T06:01:00.000Z",
    },
    externalChange: {
      source: "github-pr",
      subject: "hao1939/herdr-supervisor#16",
      revision: "revision-2",
      observedAt: "2026-08-30T05:01:00.000Z",
    },
  });
  const output = formatWorker(liveWorker(current, snapshot(agent({ agent_status: "idle" }))));
  assert.match(output, /Goal g_test · needs review/);
  assert.match(output, /Next: worker must reread github-pr hao1939\/herdr-supervisor#16/);
  assert.doesNotMatch(output, /Goal g_test · waiting/);
  assert.doesNotMatch(output, /review current evidence/);
});

test("an external reread in progress is shown as working", () => {
  const current = binding({
    externalChange: {
      source: "github-pr",
      subject: "hao1939/herdr-supervisor#16",
      revision: "revision-2",
      observedAt: "2026-08-30T05:01:00.000Z",
      workerSequence: 7,
    },
  });
  const output = formatWorker(liveWorker(current, snapshot(agent({ agent_status: "working" }))));
  assert.match(output, /Goal g_test · working/);
  assert.match(output, /Next: worker is rereading github-pr hao1939\/herdr-supervisor#16/);
});

test("a settled reread with a stale wait is shown as needs review, not waiting", () => {
  const current = binding({
    wait: {
      condition: "the old PR checks to finish",
      reviewAt: "2026-08-30T06:01:00.000Z",
    },
    externalChange: {
      source: "github-pr",
      subject: "hao1939/herdr-supervisor#16",
      revision: "revision-2",
      observedAt: "2026-08-30T05:01:00.000Z",
      workerSequence: 7,
    },
  });
  const output = formatWorker(liveWorker(current, snapshot(agent({ agent_status: "idle" }))));
  assert.match(output, /Goal g_test · needs review/);
  assert.doesNotMatch(output, /Goal g_test · waiting/);
  assert.match(output, /Next: supervisor should review the worker's reread result/);
});

test("a working goal shows its exact promised review time", () => {
  const current = binding({
    progress: "The worker is advancing independent work before the retry.",
    reviewAt: "2026-08-29T09:53:30.000Z",
  });
  const output = formatWorker(liveWorker(current, snapshot(agent({ agent_status: "working" }))));
  assert.match(output, /Next: review when the worker settles or blocks/);
  assert.match(output, /Supervisor rechecks at: 2026-08-29T09:53:30.000Z/);
  assert.doesNotMatch(output, /waiting/);
});

test("changed worker identity takes priority over an earlier human question", () => {
  const current = binding({
    lastDecision: {
      decision: "ask_human",
      at: "2026-08-28T10:00:00.000Z",
      action: "May this worker use shared capacity?",
    },
  });
  const replacement = agent({
    agent_session: { ...agent().agent_session, value: "replacement-session" },
  });
  const output = formatWorker(liveWorker(current, snapshot(replacement)));
  assert.match(output, /Needs you: worker value changed; supervision is paused/);
  assert.doesNotMatch(output, /answer the supervisor's question above/);
});

test("review notice explains the goal and signal in plain language", () => {
  const current = binding({
    goal: "Fix cancellation",
    acceptance: ["focused test passes"],
    evidence: ["The server supplied retry boundary 2026-08-29T00:00:00Z."],
    wait: {
      condition: "the server retry boundary",
      reviewAt: "2026-08-29T00:00:00Z",
    },
  });
  const message = reviewMessage(
    current,
    agent({ agent_status: "idle" }),
    "worker is idle",
    new Date("2026-08-28T23:59:00.000Z"),
  );
  assert.match(message, /Worker review · codex w1:p2/);
  assert.match(message, /Review time: 2026-08-28T23:59:00.000Z \(UTC\)/);
  assert.match(message, /Goal\n  Fix cancellation/);
  assert.match(message, /Why review now\n  worker is idle; Herdr reports idle/);
  assert.match(message, /Worker acceptance criteria\n- focused test passes/);
  assert.match(message, /Current wait\n  the server retry boundary\n  Review at: 2026-08-29T00:00:00Z/);
  assert.match(message, /Current evidence\n- The server supplied retry boundary/);
  assert.match(message, /Observe this exact worker/);
  assert.match(message, /supervisor_status to read current recorded peer progress/);
  assert.match(message, /only this worker's evidence can prove this goal complete/);
  assert.match(message, /Your own response is not worker evidence/);
  assert.match(message, /confirm that the condition still exists/);
  assert.match(message, /fresh evidence must cover every part you claim remains unchanged/);
  assert.match(message, /steer the worker to reread it rather than infer unchanged state from silence or older evidence/);
  assert.match(message, /continue any independent useful work/);
  assert.match(message, /durable goal is still coherent, useful, and achievable/);
  assert.match(message, /current blocker stops the whole outcome or only one path/);
  assert.match(message, /alternative proof, or preparation/);
  assert.match(message, /goal contract itself is obsolete, contradictory, or impractical/);
  assert.match(message, /ask the human one concrete question/);
  assert.match(message, /final worker message, PR, run, report, or completed review cycle as evidence/);
  assert.match(message, /whole objective and every acceptance criterion at the same declared scope and time horizon/);
  assert.match(message, /criteria quietly narrow a broader or ongoing objective to one milestone/);
  assert.match(message, /standing improvement loop/);
  assert.match(message, /Do not invent a finite convergence boundary for standing work/);
  assert.match(message, /Compare all timestamps with the UTC review time above/);
});

test("every supervisor turn receives the null protocol for optional tool fields", () => {
  const prompt = supervisorSystemPrompt("Base prompt.");
  assert.match(prompt, /For every optional tool argument that does not apply, use JSON null/);
  assert.match(prompt, /never invent a placeholder value, identity, revision, watch, wait, or deadline/);
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
