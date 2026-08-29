import assert from "node:assert/strict";
import { mkdir, mkdtemp, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import herdrSupervisor from "../extension.ts";
import { loadSupervisorGoals, recordDecision, registerSupervisedGoal } from "../src/goal-registry.js";
import { goalPaths, loadGoalContract, readAudit } from "../src/goal-store.js";
import { HerdrClient } from "../src/herdr-client.js";
import { loadGlobalReviewState, saveGlobalReviewState } from "../src/global-review.js";

const worker = {
  paneId: "w1:p2",
  terminalId: "term_test",
  agentSession: { source: "herdr:codex", agent: "codex", kind: "id", value: "session_test" },
};

function fakePi({ reviewMs = "600000", globalReviewMs = "0" } = {}) {
  const commands = new Map();
  const tools = new Map();
  const events = new Map();
  const messages = [];
  return {
    commands,
    tools,
    events,
    messages,
    registerFlag() {},
    getFlag(name) {
      if (name === "supervisor-mode") return "live";
      if (name === "supervisor-review-ms") return reviewMs;
      if (name === "supervisor-global-review-ms") return globalReviewMs;
    },
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand(name, command) { commands.set(name, command); },
    on(name, handler) { events.set(name, handler); },
    sendMessage(message) { messages.push(message); },
    setActiveTools() {},
  };
}

function snapshot(agent = {}) {
  const current = {
    pane_id: worker.paneId,
    terminal_id: worker.terminalId,
    agent_status: "blocked",
    state_change_seq: 2,
    agent_session: worker.agentSession,
    interactive_ready: true,
    ...agent,
  };
  return {
    agents: agent === null ? [] : [current],
    panes: [{ pane_id: worker.paneId, terminal_id: agent === null ? worker.terminalId : current.terminal_id }],
  };
}

async function waitFor(check) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for supervisor review");
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "herdr-supervisor-extension-"));
  await registerSupervisedGoal(worker, {
    objective: "Finish the exact goal.",
    acceptance: ["The focused proof passes."],
  }, root, { goalId: "g_test" });
  return root;
}

test("a human goal creates, prompts, and supervises one Codex worker", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "herdr-supervisor-start-"));
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  const previousPane = process.env.HERDR_PANE_ID;
  const previousFullAccess = process.env.HERDR_SUPERVISOR_CODEX_FULL_ACCESS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  process.env.HERDR_PANE_ID = "w1:p1";
  process.env.HERDR_SUPERVISOR_CODEX_FULL_ACCESS = "1";
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
    if (previousPane === undefined) delete process.env.HERDR_PANE_ID;
    else process.env.HERDR_PANE_ID = previousPane;
    if (previousFullAccess === undefined) delete process.env.HERDR_SUPERVISOR_CODEX_FULL_ACCESS;
    else process.env.HERDR_SUPERVISOR_CODEX_FULL_ACCESS = previousFullAccess;
  });

  const managed = {
    pane_id: "w1:p3",
    terminal_id: "term_managed",
    agent_status: "idle",
    state_change_seq: 1,
    agent_session: { source: "herdr:codex", agent: "codex", kind: "id", value: "session_managed" },
    interactive_ready: true,
    tab_id: "w1:t2",
    workspace_id: "w1",
  };
  let createTabRequest;
  let startRequest;
  const deliveredPrompts = [];
  t.mock.method(HerdrClient.prototype, "createTab", async (request) => {
    createTabRequest = request;
    return {
      type: "tab_created",
      tab: { tab_id: "w1:t2" },
      root_pane: { pane_id: managed.pane_id, tab_id: "w1:t2" },
    };
  });
  t.mock.method(HerdrClient.prototype, "startAndWaitAgent", async (request) => {
    startRequest = request;
    return managed;
  });
  t.mock.method(HerdrClient.prototype, "snapshot", async () => ({
    agents: [managed],
    panes: [
      { pane_id: "w1:p1", terminal_id: "term_supervisor", tab_id: "w1:t1", workspace_id: "w1" },
      { pane_id: managed.pane_id, terminal_id: managed.terminal_id, tab_id: "w1:t2", workspace_id: "w1" },
    ],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "Supervisor" }],
  }));
  t.mock.method(HerdrClient.prototype, "promptAgent", async (_paneId, prompt) => {
    deliveredPrompts.push({
      prompt,
      bindingExists: (await loadSupervisorGoals(root)).active.length === 1,
    });
  });
  t.mock.method(HerdrClient.prototype, "waitForAgentSession", async () => managed);
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const pi = fakePi();
  herdrSupervisor(pi);
  const result = await pi.tools.get("supervisor_start_goal").execute("start", {
    goal: "Fix the focused regression.",
    context: ["Another worker is validating the same repository."],
    acceptance: ["The focused test passes.", "The change is reviewed."],
    constraints: ["Make changes only in an isolated worktree."],
    placement: { mode: "new", label: "sample-project" },
    working_directory: "/app/projects/sample-project",
    direction: "down",
  }, undefined, undefined, { ui: { setStatus() {} } });

  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /Started and supervised goal/);
  assert.deepEqual(createTabRequest, {
    workspaceId: "w1",
    cwd: "/app/projects/sample-project",
    label: "sample-project",
    focus: false,
  });
  assert.equal(startRequest.kind, "codex");
  assert.equal(startRequest.paneId, managed.pane_id);
  assert.match(startRequest.name, /^goal-[a-z0-9_-]+$/);
  assert.ok(startRequest.name.length <= 32);
  assert.deepEqual(startRequest.args, [
    "--dangerously-bypass-approvals-and-sandbox",
    "--dangerously-bypass-hook-trust",
    "--disable",
    "goals",
  ]);
  assert.match(deliveredPrompts[0].prompt, /Initialize this worker session only/);
  assert.equal(deliveredPrompts[0].bindingExists, false);
  assert.doesNotMatch(deliveredPrompts[0].prompt, /Fix the focused regression/);
  assert.match(deliveredPrompts[1].prompt, /Fix the focused regression/);
  assert.match(deliveredPrompts[1].prompt, /Another worker is validating the same repository/);
  assert.match(deliveredPrompts[1].prompt, /The focused test passes/);
  assert.match(deliveredPrompts[1].prompt, /Make changes only in an isolated worktree/);
  assert.match(deliveredPrompts[1].prompt, /every other worker's worktree as read-only/);
  assert.match(deliveredPrompts[1].prompt, /Create another goal-owned worktree/);
  assert.match(deliveredPrompts[1].prompt, /distinguish missing convenience tooling/);
  assert.match(deliveredPrompts[1].prompt, /Write progress and final results in plain language/);
  assert.equal(deliveredPrompts[1].bindingExists, true);
  const goals = await loadSupervisorGoals(root);
  assert.equal(goals.active.length, 1);
  assert.equal(goals.active[0].paneId, managed.pane_id);
  assert.deepEqual(goals.active[0].context, ["Another worker is validating the same repository."]);
  assert.deepEqual(goals.active[0].acceptance, ["The focused test passes.", "The change is reviewed."]);
  assert.deepEqual(goals.active[0].constraints, ["Make changes only in an isolated worktree."]);
  pi.events.get("session_shutdown")();
});

