import assert from "node:assert/strict";
import { mkdir, mkdtemp, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import herdrSupervisor from "../extension.ts";
import { loadSupervisorGoals, registerSupervisedGoal } from "../src/goal-registry.js";
import { goalPaths, loadGoalContract, readAudit } from "../src/goal-store.js";
import { HerdrClient } from "../src/herdr-client.js";

const worker = {
  paneId: "w1:p2",
  terminalId: "term_test",
  agentSession: { source: "herdr:codex", agent: "codex", kind: "id", value: "session_test" },
};

function fakePi() {
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
      if (name === "supervisor-review-ms") return "600000";
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
  assert.match(prompts[0].prompt, /Write progress and final results in plain language/);
  assert.equal((await readAudit("g_test", root)).at(-1).type, "goal_refined");
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

  const [stored] = (await loadSupervisorGoals(root)).active;
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
  });
  firstPi.events.get("session_shutdown")();

  const secondPi = fakePi();
  herdrSupervisor(secondPi);
  await secondPi.events.get("session_start")({}, { ui: { setStatus() {} } });
  assert.equal(secondPi.messages.length, 0);
  subscriptionEvent({ data: { pane_id: worker.paneId } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(secondPi.messages.length, 0);
  const status = await secondPi.tools.get("supervisor_status").execute("status", {});
  assert.match(status.content[0].text, /Needs you: answer the supervisor's latest question/);
  secondPi.events.get("session_shutdown")();
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
  });
  assert.equal(steer.isError, false);
  assert.equal(prompts, 1);
  pi.events.get("session_shutdown")();
});

test("a settled worker may wait on one explicit peer condition", async (t) => {
  const root = await fixture();
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  let prompts = 0;
  t.mock.method(HerdrClient.prototype, "snapshot", async () => snapshot({ agent_status: "done", state_change_seq: 3 }));
  t.mock.method(HerdrClient.prototype, "readAgent", async () => ({ read: { text: "Local work is complete; a peer owns the shared capacity check.", truncated: false } }));
  t.mock.method(HerdrClient.prototype, "promptAgent", async () => { prompts += 1; });
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const pi = fakePi();
  herdrSupervisor(pi);
  await pi.events.get("session_start")({}, { ui: { setStatus() {} } });
  await waitFor(() => pi.messages.length === 1);
  await pi.tools.get("supervisor_observe").execute("observe", { pane_id: worker.paneId });
  const leave = await pi.tools.get("supervisor_leave").execute("leave", {
    pane_id: worker.paneId,
    progress: "Local proof is preserved.",
    waiting_for: "w1:p7 to report that shared ADO capacity is available",
    review_after_ms: 60_000,
  });

  assert.equal(leave.isError, false);
  assert.match(leave.content[0].text, /waiting for w1:p7 to report/);
  assert.equal(prompts, 0);
  const [stored] = (await loadSupervisorGoals(root)).active;
  assert.equal(stored.lastDecision.decision, "leave");
  assert.match(stored.progress, /Waiting for: w1:p7 to report/);
  pi.events.get("session_shutdown")();
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
  assert.match(result.content[0].text, /Steered w1:p2, but could not save the checkpoint/);
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

test("recovery resumes the exact session with one atomic continuation", async (t) => {
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
  const result = await pi.tools.get("supervisor_recover").execute("recover", {
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
  const repeated = await pi.tools.get("supervisor_recover").execute("recover-again", {
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
  const result = await pi.tools.get("supervisor_recover").execute("recover", {
    pane_id: worker.paneId,
    message: "Continue from current goal evidence.",
  });

  assert.equal(resumes, 1);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Herdr accepted the exact-session resume/);
  assert.match(result.content[0].text, /Do not resume it again/);
  const repeated = await pi.tools.get("supervisor_recover").execute("recover-again", {
    pane_id: worker.paneId,
    message: "Continue from current goal evidence.",
  });
  assert.equal(resumes, 1);
  assert.match(repeated.content[0].text, /already applied/);
  pi.events.get("session_shutdown")();
});