test("the supervisor can place related workers in the same tab", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "herdr-supervisor-related-start-"));
  const related = {
    paneId: "w1:p2",
    terminalId: "term_related",
    agentSession: { source: "herdr:codex", agent: "codex", kind: "id", value: "session_related" },
  };
  await registerSupervisedGoal(related, {
    objective: "Prepare the related design.",
    acceptance: ["The design is reviewable."],
  }, root, { goalId: "g_related" });

  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  const previousPane = process.env.HERDR_PANE_ID;
  const previousFullAccess = process.env.HERDR_SUPERVISOR_CODEX_FULL_ACCESS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  process.env.HERDR_PANE_ID = "w1:p1";
  delete process.env.HERDR_SUPERVISOR_CODEX_FULL_ACCESS;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
    if (previousPane === undefined) delete process.env.HERDR_PANE_ID;
    else process.env.HERDR_PANE_ID = previousPane;
    if (previousFullAccess === undefined) delete process.env.HERDR_SUPERVISOR_CODEX_FULL_ACCESS;
    else process.env.HERDR_SUPERVISOR_CODEX_FULL_ACCESS = previousFullAccess;
  });

  const started = {
    pane_id: "w1:p3",
    terminal_id: "term_started",
    agent_status: "working",
    state_change_seq: 1,
    agent_session: { source: "herdr:codex", agent: "codex", kind: "id", value: "session_started" },
    interactive_ready: true,
    tab_id: "w1:t2",
    workspace_id: "w1",
  };
  const relatedAgent = {
    pane_id: related.paneId,
    terminal_id: related.terminalId,
    agent_status: "working",
    state_change_seq: 1,
    agent_session: related.agentSession,
    interactive_ready: true,
    tab_id: "w1:t2",
    workspace_id: "w1",
  };
  let splitRequest;
  let startRequest;
  t.mock.method(HerdrClient.prototype, "snapshot", async () => ({
    agents: [relatedAgent, started],
    panes: [
      { pane_id: "w1:p1", terminal_id: "term_supervisor", tab_id: "w1:t1", workspace_id: "w1" },
      { pane_id: related.paneId, terminal_id: related.terminalId, tab_id: "w1:t2", workspace_id: "w1" },
      { pane_id: started.pane_id, terminal_id: started.terminal_id, tab_id: "w1:t2", workspace_id: "w1" },
    ],
  }));
  t.mock.method(HerdrClient.prototype, "splitPane", async (request) => {
    splitRequest = request;
    return { type: "pane_info", pane: { pane_id: started.pane_id } };
  });
  t.mock.method(HerdrClient.prototype, "startAndWaitAgent", async (request) => {
    startRequest = request;
    return started;
  });
  t.mock.method(HerdrClient.prototype, "promptAgent", async () => {});
  t.mock.method(HerdrClient.prototype, "waitForAgentSession", async () => started);
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const pi = fakePi();
  herdrSupervisor(pi);
  const result = await pi.tools.get("supervisor_start_goal").execute("start-related", {
    goal: "Implement the related design.",
    acceptance: ["The focused proof passes."],
    placement: { mode: "related", pane_id: related.paneId },
    working_directory: "/app/projects/example",
    direction: "right",
  }, undefined, undefined, { ui: { setStatus() {} } });

  assert.equal(result.isError, false);
  assert.deepEqual(splitRequest, {
    paneId: related.paneId,
    direction: "right",
    cwd: "/app/projects/example",
    focus: false,
  });
  assert.equal(startRequest.paneId, started.pane_id);
  assert.deepEqual(startRequest.args, ["--disable", "goals"]);
  pi.events.get("session_shutdown")();
});

test("a human refinement updates the durable goal and informs the same worker", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "herdr-supervisor-refine-"));
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  await registerSupervisedGoal(worker, {
    objective: "Fix the focused regression.",
    acceptance: ["The focused test passes."],
  }, root, { goalId: "g_test" });
  const prompts = [];
  t.mock.method(HerdrClient.prototype, "snapshot", async () => snapshot({ agent_status: "working" }));
  t.mock.method(HerdrClient.prototype, "promptAgent", async (paneId, prompt) => prompts.push({ paneId, prompt }));
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const pi = fakePi();
  herdrSupervisor(pi);
  const result = await pi.tools.get("supervisor_update_goal").execute("refine", {
    pane_id: worker.paneId,
    goal: "Fix and validate the focused regression.",
    context: ["Another worker owns adjacent files."],
    acceptance: ["The focused test passes.", "The exact commit passes the ADO pipeline."],
    constraints: ["Use an isolated worktree and a focused PR."],
    summary: "Added exact-commit ADO and PR-isolation requirements.",
  });

  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /same worker w1:p2; no new goal or worker was created/);
  const contract = await loadGoalContract("g_test", root);
  assert.equal(contract.objective, "Fix and validate the focused regression.");
  assert.deepEqual(contract.acceptance, ["The focused test passes.", "The exact commit passes the ADO pipeline."]);
  assert.deepEqual(contract.constraints, ["Use an isolated worktree and a focused PR."]);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].paneId, worker.paneId);
  assert.match(prompts[0].prompt, /complete durable contract/);
  assert.match(prompts[0].prompt, /exact commit passes the ADO pipeline/);
  assert.match(prompts[0].prompt, /every other worker's worktree as read-only/);
  assert.match(prompts[0].prompt, /genuinely missing capability, authority, or information/);
  assert.match(prompts[0].prompt, /operation that failed, where it ran, the effective identity or authority/);
  assert.match(prompts[0].prompt, /authentication in one host, container, identity, or service changes another/);
  assert.match(prompts[0].prompt, /Write progress and final results in plain language/);
  assert.equal((await readAudit("g_test", root)).at(-1).type, "goal_refined");
  pi.events.get("session_shutdown")();
});

test("one transient human fact queues separate focused reviews without rewriting goals", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "herdr-supervisor-reconsider-"));
  const secondWorker = {
    paneId: "w1:p7",
    terminalId: "term_second",
    agentSession: { source: "herdr:codex", agent: "codex", kind: "id", value: "session_second" },
  };
  await registerSupervisedGoal(worker, {
    objective: "Finish the first exact goal.",
    context: ["Keep the durable first context."],
    acceptance: ["The first proof passes."],
  }, root, { goalId: "g_first" });
  await registerSupervisedGoal(secondWorker, {
    objective: "Finish the second exact goal.",
    context: ["Keep the durable second context."],
    acceptance: ["The second proof passes."],
  }, root, { goalId: "g_second" });
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  const agents = [
    snapshot({ agent_status: "working", state_change_seq: 4 }).agents[0],
    {
      pane_id: secondWorker.paneId,
      terminal_id: secondWorker.terminalId,
      agent_status: "working",
      state_change_seq: 5,
      agent_session: secondWorker.agentSession,
      interactive_ready: true,
    },
  ];
  t.mock.method(HerdrClient.prototype, "snapshot", async () => ({
    agents,
    panes: agents.map((agent) => ({ pane_id: agent.pane_id, terminal_id: agent.terminal_id })),
  }));
  t.mock.method(HerdrClient.prototype, "readAgent", async (paneId) => ({
    read: { text: `${paneId} is still pursuing its goal.`, truncated: false },
  }));
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const before = await Promise.all([
    loadGoalContract("g_first", root),
    loadGoalContract("g_second", root),
  ]);
  const pi = fakePi();
  herdrSupervisor(pi);
  const queued = await pi.tools.get("supervisor_reconsider").execute("reconsider", {
    pane_ids: [worker.paneId, secondWorker.paneId],
    reason: "the authenticated service path now succeeds",
  });

  assert.equal(queued.isError, false);
  assert.match(queued.content[0].text, /after this turn/);
  assert.equal(pi.messages.length, 0, "focused reviews must not interrupt the human turn");
  assert.deepEqual(await Promise.all([
    loadGoalContract("g_first", root),
    loadGoalContract("g_second", root),
  ]), before, "transient evidence must not rewrite portable goal contracts");

  await pi.events.get("agent_settled")();
  await waitFor(() => pi.messages.length === 1);
  assert.match(pi.messages[0].content, /w1:p2/);
  assert.match(pi.messages[0].content, /authenticated service path now succeeds/);
  const retained = await pi.tools.get("supervisor_reconsider").execute("nested-reconsider", {
    pane_ids: [secondWorker.paneId],
    reason: "new human input arrived during this review",
  });
  assert.equal(retained.isError, false);
  assert.match(retained.content[0].text, /Retained focused reconsideration for w1:p7 after it/);
  assert.equal(pi.messages.length, 1, "the retained review must not interrupt the current decision");

  await pi.tools.get("supervisor_observe").execute("observe-first", { pane_id: worker.paneId });
  const firstDecision = await pi.tools.get("supervisor_leave").execute("leave-first", {
    pane_id: worker.paneId,
    progress: "The first worker is actively pursuing the newly usable path.",
  });
  assert.equal(firstDecision.isError, false);
  await pi.events.get("agent_settled")();
  await waitFor(() => pi.messages.length === 2);
  assert.match(pi.messages[1].content, /w1:p7/);
  assert.match(pi.messages[1].content, /new human input arrived during this review/);
  pi.events.get("session_shutdown")();
});

test("reconsideration rejects an unknown worker without scheduling work", async (t) => {
  const root = await fixture();
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  const pi = fakePi();
  herdrSupervisor(pi);
  const result = await pi.tools.get("supervisor_reconsider").execute("unknown", {
    pane_ids: ["w1:p999"],
    reason: "new execution evidence",
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /unsupervised worker/);
  await pi.events.get("agent_settled")();
  assert.equal(pi.messages.length, 0);
  pi.events.get("session_shutdown")();
});

test("an accepted goal delegates normal reversible execution authority", () => {
  const pi = fakePi();
  herdrSupervisor(pi);
  const result = pi.events.get("before_agent_start")({ systemPrompt: "Base prompt." });
  assert.match(result.systemPrompt, /accepted goal delegates authority for its normal reversible in-scope execution steps/);
  assert.match(result.systemPrompt, /do not ask permission again merely to perform a step needed by its acceptance criteria/);
  assert.match(result.systemPrompt, /human input arrives during a focused worker review/);
  assert.match(result.systemPrompt, /retain any other affected workers for later/);
  pi.events.get("session_shutdown")();
});

test("a worker requires an explicit absolute working directory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "herdr-supervisor-worker-directory-"));
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  const previousPane = process.env.HERDR_PANE_ID;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  process.env.HERDR_PANE_ID = "w1:p1";
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
    if (previousPane === undefined) delete process.env.HERDR_PANE_ID;
    else process.env.HERDR_PANE_ID = previousPane;
  });

  let snapshots = 0;
  t.mock.method(HerdrClient.prototype, "snapshot", async () => {
    snapshots += 1;
    return { agents: [], panes: [] };
  });

  const pi = fakePi();
  herdrSupervisor(pi);
  const missing = await pi.tools.get("supervisor_start_goal").execute("missing-directory", {
    goal: "Fix one regression.",
    acceptance: ["The focused test passes."],
    placement: { mode: "new", label: "regression" },
  }, undefined, undefined, { ui: { setStatus() {} } });
  const relative = await pi.tools.get("supervisor_start_goal").execute("relative-directory", {
    goal: "Fix another regression.",
    acceptance: ["The focused test passes."],
    placement: { mode: "new", label: "regression" },
    working_directory: ".",
  }, undefined, undefined, { ui: { setStatus() {} } });

  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /working_directory/);
  assert.equal(relative.isError, true);
  assert.match(relative.content[0].text, /absolute path/);
  assert.equal(snapshots, 0);
  pi.events.get("session_shutdown")();
});

test("a missing native session cannot leave assigned work running unsupervised", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "herdr-supervisor-session-gate-"));
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  const previousPane = process.env.HERDR_PANE_ID;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  process.env.HERDR_PANE_ID = "w1:p1";
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
    if (previousPane === undefined) delete process.env.HERDR_PANE_ID;
    else process.env.HERDR_PANE_ID = previousPane;
  });

  const prompts = [];
  const managed = {
    pane_id: "w1:p3",
    terminal_id: "term_managed",
    agent_status: "idle",
    interactive_ready: true,
    tab_id: "w1:t2",
    workspace_id: "w1",
  };
  t.mock.method(HerdrClient.prototype, "snapshot", async () => ({
    agents: [managed],
    panes: [
      { pane_id: "w1:p1", terminal_id: "term_supervisor", tab_id: "w1:t1", workspace_id: "w1" },
      { pane_id: managed.pane_id, terminal_id: managed.terminal_id, tab_id: managed.tab_id, workspace_id: "w1" },
    ],
  }));
  t.mock.method(HerdrClient.prototype, "createTab", async () => ({
    root_pane: { pane_id: managed.pane_id },
  }));
  t.mock.method(HerdrClient.prototype, "startAndWaitAgent", async () => managed);
  t.mock.method(HerdrClient.prototype, "waitForAgentSession", async () => {
    throw new Error("native session unavailable");
  });
  t.mock.method(HerdrClient.prototype, "promptAgent", async (_paneId, prompt) => { prompts.push(prompt); });

  const pi = fakePi();
  herdrSupervisor(pi);
  const result = await pi.tools.get("supervisor_start_goal").execute("missing-session", {
    goal: "Complete one full validation.",
    acceptance: ["Every result is accounted for."],
    placement: { mode: "new", label: "validation" },
    working_directory: "/app/projects/sample-project",
  }, undefined, undefined, { ui: { setStatus() {} } });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /goal was not delivered or bound/);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Initialize this worker session only/);
  assert.doesNotMatch(prompts[0], /Complete one full validation/);
  assert.equal((await loadSupervisorGoals(root)).active.length, 0);
  assert.equal((await loadSupervisorGoals(root)).unstarted.length, 1);
  pi.events.get("session_shutdown")();
});

test("retry reuses a pending initialized pane instead of creating another worker", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "herdr-supervisor-session-retry-"));
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  const previousPane = process.env.HERDR_PANE_ID;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  process.env.HERDR_PANE_ID = "w1:p1";
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
    if (previousPane === undefined) delete process.env.HERDR_PANE_ID;
    else process.env.HERDR_PANE_ID = previousPane;
  });

  let creates = 0;
  let starts = 0;
  let waits = 0;
  let sessionReady = false;
  const prompts = [];
  const managed = {
    pane_id: "w1:p3",
    terminal_id: "term_managed",
    agent_status: "idle",
    interactive_ready: true,
    tab_id: "w1:t2",
    workspace_id: "w1",
  };
  const identified = {
    ...managed,
    agent_session: { source: "herdr:codex", agent: "codex", kind: "id", value: "session_managed" },
  };
  t.mock.method(HerdrClient.prototype, "snapshot", async () => ({
    agents: [sessionReady ? identified : managed],
    panes: [
      { pane_id: "w1:p1", terminal_id: "term_supervisor", tab_id: "w1:t1", workspace_id: "w1" },
      { pane_id: managed.pane_id, terminal_id: managed.terminal_id, tab_id: managed.tab_id, workspace_id: "w1" },
    ],
  }));
  t.mock.method(HerdrClient.prototype, "createTab", async () => {
    creates += 1;
    return { root_pane: { pane_id: managed.pane_id } };
  });
  t.mock.method(HerdrClient.prototype, "startAndWaitAgent", async () => {
    starts += 1;
    return managed;
  });
  t.mock.method(HerdrClient.prototype, "waitForAgentSession", async () => {
    waits += 1;
    if (waits === 1) throw new Error("native session unavailable");
    sessionReady = true;
    return identified;
  });
  t.mock.method(HerdrClient.prototype, "promptAgent", async (_paneId, prompt) => { prompts.push(prompt); });
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const pi = fakePi();
  herdrSupervisor(pi);
  const request = {
    goal: "Complete one bounded diagnostic.",
    acceptance: ["The diagnostic is verified."],
    placement: { mode: "new", label: "diagnostic" },
    working_directory: "/app",
  };
  const first = await pi.tools.get("supervisor_start_goal").execute("first", request, undefined, undefined, { ui: { setStatus() {} } });
  const second = await pi.tools.get("supervisor_start_goal").execute("second", request, undefined, undefined, { ui: { setStatus() {} } });

  assert.equal(first.isError, true);
  assert.equal(second.isError, false);
  assert.equal(creates, 1);
  assert.equal(starts, 1);
  assert.equal(prompts.length, 2);
  assert.match(prompts[0], /Initialize this worker session only/);
  assert.match(prompts[1], /Complete one bounded diagnostic/);
  assert.equal((await loadSupervisorGoals(root)).active[0].paneId, managed.pane_id);
  pi.events.get("session_shutdown")();
});

test("restart reuses the named worker for an installed goal instead of creating a duplicate", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "herdr-supervisor-start-restart-"));
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  const previousPane = process.env.HERDR_PANE_ID;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  process.env.HERDR_PANE_ID = "w1:p1";
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
    if (previousPane === undefined) delete process.env.HERDR_PANE_ID;
    else process.env.HERDR_PANE_ID = previousPane;
  });

  let creates = 0;
  let starts = 0;
  let workerName;
  let restarted = false;
  const managed = {
    pane_id: "w1:p3",
    terminal_id: "term_managed",
    agent_status: "idle",
    interactive_ready: true,
    tab_id: "w1:t2",
    workspace_id: "w1",
  };
  const identified = {
    ...managed,
    name: undefined,
    agent_session: { source: "herdr:codex", agent: "codex", kind: "id", value: "session_managed" },
  };
  t.mock.method(HerdrClient.prototype, "snapshot", async () => ({
    agents: restarted ? [{ ...identified, name: workerName }] : [managed],
    panes: [
      { pane_id: "w1:p1", terminal_id: "term_supervisor", tab_id: "w1:t1", workspace_id: "w1" },
      { pane_id: managed.pane_id, terminal_id: managed.terminal_id, tab_id: managed.tab_id, workspace_id: "w1" },
    ],
  }));
  t.mock.method(HerdrClient.prototype, "createTab", async () => {
    creates += 1;
    return { root_pane: { pane_id: managed.pane_id } };
  });
  t.mock.method(HerdrClient.prototype, "startAndWaitAgent", async (request) => {
    starts += 1;
    workerName = request.name;
    return managed;
  });
  t.mock.method(HerdrClient.prototype, "waitForAgentSession", async () => {
    if (!restarted) throw new Error("native session unavailable");
    return { ...identified, name: workerName };
  });
  t.mock.method(HerdrClient.prototype, "promptAgent", async () => {});
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const request = {
    goal: "Complete one restart-safe diagnostic.",
    acceptance: ["The diagnostic is verified."],
    placement: { mode: "new", label: "diagnostic" },
    working_directory: "/app",
  };
  const firstPi = fakePi();
  herdrSupervisor(firstPi);
  const first = await firstPi.tools.get("supervisor_start_goal").execute("first", request, undefined, undefined, { ui: { setStatus() {} } });
  firstPi.events.get("session_shutdown")();
  restarted = true;

  const secondPi = fakePi();
  herdrSupervisor(secondPi);
  const second = await secondPi.tools.get("supervisor_start_goal").execute("second", request, undefined, undefined, { ui: { setStatus() {} } });

  assert.equal(first.isError, true);
  assert.equal(second.isError, false);
  assert.equal(creates, 1);
  assert.equal(starts, 1);
  assert.equal((await loadSupervisorGoals(root)).active.length, 1);
  assert.equal((await loadSupervisorGoals(root)).unstarted.length, 0);
  secondPi.events.get("session_shutdown")();
});

test("restart adopts a new terminal without forcing a healthy worker review", async (t) => {
  const root = await fixture();
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  t.mock.method(HerdrClient.prototype, "snapshot", async () => snapshot({
    terminal_id: "term_after_restart",
    agent_status: "working",
  }));
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const pi = fakePi();
  herdrSupervisor(pi);
  await pi.events.get("session_start")({}, { ui: { setStatus() {} } });

  const stored = (await loadSupervisorGoals(root)).active.find((binding) => binding.paneId === worker.paneId);
  assert.equal(stored.terminalId, "term_after_restart");
  assert.equal(stored.agentSession.value, worker.agentSession.value);
  assert.equal(pi.messages.length, 0);
  pi.events.get("session_shutdown")();
});

test("restart preserves a pending human decision without asking again", async (t) => {
  const root = await fixture();
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  let subscriptionEvent;
  t.mock.method(HerdrClient.prototype, "snapshot", async () => snapshot());
  t.mock.method(HerdrClient.prototype, "readAgent", async () => ({ read: { text: "A real human decision is required.", truncated: false } }));
  t.mock.method(HerdrClient.prototype, "subscribe", (_subscriptions, onEvent) => {
    subscriptionEvent = onEvent;
    return () => {};
  });

  const firstPi = fakePi();
  herdrSupervisor(firstPi);
  await firstPi.events.get("session_start")({}, { ui: { setStatus() {} } });
  await waitFor(() => firstPi.messages.length === 1);
  await firstPi.tools.get("supervisor_observe").execute("observe", { pane_id: worker.paneId });
  await firstPi.tools.get("supervisor_ask_human").execute("ask", {
    pane_id: worker.paneId,
    question: "May this worker use shared capacity?",
    evidence: ["The worker exhausted local alternatives and needs the capacity owner's approval."],
  });
  const [waiting] = (await loadSupervisorGoals(root)).active;
  assert.deepEqual(waiting.evidence, [
    "The worker exhausted local alternatives and needs the capacity owner's approval.",
  ]);
  assert.match(waiting.wait.condition, /human's answer/);
  assert.ok(Date.parse(waiting.wait.reviewAt) > Date.now());
  const waitingAudit = await readAudit("g_test", root);
  assert.deepEqual(waitingAudit.at(-1).evidence, waiting.evidence);
  firstPi.events.get("session_shutdown")();

  const secondPi = fakePi();
  herdrSupervisor(secondPi);
  await secondPi.events.get("session_start")({}, { ui: { setStatus() {} } });
  assert.equal(secondPi.messages.length, 0);
  subscriptionEvent({ data: { pane_id: worker.paneId } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(secondPi.messages.length, 0);
  const status = await secondPi.tools.get("supervisor_status").execute("status", {});
  assert.match(status.content[0].text, /Next: answer the supervisor's question above/);
  secondPi.events.get("session_shutdown")();
});

test("a human wait is reconsidered instead of being forgotten", async (t) => {
  const root = await fixture();
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  t.mock.method(HerdrClient.prototype, "snapshot", async () => snapshot());
  t.mock.method(HerdrClient.prototype, "readAgent", async () => ({ read: { text: "The worker still needs a real human decision.", truncated: false } }));
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const pi = fakePi({ reviewMs: "1000" });
  herdrSupervisor(pi);
  await pi.events.get("session_start")({}, { ui: { setStatus() {} } });
  await waitFor(() => pi.messages.length === 1);
  await pi.tools.get("supervisor_observe").execute("observe", { pane_id: worker.paneId });
  const asked = await pi.tools.get("supervisor_ask_human").execute("ask", {
    pane_id: worker.paneId,
    question: "Which release boundary should this validation use?",
  });
  assert.equal(asked.isError, false);
  await pi.events.get("agent_settled")();

  await new Promise((resolve) => setTimeout(resolve, 1100));
  await waitFor(() => pi.messages.length === 2);
  assert.match(pi.messages[1].content, /review deadline elapsed/);
  pi.events.get("session_shutdown")();
});

test("an idle worker cannot be left working and may be steered in the same review", async (t) => {
  const root = await fixture();
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  let prompts = 0;
  t.mock.method(HerdrClient.prototype, "snapshot", async () => snapshot({ agent_status: "idle", state_change_seq: 0 }));
  t.mock.method(HerdrClient.prototype, "readAgent", async () => ({ read: { text: "The restored worker is idle.", truncated: false } }));
  t.mock.method(HerdrClient.prototype, "promptAgent", async () => { prompts += 1; });
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const pi = fakePi();
  herdrSupervisor(pi);
  await pi.events.get("session_start")({}, { ui: { setStatus() {} } });
  await waitFor(() => pi.messages.length === 1);
  const status = await pi.tools.get("supervisor_status").execute("status", {});
  assert.equal(status.isError, false);
  assert.match(status.content[0].text, /Finish the exact goal/);
  assert.doesNotMatch(status.content[0].text, /Accept when:/);
  const detail = await pi.tools.get("supervisor_status").execute("status-detail", { pane_id: worker.paneId });
  assert.match(detail.content[0].text, /Accept when: The focused proof passes/);
  const peerStatus = await pi.tools.get("supervisor_status").execute("status", { pane_id: "w1:p3" });
  assert.equal(peerStatus.isError, false);
  assert.match(peerStatus.content[0].text, /w1:p3 is not supervised/);
  assert.doesNotMatch(peerStatus.content[0].text, /review is scoped/);
  await pi.tools.get("supervisor_observe").execute("observe", { pane_id: worker.paneId });
  const leave = await pi.tools.get("supervisor_leave").execute("leave", {
    pane_id: worker.paneId,
    progress: "Continue the restored goal.",
  });
  assert.equal(leave.isError, true);
  assert.match(leave.content[0].text, /is idle and no concrete wait condition was supplied/);

  const steer = await pi.tools.get("supervisor_steer").execute("steer", {
    pane_id: worker.paneId,
    message: "Continue the restored goal from current evidence.",
    evidence: ["The restored worker is idle and the focused proof is still missing."],
  });
  assert.equal(steer.isError, false);
  assert.equal(prompts, 1);
  const [continued] = (await loadSupervisorGoals(root)).active;
  assert.deepEqual(continued.evidence, [
    "The restored worker is idle and the focused proof is still missing.",
  ]);
  const continuedAudit = await readAudit("g_test", root);
  assert.deepEqual(continuedAudit.at(-1).evidence, continued.evidence);
  pi.events.get("session_shutdown")();
});

test("a settled worker may wait on one explicit peer condition", async (t) => {
  const root = await fixture();
  const peerWorker = {
    paneId: "w1:p7",
    terminalId: "term_peer",
    agentSession: { source: "herdr:codex", agent: "codex", kind: "id", value: "session_peer" },
  };
  await registerSupervisedGoal(peerWorker, {
    objective: "Check shared ADO capacity.",
    acceptance: ["Capacity is classified."],
  }, root, { goalId: "g_peer" });
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  let prompts = 0;
  let peerStatus = "working";
  t.mock.method(HerdrClient.prototype, "snapshot", async () => ({
    agents: [
      snapshot({ agent_status: "done", state_change_seq: 3 }).agents[0],
      {
        pane_id: peerWorker.paneId,
        terminal_id: peerWorker.terminalId,
        agent_status: peerStatus,
        state_change_seq: 4,
        agent_session: peerWorker.agentSession,
      },
    ],
    panes: [
      ...snapshot().panes,
      { pane_id: peerWorker.paneId, terminal_id: peerWorker.terminalId },
    ],
  }));
  t.mock.method(HerdrClient.prototype, "readAgent", async () => ({ read: { text: "Local work is complete; a peer owns the shared capacity check.", truncated: false } }));
  t.mock.method(HerdrClient.prototype, "promptAgent", async () => { prompts += 1; });
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const pi = fakePi();
  herdrSupervisor(pi);
  await pi.events.get("session_start")({}, { ui: { setStatus() {} } });
  await waitFor(() => pi.messages.length === 1);
  await pi.tools.get("supervisor_observe").execute("observe", { pane_id: worker.paneId });
  peerStatus = "idle";
  const convoy = await pi.tools.get("supervisor_leave").execute("leave-convoy", {
    pane_id: worker.paneId,
    progress: "Local proof is preserved.",
    waiting_for: "w1:p7 to release shared capacity",
    waiting_on_pane: "w1:p7",
  });
  assert.equal(convoy.isError, true);
  assert.match(convoy.content[0].text, /capacity is not reserved by an inactive worker/);
  peerStatus = "working";
  const leave = await pi.tools.get("supervisor_leave").execute("leave", {
    pane_id: worker.paneId,
    progress: "Local proof is preserved.",
    waiting_for: "w1:p7 to report that shared ADO capacity is available",
    waiting_on_pane: "w1:p7",
    review_at: new Date(Date.now() + 60_000).toISOString(),
  });

  assert.equal(leave.isError, false);
  assert.match(leave.content[0].text, /waiting for w1:p7 to report/);
  assert.equal(prompts, 0);
  const stored = (await loadSupervisorGoals(root)).active.find((binding) => binding.paneId === worker.paneId);
  assert.equal(stored.lastDecision.decision, "leave");
  assert.match(stored.progress, /Waiting for: w1:p7 to report/);
  assert.equal(stored.wait.condition, "w1:p7 to report that shared ADO capacity is available");
  assert.equal(stored.wait.paneId, "w1:p7");
  assert.ok(Date.parse(stored.wait.reviewAt) > Date.now());
  pi.events.get("session_shutdown")();
});

test("a peer event immediately reconsiders its exact waiting worker", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "herdr-supervisor-peer-wait-"));
  const sessionFile = join(root, "waiting-worker.jsonl");
  await writeFile(sessionFile, "");
  const waitingWorker = {
    ...worker,
    agentSession: { source: "herdr:codex", agent: "codex", kind: "path", value: sessionFile },
  };
  const peerWorker = {
    paneId: "w1:p7",
    terminalId: "term_peer",
    agentSession: { source: "herdr:codex", agent: "codex", kind: "id", value: "session_peer" },
  };
  const waiting = await registerSupervisedGoal(waitingWorker, {
    objective: "Run the next useful validation when capacity is free.",
    acceptance: ["The validation passes."],
  }, root, { goalId: "g_waiting" });
  await recordDecision(waiting, "leave", {
    progress: "Local preparation is complete.",
    action: "Wait for the peer's capacity decision.",
    wait: {
      condition: "w1:p7 to stop using shared capacity",
      paneId: peerWorker.paneId,
      reviewAt: new Date(Date.now() + 60_000).toISOString(),
    },
    observationCursor: { kind: "codex-jsonl", path: sessionFile, offset: 0 },
  }, root);
  await registerSupervisedGoal(peerWorker, {
    objective: "Check shared validation capacity.",
    acceptance: ["Capacity is classified."],
  }, root, { goalId: "g_peer" });

  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  const agents = [
    {
      pane_id: waitingWorker.paneId,
      terminal_id: waitingWorker.terminalId,
      agent_status: "idle",
      state_change_seq: 2,
      agent_session: waitingWorker.agentSession,
    },
    {
      pane_id: peerWorker.paneId,
      terminal_id: peerWorker.terminalId,
      agent_status: "working",
      state_change_seq: 3,
      agent_session: peerWorker.agentSession,
    },
  ];
  t.mock.method(HerdrClient.prototype, "snapshot", async () => ({
    agents,
    panes: agents.map((agent) => ({ pane_id: agent.pane_id, terminal_id: agent.terminal_id })),
  }));
  let subscriptionEvent;
  t.mock.method(HerdrClient.prototype, "subscribe", (_subscriptions, onEvent) => {
    subscriptionEvent = onEvent;
    return () => {};
  });

  const pi = fakePi();
  herdrSupervisor(pi);
  await pi.events.get("session_start")({}, { ui: { setStatus() {} } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(pi.messages.length, 0, "the unchanged future wait should remain quiet");

  subscriptionEvent({ data: { pane_id: peerWorker.paneId } });
  await waitFor(() => pi.messages.length === 1);
  assert.match(pi.messages[0].content, /w1:p7 changed; reconsider whether useful work can proceed/);
  assert.match(pi.messages[0].content, /w1:p2/);
  pi.events.get("session_shutdown")();
});

test("a settled worker wait receives a bounded review timestamp by default", async (t) => {
  const root = await fixture();
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  t.mock.method(HerdrClient.prototype, "snapshot", async () => snapshot({ agent_status: "idle", state_change_seq: 3 }));
  t.mock.method(HerdrClient.prototype, "readAgent", async () => ({ read: { text: "The server permits one retry in 431 seconds.", truncated: false } }));
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const pi = fakePi();
  herdrSupervisor(pi);
  await pi.events.get("session_start")({}, { ui: { setStatus() {} } });
  await waitFor(() => pi.messages.length === 1);
  await pi.tools.get("supervisor_observe").execute("observe", { pane_id: worker.paneId });
  const leave = await pi.tools.get("supervisor_leave").execute("leave", {
    pane_id: worker.paneId,
    progress: "The authenticated request is throttled.",
    waiting_for: "the server-directed retry boundary",
  });

  assert.equal(leave.isError, false);
  const [stored] = (await loadSupervisorGoals(root)).active;
  assert.equal(stored.lastDecision.decision, "leave");
  assert.ok(Date.parse(stored.wait.reviewAt) > Date.now());
  pi.events.get("session_shutdown")();
});

test("an invalid optional peer hint cannot discard a valid bounded external wait", async (t) => {
  const root = await fixture();
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  t.mock.method(HerdrClient.prototype, "snapshot", async () => snapshot({ agent_status: "idle", state_change_seq: 3 }));
  t.mock.method(HerdrClient.prototype, "readAgent", async () => ({ read: { text: "The exact build is still active and has a retry boundary.", truncated: false } }));
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const pi = fakePi();
  herdrSupervisor(pi);
  await pi.events.get("session_start")({}, { ui: { setStatus() {} } });
  await waitFor(() => pi.messages.length === 1);
  await pi.tools.get("supervisor_observe").execute("observe", { pane_id: worker.paneId });
  const leave = await pi.tools.get("supervisor_leave").execute("leave", {
    pane_id: worker.paneId,
    progress: "The exact external build remains active.",
    waiting_for: "build 123 to finish",
    waiting_on_pane: ":",
    review_at: new Date(Date.now() + 60_000).toISOString(),
  });

  assert.equal(leave.isError, false);
  assert.match(leave.content[0].text, /ignored unknown worker/);
  const [stored] = (await loadSupervisorGoals(root)).active;
  assert.equal(stored.wait.condition, "build 123 to finish");
  assert.equal(stored.wait.paneId, undefined);
  assert.ok(Date.parse(stored.wait.reviewAt) > Date.now());
  pi.events.get("session_shutdown")();
});

test("settlement preserves the deadline chosen by a completed decision", async (t) => {
  const root = await fixture();
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  t.mock.method(HerdrClient.prototype, "snapshot", async () => snapshot({ agent_status: "idle", state_change_seq: 3 }));
  t.mock.method(HerdrClient.prototype, "readAgent", async () => ({ read: { text: "The server permits one later retry.", truncated: false } }));
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const pi = fakePi({ reviewMs: "1000" });
  herdrSupervisor(pi);
  await pi.events.get("session_start")({}, { ui: { setStatus() {} } });
  await waitFor(() => pi.messages.length === 1);
  await pi.tools.get("supervisor_observe").execute("observe", { pane_id: worker.paneId });
  const leave = await pi.tools.get("supervisor_leave").execute("leave", {
    pane_id: worker.paneId,
    progress: "The authenticated request is throttled.",
    waiting_for: "the server-directed retry boundary",
    review_at: new Date(Date.now() + 1400).toISOString(),
  });
  assert.equal(leave.isError, false);

  await pi.events.get("agent_settled")();
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(pi.messages.length, 1, "the generic interval must not replace the decision deadline");
  await waitFor(() => pi.messages.length === 2);
  assert.match(pi.messages[1].content, /review deadline elapsed/);
  pi.events.get("session_shutdown")();
});

test("restart restores a settled wait without a no-change review before its deadline", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "herdr-supervisor-wait-restart-"));
  const sessions = await mkdtemp(join(tmpdir(), "herdr-supervisor-session-"));
  const sessionFile = join(sessions, "worker.jsonl");
  const line = `${JSON.stringify({
    timestamp: "2026-08-28T20:00:00.000Z",
    type: "response_item",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Waiting safely." }] },
  })}\n`;
  await writeFile(sessionFile, line);
  const exactWorker = {
    ...worker,
    agentSession: { source: "herdr:codex", agent: "codex", kind: "path", value: sessionFile },
  };
  const binding = await registerSupervisedGoal(exactWorker, {
    objective: "Wait until one exact retry boundary.",
    acceptance: ["The retry succeeds."],
  }, root, { goalId: "g_wait_restart" });
  const reviewAt = new Date(Date.now() + 1200).toISOString();
  await recordDecision(binding, "leave", {
    progress: "The service asked us to wait.",
    action: "Wait for the service retry boundary.",
    wait: { condition: "the service retry boundary", reviewAt },
    observationCursor: { kind: "codex-jsonl", path: sessionFile, offset: Buffer.byteLength(line) },
    evidence: ["The server returned a retry deadline."],
  }, root);

  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  t.mock.method(HerdrClient.prototype, "snapshot", async () => snapshot({
    agent_status: "done",
    state_change_seq: 9,
    agent_session: exactWorker.agentSession,
  }));
  let subscriptionEvent;
  t.mock.method(HerdrClient.prototype, "subscribe", (_subscriptions, onEvent) => {
    subscriptionEvent = onEvent;
    return () => {};
  });

  const pi = fakePi({ reviewMs: "1000" });
  herdrSupervisor(pi);
  await pi.events.get("session_start")({}, { ui: { setStatus() {} } });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(pi.messages.length, 0, "restart must not review unchanged settled evidence early");
  subscriptionEvent({ data: { pane_id: worker.paneId } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(pi.messages.length, 0, "lifecycle-only events must not wake an unchanged future wait");
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await waitFor(() => pi.messages.length === 1);
  assert.match(pi.messages[0].content, /review deadline elapsed/);
  pi.events.get("session_shutdown")();
});

test("only the current automated review remains in model context", () => {
  const pi = fakePi();
  herdrSupervisor(pi);
  const context = pi.events.get("context")({
    messages: [
      { role: "user", content: "Keep the goals moving." },
      { role: "assistant", content: "I will." },
      { role: "custom", customType: "herdr-supervisor-review", content: "old large goal" },
      { role: "assistant", content: "old tool call" },
      { role: "toolResult", content: "old large observation" },
      { role: "assistant", content: "old review result" },
      { role: "user", content: "Also prefer plain language." },
      { role: "assistant", content: "Understood." },
      { role: "custom", customType: "herdr-supervisor-review", content: "current goal" },
      { role: "assistant", content: "current tool call" },
      { role: "toolResult", content: "current observation" },
    ],
  });

  assert.deepEqual(context.messages.map((message) => message.content), [
    "Keep the goals moving.",
    "I will.",
    "Also prefer plain language.",
    "Understood.",
    "current goal",
    "current tool call",
    "current observation",
  ]);
});

test("a successful steer is not repeated when checkpointing fails", async (t) => {
  const root = await fixture();
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  let prompts = 0;
  t.mock.method(HerdrClient.prototype, "snapshot", async () => snapshot());
  t.mock.method(HerdrClient.prototype, "readAgent", async () => ({ read: { text: "Work needs one more proof.", truncated: false } }));
  t.mock.method(HerdrClient.prototype, "promptAgent", async () => { prompts += 1; });
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const pi = fakePi();
  herdrSupervisor(pi);
  await pi.events.get("session_start")({}, { ui: { setStatus() {} } });
  await waitFor(() => pi.messages.length === 1);
  await pi.tools.get("supervisor_observe").execute("observe", { pane_id: worker.paneId });

  const current = goalPaths("g_test", root).current;
  await unlink(current);
  await mkdir(current);
  const result = await pi.tools.get("supervisor_steer").execute("steer", {
    pane_id: worker.paneId,
    message: "Run the focused proof.",
  });
  assert.equal(prompts, 1);
  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /Continued w1:p2, but could not save the checkpoint/);
  assert.match(result.content[0].text, /Do not send the instruction again/);

  const repeated = await pi.tools.get("supervisor_steer").execute("steer-again", {
    pane_id: worker.paneId,
    message: "Run the focused proof.",
  });
  assert.equal(prompts, 1);
  assert.equal(repeated.isError, true);
  assert.match(repeated.content[0].text, /already applied/);
  pi.events.get("session_shutdown")();
});

test("an uncertain steer delivery fails closed until fresh evidence", async (t) => {
  const root = await fixture();
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  let prompts = 0;
  t.mock.method(HerdrClient.prototype, "snapshot", async () => snapshot());
  t.mock.method(HerdrClient.prototype, "readAgent", async () => ({ read: { text: "Work needs one more proof.", truncated: false } }));
  t.mock.method(HerdrClient.prototype, "promptAgent", async () => {
    prompts += 1;
    throw new Error("prompt response timed out");
  });
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const pi = fakePi();
  herdrSupervisor(pi);
  await pi.events.get("session_start")({}, { ui: { setStatus() {} } });
  await waitFor(() => pi.messages.length === 1);
  await pi.tools.get("supervisor_observe").execute("observe", { pane_id: worker.paneId });
  const result = await pi.tools.get("supervisor_steer").execute("steer", {
    pane_id: worker.paneId,
    message: "Run the focused proof.",
  });

  assert.equal(prompts, 1);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Could not confirm whether w1:p2 received the instruction/);
  assert.match(result.content[0].text, /Do not send it again/);
  const repeated = await pi.tools.get("supervisor_steer").execute("steer-again", {
    pane_id: worker.paneId,
    message: "Run the focused proof.",
  });
  assert.equal(prompts, 1);
  assert.match(repeated.content[0].text, /already applied/);
  pi.events.get("session_shutdown")();
});

test("continuing a stopped worker resumes the exact session atomically", async (t) => {
  const root = await fixture();
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  let resumes = 0;
  let prompts = 0;
  let resumeRequest;
  t.mock.method(HerdrClient.prototype, "snapshot", async () => snapshot(null));
  t.mock.method(HerdrClient.prototype, "startAndWaitAgent", async (request) => {
    resumes += 1;
    resumeRequest = request;
    return snapshot().agents[0];
  });
  t.mock.method(HerdrClient.prototype, "promptAgent", async () => {
    prompts += 1;
  });
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const pi = fakePi();
  herdrSupervisor(pi);
  await pi.events.get("session_start")({}, { ui: { setStatus() {} } });
  await waitFor(() => pi.messages.length === 1);
  await pi.tools.get("supervisor_observe").execute("observe", { pane_id: worker.paneId });
  const result = await pi.tools.get("supervisor_steer").execute("continue", {
    pane_id: worker.paneId,
    message: "Continue from current goal evidence.",
  });

  assert.equal(resumes, 1);
  assert.equal(prompts, 0);
  assert.deepEqual(resumeRequest.args, [
    "--disable",
    "goals",
    "resume",
    worker.agentSession.value,
    "Continue from current goal evidence.",
  ]);
  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /Resumed the exact codex session/);
  const repeated = await pi.tools.get("supervisor_steer").execute("continue-again", {
    pane_id: worker.paneId,
    message: "Continue from current goal evidence.",
  });
  assert.equal(resumes, 1);
  assert.match(repeated.content[0].text, /already applied/);
  pi.events.get("session_shutdown")();
});

test("an accepted resume is not repeated when readiness checking fails", async (t) => {
  const root = await fixture();
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  let resumes = 0;
  t.mock.method(HerdrClient.prototype, "snapshot", async () => snapshot(null));
  t.mock.method(HerdrClient.prototype, "startAndWaitAgent", async (_request, _timeout, onStarted) => {
    resumes += 1;
    onStarted();
    throw new Error("readiness timed out");
  });
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const pi = fakePi();
  herdrSupervisor(pi);
  await pi.events.get("session_start")({}, { ui: { setStatus() {} } });
  await waitFor(() => pi.messages.length === 1);
  await pi.tools.get("supervisor_observe").execute("observe", { pane_id: worker.paneId });
  const result = await pi.tools.get("supervisor_steer").execute("continue", {
    pane_id: worker.paneId,
    message: "Continue from current goal evidence.",
  });

  assert.equal(resumes, 1);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Herdr accepted the exact-session resume/);
  assert.match(result.content[0].text, /Do not resume it again/);
  const repeated = await pi.tools.get("supervisor_steer").execute("continue-again", {
    pane_id: worker.paneId,
    message: "Continue from current goal evidence.",
  });
  assert.equal(resumes, 1);
  assert.match(repeated.content[0].text, /already applied/);
  pi.events.get("session_shutdown")();
});

test("a due global review routes findings through ordinary focused reviews", async (t) => {
  const root = await fixture();
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  t.mock.method(HerdrClient.prototype, "snapshot", async () => snapshot({ agent_status: "working" }));
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const pi = fakePi({ globalReviewMs: "1000" });
  herdrSupervisor(pi);
  await pi.events.get("session_start")({}, { ui: { setStatus() {} } });
  await waitFor(() => pi.messages.length === 1);
  assert.equal(pi.messages[0].customType, "herdr-supervisor-global-review");
  assert.match(pi.messages[0].content, /"goalId": "g_test"/);
  assert.doesNotMatch(pi.messages[0].content, /journal|native messages|terminal output/);

  const result = await pi.tools.get("supervisor_global_result").execute("global", {
    summary: "The worker state conflicts with its recorded progress.",
    findings: [{
      problem: "The goal needs a focused evidence check",
      evidence: ["Current worker state and checkpoint need reconciliation"],
      affected_goal_ids: ["g_test"],
    }],
    reconsider: [],
  });
  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /Queued focused reviews for g_test/);
  await pi.events.get("agent_settled")();
  await waitFor(() => pi.messages.some((message) => message.customType === "herdr-supervisor-review"));
  const focused = pi.messages.find((message) => message.customType === "herdr-supervisor-review");
  assert.match(focused.content, /global supervision review found/);
  const stored = await loadGlobalReviewState(root);
  assert.ok(Date.parse(stored.nextReviewAt) > Date.now());
  pi.events.get("session_shutdown")();
});

test("focused worker review runs before a due global review", async (t) => {
  const root = await fixture();
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  t.mock.method(HerdrClient.prototype, "snapshot", async () => snapshot({ agent_status: "blocked" }));
  t.mock.method(HerdrClient.prototype, "readAgent", async () => ({ read: { text: "The worker can continue with one focused check.", truncated: false } }));
  t.mock.method(HerdrClient.prototype, "promptAgent", async () => {});
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const pi = fakePi({ globalReviewMs: "1000" });
  herdrSupervisor(pi);
  await pi.events.get("session_start")({}, { ui: { setStatus() {} } });
  await waitFor(() => pi.messages.length === 1);
  assert.equal(pi.messages[0].customType, "herdr-supervisor-review");
  await pi.tools.get("supervisor_observe").execute("observe", { pane_id: worker.paneId });
  await pi.tools.get("supervisor_steer").execute("steer", {
    pane_id: worker.paneId,
    message: "Run the remaining focused check.",
  });
  await pi.events.get("agent_settled")();
  await waitFor(() => pi.messages.length === 2);
  assert.equal(pi.messages[1].customType, "herdr-supervisor-global-review");
  pi.events.get("session_shutdown")();
});

test("an invalid global result has no partial routing", async (t) => {
  const root = await fixture();
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  t.mock.method(HerdrClient.prototype, "snapshot", async () => snapshot({ agent_status: "working" }));
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});
  const pi = fakePi({ globalReviewMs: "1000" });
  herdrSupervisor(pi);
  await pi.events.get("session_start")({}, { ui: { setStatus() {} } });
  await waitFor(() => pi.messages.length === 1);

  const invalid = await pi.tools.get("supervisor_global_result").execute("invalid", {
    summary: "One reference is invalid.",
    findings: [{ problem: "Check both", evidence: ["one is unknown"], affected_goal_ids: ["g_test", "g_unknown"] }],
    reconsider: [],
  });
  assert.equal(invalid.isError, true);
  assert.match(invalid.content[0].text, /No focused reviews were queued/);

  const valid = await pi.tools.get("supervisor_global_result").execute("valid", {
    summary: "No cross-goal fault remains.",
    findings: [],
    reconsider: [],
  });
  assert.equal(valid.isError, false);
  await pi.events.get("agent_settled")();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(pi.messages.filter((message) => message.customType === "herdr-supervisor-review").length, 0);
  pi.events.get("session_shutdown")();
});

test("restart respects a persisted future global review", async (t) => {
  const root = await fixture();
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  await saveGlobalReviewState({
    version: 1,
    lastReviewedAt: new Date().toISOString(),
    nextReviewAt: new Date(Date.now() + 60_000).toISOString(),
    snapshotHash: "snapshot",
    lastFindingHash: undefined,
  }, root);
  t.mock.method(HerdrClient.prototype, "snapshot", async () => snapshot({ agent_status: "working" }));
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});
  const pi = fakePi({ globalReviewMs: "1000" });
  herdrSupervisor(pi);
  await pi.events.get("session_start")({}, { ui: { setStatus() {} } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(pi.messages.length, 0);
  pi.events.get("session_shutdown")();
});

test("a completed global review arms its next in-process deadline", async (t) => {
  const root = await fixture();
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  t.mock.method(HerdrClient.prototype, "snapshot", async () => snapshot({ agent_status: "working" }));
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});
  const pi = fakePi({ globalReviewMs: "1000" });
  herdrSupervisor(pi);
  await pi.events.get("session_start")({}, { ui: { setStatus() {} } });
  await waitFor(() => pi.messages.length === 1);
  await pi.tools.get("supervisor_global_result").execute("first", {
    summary: "Healthy.",
    findings: [],
    reconsider: [],
  });
  await pi.events.get("agent_settled")();
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await waitFor(() => pi.messages.filter((message) => message.customType === "herdr-supervisor-global-review").length === 2);
  pi.events.get("session_shutdown")();
});
