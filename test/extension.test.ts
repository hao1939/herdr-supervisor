import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Compile } from "typebox/compile";
import herdrSupervisor, { pullRequestTraceability } from "../src/extension.ts";
import { installSupervisorGoal, loadSupervisorGoals, recordDecision, registerSupervisedGoal } from "../src/goal-registry.ts";
import { goalPaths, loadGoalContract, readAudit } from "../src/goal-store.ts";
import { HerdrClient } from "../src/herdr-client.ts";
import { loadGlobalReviewState, saveGlobalReviewState } from "../src/global-review.ts";
import { terminalOutputCursor } from "../src/observation.ts";

const worker = {
  paneId: "w1:p2",
  terminalId: "term_test",
  agentSession: { source: "herdr:codex", agent: "codex", kind: "id", value: "session_test" },
};

function goalWorkerName(goalId: string) {
  return `goal-${createHash("sha256").update(goalId).digest("hex").slice(0, 27)}`;
}

function legacyGoalWorkerName(goalId: string) {
  return `goal-${goalId.slice(2).replaceAll("-", "").toLowerCase().slice(0, 27)}`;
}

function fakePi({ reviewMs = "600000", globalReviewMs = "0" } = {}): any {
  const commands = new Map();
  const tools = new Map();
  const events = new Map();
  const messages = [];
  const customMessages = [];
  const userMessages = [];
  return {
    commands,
    tools,
    events,
    messages,
    customMessages,
    userMessages,
    registerFlag() {},
    getFlag(name) {
      if (name === "supervisor-mode") return "live";
      if (name === "supervisor-review-ms") return reviewMs;
      if (name === "supervisor-global-review-ms") return globalReviewMs;
    },
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand(name, command) { commands.set(name, command); },
    on(name, handler) { events.set(name, handler); },
    sendMessage(message, options) {
      messages.push(message);
      customMessages.push({ message, options });
    },
    sendUserMessage(content, options) { userMessages.push({ content, options }); },
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

test("optional supervisor tool fields accept null without placeholder values", () => {
  const pi = fakePi();
  herdrSupervisor(pi);

  assert.match(pi.tools.get("supervisor_leave").description, /use null for waiting_for/);
  assert.doesNotMatch(pi.tools.get("supervisor_leave").description, /omit waiting_for/);

  const startGoal = Compile(pi.tools.get("supervisor_start_goal").parameters);
  assert.equal(startGoal.Check({
    goal_id: "g_saved",
    goal: null,
    context: null,
    acceptance: null,
    constraints: null,
    placement: { mode: "new", label: "saved" },
    working_directory: "/app",
    direction: null,
  }), true);
  assert.equal(startGoal.Check({
    goal_id: null,
    goal: "Complete one new goal.",
    context: null,
    acceptance: ["The result is verified."],
    constraints: null,
    placement: { mode: "new", label: "new" },
    working_directory: "/app",
    direction: null,
  }), true);

  assert.equal(Compile(pi.tools.get("supervisor_steer").parameters).Check({
    pane_id: worker.paneId,
    message: "Continue the same goal.",
    evidence: null,
    review_at: null,
  }), true);
  assert.equal(Compile(pi.tools.get("supervisor_leave").parameters).Check({
    pane_id: worker.paneId,
    progress: "The worker is making useful progress.",
    waiting_for: null,
    waiting_on_pane: null,
    evidence: null,
    review_at: null,
  }), true);
});

test("pull request traceability never publishes a path-backed session locator", () => {
  const trace = pullRequestTraceability({
    goalId: "g_path",
    goal: "Review the exact change.",
    paneId: "w1:p9",
    agentSession: {
      source: "herdr:codex",
      agent: "codex",
      kind: "path",
      value: "/private/home/user/.codex/sessions/session.jsonl",
    },
  }, "attached-path-worker");

  assert.match(trace, /## Supervision/);
  assert.match(trace, /- Goal: <copy the current objective from the canonical goal\.json>/);
  assert.match(trace, /- Goal ID: "g_path"/);
  assert.match(trace, /- Worker: "attached-path-worker"/);
  assert.match(trace, /- Pane: "w1:p9"/);
  assert.doesNotMatch(trace, /Codex session:/);
  assert.doesNotMatch(trace, /\/private\/home/);
  assert.match(trace, /Write the description in plain language/);
  assert.match(trace, /what was wrong and what changes for the user/);
  assert.ok(trace.indexOf("Write the description") < trace.indexOf("## Supervision"));
  assert.match(trace, /Append this traceability block after the meaningful explanation/);
  assert.match(trace, /supervision metadata secondary/);
});

test("terminal cursors do not change when an observation includes more older lines", () => {
  const recent = Array.from({ length: 10 }, (_, index) => `recent line ${index + 1}`).join("\n");
  assert.deepEqual(
    terminalOutputCursor(`older line 1\nolder line 2\n${recent}`),
    terminalOutputCursor(recent),
  );
});

test("pull request traceability stays bounded for a long goal and requires the current contract", () => {
  const trace = pullRequestTraceability({
    goalId: "g_long",
    goal: `Old objective ${"x".repeat(20_000)}`,
    paneId: "w1:p8",
    agentSession: {
      source: "herdr:codex",
      agent: "codex",
      kind: "id",
      value: "session-long",
    },
  }, "long-goal-worker");

  assert.ok(trace.length < 1_000);
  assert.doesNotMatch(trace, /Old objective/);
  assert.match(trace, /re-read the canonical goal\.json/);
  assert.match(trace, /never leave the placeholder or reuse an earlier objective/);
});

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
    agents: [{ ...managed, name: startRequest?.name }],
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
    "-c",
    'projects={"/app/projects/sample-project"={trust_level="trusted"}}',
    "Initialize this worker session only. Do not inspect or change files. Wait for the goal.",
  ]);
  assert.match(deliveredPrompts[0].prompt, /^\/goal /);
  assert.equal(deliveredPrompts[0].bindingExists, true);
  assert.ok(deliveredPrompts[0].prompt.length <= 4006);
  assert.match(deliveredPrompts[0].prompt, /goal\.json/);
  assert.match(deliveredPrompts[0].prompt, /single canonical objective/);
  assert.match(deliveredPrompts[0].prompt, /every other worker's worktree as read-only/);
  assert.match(deliveredPrompts[0].prompt, /Create another goal-owned worktree/);
  assert.match(deliveredPrompts[0].prompt, /distinguish missing convenience tooling/);
  assert.match(deliveredPrompts[0].prompt, /pending pull request, pipeline run, or peer condition/);
  assert.match(deliveredPrompts[0].prompt, /While it is pending, continue any safe useful work/);
  assert.match(deliveredPrompts[0].prompt, /genuinely exhausted the safe work.*yield/s);
  assert.match(deliveredPrompts[0].prompt, /Keep independent useful paths moving while a pull request, pipeline, or another path is pending/);
  assert.match(deliveredPrompts[0].prompt, /review the exact final diff/);
  assert.match(deliveredPrompts[0].prompt, /run the required tests/);
  assert.match(deliveredPrompts[0].prompt, /evidence matches the current candidate revision/);
  assert.match(deliveredPrompts[0].prompt, /## Supervision/);
  assert.match(deliveredPrompts[0].prompt, /Write progress and final results in plain language/);
  assert.equal(deliveredPrompts[0].bindingExists, true);
  const goals = await loadSupervisorGoals(root);
  assert.equal(goals.active.length, 1);
  assert.equal(goals.active[0].paneId, managed.pane_id);
  assert.ok(deliveredPrompts[0].prompt.includes(`- Goal ID: ${JSON.stringify(goals.active[0].goalId)}`));
  assert.ok(deliveredPrompts[0].prompt.includes(`herdr-goal=${goals.active[0].goalId}`));
  assert.match(deliveredPrompts[0].prompt, /Never tag another goal's build or register a watch/);
  assert.match(deliveredPrompts[0].prompt, /copy the current objective from the canonical goal\.json/);
  assert.ok(deliveredPrompts[0].prompt.includes(`- Worker: ${JSON.stringify(goalWorkerName(goals.active[0].goalId))}`));
  assert.ok(deliveredPrompts[0].prompt.includes(`- Codex session: ${JSON.stringify(managed.agent_session.value)}`));
  assert.ok(deliveredPrompts[0].prompt.includes(`- Pane: ${JSON.stringify(managed.pane_id)}`));
  assert.deepEqual(goals.active[0].context, ["Another worker is validating the same repository."]);
  assert.deepEqual(goals.active[0].acceptance, ["The focused test passes.", "The change is reviewed."]);
  assert.deepEqual(goals.active[0].constraints, ["Make changes only in an isolated worktree."]);
  pi.events.get("session_shutdown")();
});

test("an unstarted saved goal starts by exact ID without restating its contract", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "herdr-supervisor-saved-start-"));
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

  const managed = {
    pane_id: "w1:p3",
    terminal_id: "term_saved",
    agent_status: "idle",
    interactive_ready: true,
    workspace_id: "w1",
    tab_id: "w1:t3",
    agent_session: { source: "herdr:codex", agent: "codex", kind: "id", value: "session_saved" },
  };
  let startRequest;
  const prompts = [];
  t.mock.method(HerdrClient.prototype, "snapshot", async () => ({
    agents: [{ ...managed, name: startRequest?.name }],
    panes: [
      { pane_id: "w1:p1", terminal_id: "term_supervisor", workspace_id: "w1", tab_id: "w1:t1" },
      { pane_id: managed.pane_id, terminal_id: managed.terminal_id, workspace_id: "w1", tab_id: managed.tab_id },
    ],
  }));
  t.mock.method(HerdrClient.prototype, "createTab", async () => ({
    root_pane: { pane_id: managed.pane_id },
  }));
  t.mock.method(HerdrClient.prototype, "startAndWaitAgent", async (request) => {
    startRequest = request;
    return managed;
  });
  t.mock.method(HerdrClient.prototype, "waitForAgentSession", async () => managed);
  t.mock.method(HerdrClient.prototype, "promptAgent", async (_paneId, prompt) => { prompts.push(prompt); });
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const pi = fakePi();
  herdrSupervisor(pi);
  await pi.tools.get("supervisor_status").execute("prime-cache", {
    pane_id: null,
  }, undefined, undefined, { ui: { setStatus() {} } });
  await installSupervisorGoal({
    objective: "Prove one saved portable goal can start.",
    context: ["The saved contract is authoritative."],
    acceptance: ["The exact saved goal ID owns the worker."],
    constraints: ["Do not create a sibling goal."],
  }, root, { goalId: "g_saved" });
  const ambiguous = await pi.tools.get("supervisor_start_goal").execute("ambiguous", {
    goal_id: "g_saved",
    goal: "Do not replace the saved contract.",
    placement: { mode: "new", label: "saved-goal" },
    working_directory: "/app",
  }, undefined, undefined, { ui: { setStatus() {} } });
  const result = await pi.tools.get("supervisor_start_goal").execute("saved", {
    goal_id: "g_saved",
    goal: null,
    context: null,
    acceptance: null,
    constraints: null,
    placement: { mode: "new", label: "saved-goal" },
    working_directory: "/app",
    direction: null,
  }, undefined, undefined, { ui: { setStatus() {} } });

  assert.equal(ambiguous.isError, true);
  assert.match(ambiguous.content[0].text, /either goal_id.*or contract fields/);
  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /g_saved/);
  assert.equal(startRequest.name, goalWorkerName("g_saved"));
  assert.match(prompts.at(-1), /g_saved\/goal\.json/);
  const goals = await loadSupervisorGoals(root);
  assert.deepEqual(goals.active.map(({ goalId }) => goalId), ["g_saved"]);
  assert.deepEqual(goals.active[0].acceptance, ["The exact saved goal ID owns the worker."]);
  assert.equal(goals.unstarted.length, 0);
  assert.equal(goals.completed.length, 0);
  pi.events.get("session_shutdown")();
});

test("a new goal never adopts a legacy-named worker without an existing contract", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "herdr-supervisor-new-goal-legacy-"));
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

  const foreign = {
    pane_id: "w1:p9",
    terminal_id: "term_foreign",
    agent_status: "idle",
    interactive_ready: true,
    workspace_id: "w1",
    tab_id: "w1:t9",
    agent_session: { source: "herdr:codex", agent: "codex", kind: "id", value: "session_foreign" },
  };
  const createdAgent = {
    pane_id: "w1:p3",
    terminal_id: "term_created",
    agent_status: "idle",
    interactive_ready: true,
    workspace_id: "w1",
    tab_id: "w1:t3",
    agent_session: { source: "herdr:codex", agent: "codex", kind: "id", value: "session_created" },
  };
  let created = false;
  let starts = 0;
  t.mock.method(HerdrClient.prototype, "snapshot", async () => {
    const [installed] = (await loadSupervisorGoals(root)).unstarted;
    const foreignAgent = {
      ...foreign,
      name: installed ? legacyGoalWorkerName(installed.goalId) : "foreign-worker",
    };
    return {
      agents: [foreignAgent, ...(created ? [{ ...createdAgent, name: installed ? goalWorkerName(installed.goalId) : "created-worker" }] : [])],
      panes: [
        { pane_id: "w1:p1", terminal_id: "term_supervisor", workspace_id: "w1", tab_id: "w1:t1" },
        { pane_id: foreign.pane_id, terminal_id: foreign.terminal_id, workspace_id: "w1", tab_id: foreign.tab_id },
        ...(created ? [{ pane_id: createdAgent.pane_id, terminal_id: createdAgent.terminal_id, workspace_id: "w1", tab_id: createdAgent.tab_id }] : []),
      ],
    };
  });
  t.mock.method(HerdrClient.prototype, "createTab", async () => {
    created = true;
    return { root_pane: { pane_id: createdAgent.pane_id } };
  });
  t.mock.method(HerdrClient.prototype, "startAndWaitAgent", async (request) => {
    starts += 1;
    assert.equal(request.paneId, createdAgent.pane_id);
    return createdAgent;
  });
  t.mock.method(HerdrClient.prototype, "waitForAgentSession", async (paneId) => {
    assert.equal(paneId, createdAgent.pane_id);
    return createdAgent;
  });
  t.mock.method(HerdrClient.prototype, "promptAgent", async () => {});
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const pi = fakePi();
  herdrSupervisor(pi);
  const result = await pi.tools.get("supervisor_start_goal").execute("new", {
    goal: "Complete one new diagnostic.",
    acceptance: ["The diagnostic is verified."],
    placement: { mode: "new", label: "new-diagnostic" },
    working_directory: "/app",
  }, undefined, undefined, { ui: { setStatus() {} } });

  assert.equal(result.isError, false);
  assert.equal(created, true);
  assert.equal(starts, 1);
  const goals = await loadSupervisorGoals(root);
  assert.deepEqual(goals.active.map(({ agentSession }) => agentSession.value), ["session_created"]);
  pi.events.get("session_shutdown")();
});

test("attaching an existing worker delivers its exact persisted supervision trace", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "herdr-supervisor-attach-trace-"));
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  const prompts = [];
  t.mock.method(HerdrClient.prototype, "snapshot", async () => snapshot({ agent_status: "working", name: "attached-worker" }));
  t.mock.method(HerdrClient.prototype, "promptAgent", async (paneId, prompt) => prompts.push({ paneId, prompt }));
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const pi = fakePi();
  herdrSupervisor(pi);
  const notices = [];
  await pi.commands.get("supervise").handler(`${worker.paneId} Trace the attached worker`, {
    ui: {
      notify(message, level) { notices.push({ message, level }); },
      setStatus() {},
    },
  });

  const [binding] = (await loadSupervisorGoals(root)).active;
  assert.equal(notices.at(-1).level, "info");
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].paneId, worker.paneId);
  assert.ok(prompts[0].prompt.includes(`- Goal ID: ${JSON.stringify(binding.goalId)}`));
  assert.ok(prompts[0].prompt.includes('- Worker: "attached-worker"'));
  assert.ok(prompts[0].prompt.includes(`- Codex session: ${JSON.stringify(worker.agentSession.value)}`));
  assert.ok(prompts[0].prompt.includes(`- Pane: ${JSON.stringify(worker.paneId)}`));
  pi.events.get("session_shutdown")();
});

test("a copied goal activated after restart keeps its exact goal and worker trace", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "herdr-supervisor-copied-trace-"));
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  await installSupervisorGoal({
    objective: "Trace the copied goal after restart.",
    acceptance: ["The copied goal is bound to the exact worker."],
  }, root, { goalId: "g_copied_trace" });
  const prompts = [];
  t.mock.method(HerdrClient.prototype, "snapshot", async () => snapshot({ agent_status: "working", name: "copied-worker" }));
  t.mock.method(HerdrClient.prototype, "promptAgent", async (paneId, prompt) => prompts.push({ paneId, prompt }));
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const firstPi = fakePi();
  herdrSupervisor(firstPi);
  await firstPi.events.get("session_start")({}, { ui: { setStatus() {} } });
  firstPi.events.get("session_shutdown")();

  const secondPi = fakePi();
  herdrSupervisor(secondPi);
  await secondPi.commands.get("supervise").handler(`${worker.paneId} --goal-id g_copied_trace`, {
    ui: { notify() {}, setStatus() {} },
  });

  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].paneId, worker.paneId);
  assert.ok(prompts[0].prompt.includes('- Goal ID: "g_copied_trace"'));
  assert.ok(prompts[0].prompt.includes('- Worker: "copied-worker"'));
  assert.ok(prompts[0].prompt.includes(`- Codex session: ${JSON.stringify(worker.agentSession.value)}`));
  assert.ok(prompts[0].prompt.includes(`- Pane: ${JSON.stringify(worker.paneId)}`));
  secondPi.events.get("session_shutdown")();
});

test("native Goal delivery refuses a replacement session after registration", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "herdr-supervisor-stale-trace-"));
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  let snapshotCalls = 0;
  let prompts = 0;
  t.mock.method(HerdrClient.prototype, "snapshot", async () => {
    snapshotCalls += 1;
    return snapshot(snapshotCalls === 1
      ? { agent_status: "working" }
      : {
          agent_status: "working",
          agent_session: { ...worker.agentSession, value: "replacement_session" },
        });
  });
  t.mock.method(HerdrClient.prototype, "promptAgent", async () => { prompts += 1; });
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const pi = fakePi();
  herdrSupervisor(pi);
  const notices = [];
  await pi.commands.get("supervise").handler(`${worker.paneId} Refuse stale provenance`, {
    ui: {
      notify(message, level) { notices.push({ message, level }); },
      setStatus() {},
    },
  });

  assert.equal(prompts, 0);
  assert.equal(notices.at(-1).level, "warning");
  assert.match(notices.at(-1).message, /refusing stale native Goal delivery: worker value changed/);
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
  assert.deepEqual(startRequest.args, [
    "Initialize this worker session only. Do not inspect or change files. Wait for the goal.",
  ]);
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
  t.mock.method(HerdrClient.prototype, "snapshot", async () => snapshot({ agent_status: "working", name: "refined-worker" }));
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
  assert.match(prompts[0].prompt, /refined the canonical contract/);
  assert.match(prompts[0].prompt, /goal\.json/);
  assert.match(prompts[0].prompt, /Re-read the complete goal\.json/);
  assert.match(prompts[0].prompt, /pending pull request, pipeline run, or peer condition/);
  assert.match(prompts[0].prompt, /genuinely exhausted the safe work.*yield/s);
  assert.match(prompts[0].prompt, /review the exact final diff/);
  assert.match(prompts[0].prompt, /run the required tests/);
  assert.match(prompts[0].prompt, /evidence matches the current candidate revision/);
  assert.match(prompts[0].prompt, /Keep the native Goal active/);
  assert.match(prompts[0].prompt, /## Supervision/);
  assert.match(prompts[0].prompt, /copy the current objective from the canonical goal\.json/);
  assert.match(prompts[0].prompt, /- Worker: "refined-worker"/);
  assert.match(prompts[0].prompt, /herdr-goal=g_test/);
  assert.match(prompts[0].prompt, /Never tag another goal's build or register a watch/);
  assert.doesNotMatch(prompts[0].prompt, /Fix the focused regression\./);
  assert.match(prompts[0].prompt, /plain language/);
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

test("human input during an automatic review becomes the next Pi follow-up", async (t) => {
  const root = await fixture();
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  t.mock.method(HerdrClient.prototype, "snapshot", async () => snapshot({ agent_status: "working" }));
  t.mock.method(HerdrClient.prototype, "readAgent", async () => ({
    read: { text: "The worker finished one turn.", truncated: false },
  }));
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const pi = fakePi();
  herdrSupervisor(pi);
  await pi.tools.get("supervisor_reconsider").execute("review", {
    pane_ids: [worker.paneId],
    reason: "fresh worker evidence is available",
  });
  await pi.events.get("agent_settled")();
  await waitFor(() => pi.messages.length === 1);

  const queued = pi.events.get("input")({
    type: "input",
    text: "Start the saved goal after this review.",
    source: "interactive",
    streamingBehavior: "steer",
  });
  assert.deepEqual(queued, { action: "handled" });
  const relayed = pi.customMessages.at(-1);
  assert.equal(relayed.message.customType, "herdr-supervisor-human-follow-up");
  assert.equal(relayed.message.content, "Start the saved goal after this review.");
  assert.deepEqual(relayed.options, { triggerTurn: true, deliverAs: "followUp" });
  assert.deepEqual(pi.events.get("input")({
    type: "input",
    text: "Then show me its progress.",
    source: "rpc",
    streamingBehavior: "followUp",
  }), { action: "handled" });
  const secondRelayed = pi.customMessages.at(-1);

  await pi.tools.get("supervisor_observe").execute("observe", { pane_id: worker.paneId });
  const messagesBeforeSettlement = pi.messages.length;
  const decision = await pi.tools.get("supervisor_leave").execute("leave", {
    pane_id: worker.paneId,
    progress: "The reviewed worker finished one useful turn.",
  });
  assert.equal(decision.isError, false);
  const stillFenced = await pi.tools.get("supervisor_status").execute("before-follow-up", {
    pane_id: null,
  });
  assert.equal(stillFenced.isError, true);
  assert.match(stillFenced.content[0].text, /decision is already applied/);

  await pi.events.get("message_start")({
    type: "message_start",
    message: { role: "user", content: [{ type: "text", text: "Start the saved goal after this review." }] },
  });
  const unrelatedSteering = await pi.tools.get("supervisor_status").execute("unrelated-steering", {
    pane_id: null,
  });
  assert.equal(unrelatedSteering.isError, true);
  assert.match(unrelatedSteering.content[0].text, /decision is already applied/);

  await pi.events.get("agent_settled")();
  assert.equal(pi.messages.length, messagesBeforeSettlement, "the missing-decision retry waits for the human follow-up");
  await pi.events.get("message_start")({
    type: "message_start",
    message: { role: "custom", ...relayed.message, timestamp: Date.now() },
  });
  const directTurn = await pi.tools.get("supervisor_status").execute("follow-up", {
    pane_id: null,
  });
  assert.equal(directTurn.isError, false);
  assert.doesNotMatch(directTurn.content[0].text, /decision is already applied/);

  const directDecision = await pi.tools.get("supervisor_leave").execute("direct-leave", {
    pane_id: worker.paneId,
    progress: "The worker remains healthy while answering the human follow-up.",
  });
  assert.equal(directDecision.isError, false);
  await pi.events.get("message_start")({
    type: "message_start",
    message: { role: "custom", ...secondRelayed.message, timestamp: Date.now() },
  });
  const secondDirectTurn = await pi.tools.get("supervisor_status").execute("second-follow-up", {
    pane_id: null,
  });
  assert.equal(secondDirectTurn.isError, false);
  assert.doesNotMatch(secondDirectTurn.content[0].text, /decision is already applied/);

  assert.deepEqual(pi.events.get("input")({
    type: "input",
    text: "The internally relayed follow-up.",
    source: "extension",
    streamingBehavior: "followUp",
  }), { action: "continue" });
  assert.equal(pi.userMessages.length, 0);
  pi.events.get("session_shutdown")();
});

test("a command-shaped human follow-up is relayed unchanged and releases its review", async (t) => {
  const root = await fixture();
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  t.mock.method(HerdrClient.prototype, "snapshot", async () => snapshot({ agent_status: "working" }));
  t.mock.method(HerdrClient.prototype, "readAgent", async () => ({
    read: { text: "The worker finished one turn.", truncated: false },
  }));
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const pi = fakePi();
  herdrSupervisor(pi);
  await pi.tools.get("supervisor_reconsider").execute("review", {
    pane_ids: [worker.paneId],
    reason: "fresh worker evidence is available",
  });
  await pi.events.get("agent_settled")();
  await waitFor(() => pi.messages.length === 1);
  assert.deepEqual(pi.events.get("input")({
    type: "input",
    text: "/review src/index.ts",
    source: "rpc",
    streamingBehavior: "followUp",
  }), { action: "handled" });
  const relayed = pi.customMessages.at(-1);
  assert.equal(relayed.message.customType, "herdr-supervisor-human-follow-up");
  assert.equal(relayed.message.content, "/review src/index.ts");
  assert.deepEqual(relayed.options, { triggerTurn: true, deliverAs: "followUp" });

  await pi.tools.get("supervisor_observe").execute("observe", { pane_id: worker.paneId });
  await pi.tools.get("supervisor_leave").execute("leave", {
    pane_id: worker.paneId,
    progress: "The reviewed worker finished one useful turn.",
  });
  await pi.events.get("message_start")({
    type: "message_start",
    message: { role: "custom", ...relayed.message, timestamp: Date.now() },
  });
  const directTurn = await pi.tools.get("supervisor_status").execute("follow-up", {
    pane_id: null,
  });
  assert.equal(directTurn.isError, false);
  await pi.tools.get("supervisor_reconsider").execute("event-during-follow-up", {
    pane_ids: [worker.paneId],
    reason: "another worker event arrived with the human follow-up",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pi.messages.length, 2, "background review waits for the direct human turn");

  await pi.events.get("agent_settled")();
  await waitFor(() => pi.messages.length === 3);
  assert.match(pi.messages[2].content, /another worker event arrived with the human follow-up/);
  pi.events.get("session_shutdown")();
});

test("a missing-decision retry waits until the human follow-up settles", async (t) => {
  const root = await fixture();
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  t.mock.method(HerdrClient.prototype, "snapshot", async () => snapshot({ agent_status: "working" }));
  t.mock.method(HerdrClient.prototype, "readAgent", async () => ({
    read: { text: "The worker finished one turn.", truncated: false },
  }));
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const pi = fakePi();
  herdrSupervisor(pi);
  await pi.tools.get("supervisor_reconsider").execute("review", {
    pane_ids: [worker.paneId],
    reason: "fresh worker evidence is available",
  });
  await pi.events.get("agent_settled")();
  await waitFor(() => pi.messages.length === 1);
  pi.events.get("input")({
    type: "input",
    text: "Handle my request before retrying the review.",
    source: "interactive",
    streamingBehavior: "steer",
  });
  const relayed = pi.customMessages.at(-1);
  assert.equal(pi.messages.length, 2);

  await pi.events.get("message_start")({
    type: "message_start",
    message: { role: "custom", ...relayed.message, timestamp: Date.now() },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pi.messages.length, 2, "the retry must not preempt the human follow-up");

  await pi.events.get("agent_settled")();
  await waitFor(() => pi.messages.length === 3);
  assert.match(pi.messages[2].content, /previous review ended without an explicit decision/);
  pi.events.get("session_shutdown")();
});

test("human input aborts and requeues an in-flight review preparation", async (t) => {
  const root = await fixture();
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  let releaseSnapshot;
  const blockedSnapshot = new Promise((resolve) => { releaseSnapshot = resolve; });
  t.mock.method(HerdrClient.prototype, "snapshot", async () => blockedSnapshot);
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const pi = fakePi();
  herdrSupervisor(pi);
  await pi.tools.get("supervisor_reconsider").execute("review", {
    pane_ids: [worker.paneId],
    reason: "fresh worker evidence is available",
  });
  const preparing = pi.events.get("agent_settled")();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(pi.events.get("input")({
    type: "input",
    text: "Handle this human request first.",
    source: "interactive",
    streamingBehavior: "steer",
  }), { action: "handled" });
  const relayed = pi.customMessages.at(-1);
  await pi.events.get("message_start")({
    type: "message_start",
    message: { role: "custom", ...relayed.message, timestamp: Date.now() },
  });
  releaseSnapshot(snapshot({ agent_status: "working" }));
  await preparing;
  assert.equal(pi.messages.length, 1, "preparation must not emit a review over the human turn");

  await pi.events.get("agent_settled")();
  await waitFor(() => pi.messages.length === 2);
  assert.match(pi.messages[1].content, /fresh worker evidence is available/);
  pi.events.get("session_shutdown")();
});

test("failed human follow-up delivery cannot block later reviews", async (t) => {
  const root = await fixture();
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  t.mock.method(HerdrClient.prototype, "snapshot", async () => snapshot({ agent_status: "working" }));
  t.mock.method(HerdrClient.prototype, "readAgent", async () => ({
    read: { text: "The worker finished one turn.", truncated: false },
  }));
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const pi = fakePi();
  herdrSupervisor(pi);
  await pi.tools.get("supervisor_reconsider").execute("review", {
    pane_ids: [worker.paneId],
    reason: "first review",
  });
  await pi.events.get("agent_settled")();
  await waitFor(() => pi.messages.length === 1);
  const sendMessage = pi.sendMessage;
  pi.sendMessage = () => { throw new Error("delivery failed"); };
  assert.throws(() => pi.events.get("input")({
    type: "input",
    text: "Do not strand supervision.",
    source: "interactive",
    streamingBehavior: "steer",
  }), /delivery failed/);
  pi.sendMessage = sendMessage;

  await pi.tools.get("supervisor_observe").execute("observe", { pane_id: worker.paneId });
  await pi.tools.get("supervisor_leave").execute("leave", {
    pane_id: worker.paneId,
    progress: "The worker remains healthy.",
  });
  await pi.events.get("agent_settled")();
  await pi.tools.get("supervisor_reconsider").execute("next-review", {
    pane_ids: [worker.paneId],
    reason: "review after failed delivery",
  });
  await pi.events.get("agent_settled")();
  await waitFor(() => pi.messages.length === 2);
  assert.match(pi.messages[1].content, /review after failed delivery/);
  pi.events.get("session_shutdown")();
});

test("a worker event cannot start an unfenced review inside the human follow-up turn", async (t) => {
  const root = await fixture();
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  let subscriptionEvent;
  t.mock.method(HerdrClient.prototype, "snapshot", async () => snapshot());
  t.mock.method(HerdrClient.prototype, "readAgent", async () => ({
    read: { text: "The worker finished one turn.", truncated: false },
  }));
  t.mock.method(HerdrClient.prototype, "subscribe", (_subscriptions, onEvent) => {
    subscriptionEvent = onEvent;
    return () => {};
  });

  const pi = fakePi();
  herdrSupervisor(pi);
  await pi.events.get("session_start")({}, { ui: { setStatus() {} } });
  await waitFor(() => pi.messages.length === 1);
  pi.events.get("input")({
    type: "input",
    text: "Answer me before the next review.",
    source: "interactive",
    streamingBehavior: "steer",
  });
  const relayed = pi.customMessages.at(-1);
  assert.equal(pi.messages.length, 2);

  await pi.events.get("message_start")({
    type: "message_start",
    message: { role: "custom", ...relayed.message, timestamp: Date.now() },
  });
  subscriptionEvent({ data: { pane_id: worker.paneId } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(pi.messages.length, 2, "no automatic review may run inside the human follow-up turn");

  await pi.events.get("agent_settled")();
  await waitFor(() => pi.messages.length === 3);
  assert.match(pi.messages[2].content, /previous review ended without an explicit decision/);
  pi.events.get("session_shutdown")();
});

test("a brief settled transition stays inside the worker native Goal", async (t) => {
  const root = await fixture();
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  let status = "working";
  let sequence = 2;
  let subscriptionEvent;
  t.mock.method(HerdrClient.prototype, "snapshot", async () => snapshot({
    agent_status: status,
    state_change_seq: sequence,
  }));
  t.mock.method(HerdrClient.prototype, "readAgent", async () => ({
    read: { text: "The native Goal really stopped here.", truncated: false },
  }));
  t.mock.method(HerdrClient.prototype, "subscribe", (_subscriptions, onEvent) => {
    subscriptionEvent = onEvent;
    return () => {};
  });

  const pi = fakePi();
  herdrSupervisor(pi, { workerEventSettleMs: 20 });
  await pi.events.get("session_start")({}, { ui: { setStatus() {} } });

  status = "done";
  sequence = 3;
  subscriptionEvent({ data: { pane_id: worker.paneId } });
  await pi.events.get("agent_settled")();
  assert.equal(pi.messages.length, 0, "an unrelated drain must not consume the raw transition early");
  await new Promise((resolve) => setTimeout(resolve, 15));
  status = "working";
  sequence = 4;
  subscriptionEvent({ data: { pane_id: worker.paneId } });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(pi.messages.length, 0, "native Goal continuation should not spend a supervisor turn");

  status = "done";
  sequence = 5;
  subscriptionEvent({ data: { pane_id: worker.paneId } });
  await waitFor(() => pi.messages.length === 1);
  assert.match(pi.messages[0].content, /worker is done/);
  pi.events.get("session_shutdown")();
});

test("settling a direct human decision clears its review fence", async (t) => {
  const root = await fixture();
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  t.mock.method(HerdrClient.prototype, "snapshot", async () => snapshot({ agent_status: "working" }));
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const pi = fakePi();
  herdrSupervisor(pi);
  const decision = await pi.tools.get("supervisor_leave").execute("leave", {
    pane_id: worker.paneId,
    progress: "The worker is actively pursuing the goal.",
  });
  assert.equal(decision.isError, false);

  const fenced = await pi.tools.get("supervisor_status").execute("before-settlement", {
    pane_id: null,
  });
  assert.equal(fenced.isError, true);
  assert.match(fenced.content[0].text, /decision is already applied/);

  await pi.events.get("agent_settled")();
  const nextTurn = await pi.tools.get("supervisor_status").execute("after-settlement", {
    pane_id: null,
  });
  assert.equal(nextTurn.isError, false);
  assert.doesNotMatch(nextTurn.content[0].text, /decision is already applied/);
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

test("human reconsideration is retained while its focused review is preparing", async (t) => {
  const root = await fixture();
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });

  let releaseFirstSnapshot;
  const firstSnapshot = new Promise((resolve) => { releaseFirstSnapshot = resolve; });
  let snapshotCalls = 0;
  let resumed = false;
  t.mock.method(HerdrClient.prototype, "snapshot", async () => {
    snapshotCalls += 1;
    if (snapshotCalls === 1) await firstSnapshot;
    return snapshot({ agent_status: resumed ? "working" : "idle", state_change_seq: snapshotCalls + 2 });
  });
  t.mock.method(HerdrClient.prototype, "readAgent", async () => ({
    read: { text: "The worker is ready to continue.", truncated: false },
  }));
  t.mock.method(HerdrClient.prototype, "promptAgent", async (_paneId, message) => {
    if (message === "/goal resume") resumed = true;
  });
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const pi = fakePi();
  herdrSupervisor(pi);
  await pi.tools.get("supervisor_reconsider").execute("first", {
    pane_ids: [worker.paneId],
    reason: "the first fact arrived",
  });
  const settling = pi.events.get("agent_settled")();
  await waitFor(() => snapshotCalls === 1);

  const startDuringPreparation = await pi.tools.get("supervisor_start_goal").execute("start-during-preparation", {
    goal: "Start unrelated work.",
    context: [],
    acceptance: ["The unrelated work is complete."],
    constraints: [],
    mode: "new",
    label: "unrelated",
    cwd: "/tmp",
  });
  assert.equal(startDuringPreparation.isError, true);
  assert.match(startDuringPreparation.content[0].text, /Finish preparing or reviewing/);

  const updateDuringPreparation = await pi.tools.get("supervisor_update_goal").execute("update-during-preparation", {
    pane_id: worker.paneId,
    goal: "Change the goal while its review is preparing.",
    context: [],
    acceptance: ["The changed goal is complete."],
    constraints: [],
    summary: "This update must wait for the current review.",
  });
  assert.equal(updateDuringPreparation.isError, true);
  assert.match(updateDuringPreparation.content[0].text, /Finish preparing or reviewing/);

  const retained = await pi.tools.get("supervisor_reconsider").execute("during-preparation", {
    pane_ids: [worker.paneId],
    reason: "a newer fact arrived during preparation",
  });
  assert.equal(retained.isError, false);
  releaseFirstSnapshot();
  await settling;
  await waitFor(() => pi.messages.length === 1);

  await pi.tools.get("supervisor_observe").execute("observe-first", { pane_id: worker.paneId });
  const decision = await pi.tools.get("supervisor_steer").execute("steer-first", {
    pane_id: worker.paneId,
    message: "Continue the next useful step.",
    evidence: ["The worker is ready to continue."],
  });
  assert.equal(decision.isError, false);
  await pi.events.get("agent_settled")();
  await waitFor(() => pi.messages.length === 2);
  assert.match(pi.messages[1].content, /a newer fact arrived during preparation/);
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
  assert.match(result.systemPrompt, /Define goals around outcomes rather than one attempt, tool, run, or approval/);
  assert.match(result.systemPrompt, /whether the blocker stops the outcome or only one path/);
  assert.match(result.systemPrompt, /continue independent work, alternative proof, mitigation, or preparation/);
  assert.match(result.systemPrompt, /peer review can select a materially affected wait/);
  assert.match(result.systemPrompt, /slower bounded safety check instead of repeatedly rediscovering unchanged state/);
  assert.match(result.systemPrompt, /report an unchanged result once and yield instead of sleeping or polling/);
  assert.match(result.systemPrompt, /contract itself is obsolete, contradictory, or impractical/);
  assert.match(result.systemPrompt, /objective and acceptance criteria cover the same scope and time horizon/);
  assert.match(result.systemPrompt, /final worker message, PR, run, report, or completed review cycle as evidence/);
  assert.match(result.systemPrompt, /Express required CI, live validation, or independent review as ordinary acceptance criteria/);
  assert.match(result.systemPrompt, /Do not create a second goal merely to represent a review phase/);
  assert.match(result.systemPrompt, /whole objective and every acceptance criterion at their declared horizon/);
  assert.match(result.systemPrompt, /Distinguish a finite deliverable from a standing improvement outcome by meaning and conversation context, never keyword matching/);
  assert.match(result.systemPrompt, /only explicit human instruction may stop or replace it/);
  assert.match(result.systemPrompt, /Treat a herdr-supervisor-error as current system evidence, not automatically as a new goal or feature/);
  assert.match(result.systemPrompt, /whether an agent can handle it with existing tools/);
  assert.match(result.systemPrompt, /whether an existing event or bounded review will trigger that agent/);
  assert.match(result.systemPrompt, /whether the agent has enough current context and durable knowledge/);
  assert.match(result.systemPrompt, /do not add another mechanism/);
  assert.match(result.systemPrompt, /Propose a new code primitive only for a proven missing capability or trigger/);
  assert.match(result.systemPrompt, /error explicitly says no action was applied/);
  assert.match(result.systemPrompt, /action was applied or may have been applied/);
  assert.match(result.systemPrompt, /follow the current worker evidence/);
  assert.match(result.systemPrompt, /steer only when it says the supervisor can resume the exact session/);
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
  assert.equal((await loadSupervisorGoals(root)).unstarted.length, 0);
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
  assert.equal(prompts.length, 0);
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
  let workerName;
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
    agents: [sessionReady ? { ...identified, name: workerName } : managed],
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
    waits += 1;
    if (waits === 1) throw new Error("native session unavailable");
    sessionReady = true;
    return { ...identified, name: workerName };
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
  assert.match(prompts[1], /^\/goal /);
  assert.match(prompts[1], /goal\.json/);
  assert.match(prompts[1], /Do not sleep, poll, or repeatedly reread unchanged state/);
  assert.equal((await loadSupervisorGoals(root)).active[0].paneId, managed.pane_id);
  pi.events.get("session_shutdown")();
});

test("restart reuses a legacy-named worker for an installed goal instead of creating a duplicate", async (t) => {
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
  const [installed] = (await loadSupervisorGoals(root)).unstarted;
  workerName = `goal-${installed.goalId.slice(2).replaceAll("-", "").toLowerCase().slice(0, 27)}`;
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

test("restart never adopts a legacy-named session already owned by another goal", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "herdr-supervisor-owned-legacy-"));
  const ownedSession = { source: "herdr:codex", agent: "codex", kind: "id", value: "session_owned" };
  await registerSupervisedGoal({
    paneId: "w1:p2",
    terminalId: "term_owned_old",
    agentSession: ownedSession,
  }, {
    objective: "Keep the existing release goal moving.",
    acceptance: ["The release goal is verified."],
  }, root, { goalId: "g_owner" });
  await installSupervisorGoal({
    objective: "Start the independent diagnostic.",
    acceptance: ["The diagnostic is verified."],
  }, root, { goalId: "g_unstarted" });
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

  const ownedAgent = {
    pane_id: "w1:p9",
    terminal_id: "term_owned_new",
    name: "goal-unstarted",
    agent_status: "idle",
    interactive_ready: true,
    workspace_id: "w1",
    tab_id: "w1:t9",
    agent_session: ownedSession,
  };
  const newAgent = {
    pane_id: "w1:p3",
    terminal_id: "term_new",
    name: goalWorkerName("g_unstarted"),
    agent_status: "idle",
    interactive_ready: true,
    workspace_id: "w1",
    tab_id: "w1:t3",
    agent_session: { source: "herdr:codex", agent: "codex", kind: "id", value: "session_new" },
  };
  let created = false;
  let starts = 0;
  const prompts = [];
  t.mock.method(HerdrClient.prototype, "snapshot", async () => ({
    agents: created ? [ownedAgent, newAgent] : [ownedAgent],
    panes: [
      { pane_id: "w1:p1", terminal_id: "term_supervisor", workspace_id: "w1", tab_id: "w1:t1" },
      { pane_id: ownedAgent.pane_id, terminal_id: ownedAgent.terminal_id, workspace_id: "w1", tab_id: ownedAgent.tab_id },
      ...(created ? [{ pane_id: newAgent.pane_id, terminal_id: newAgent.terminal_id, workspace_id: "w1", tab_id: newAgent.tab_id }] : []),
    ],
  }));
  t.mock.method(HerdrClient.prototype, "createTab", async () => {
    created = true;
    return { root_pane: { pane_id: newAgent.pane_id } };
  });
  t.mock.method(HerdrClient.prototype, "startAndWaitAgent", async (request) => {
    starts += 1;
    assert.equal(request.paneId, newAgent.pane_id);
    return newAgent;
  });
  t.mock.method(HerdrClient.prototype, "waitForAgentSession", async (paneId) => {
    assert.equal(paneId, newAgent.pane_id);
    return newAgent;
  });
  t.mock.method(HerdrClient.prototype, "promptAgent", async (paneId, prompt) => { prompts.push({ paneId, prompt }); });
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const pi = fakePi();
  herdrSupervisor(pi);
  const result = await pi.tools.get("supervisor_start_goal").execute("start", {
    goal: "Start the independent diagnostic.",
    acceptance: ["The diagnostic is verified."],
    placement: { mode: "new", label: "diagnostic" },
    working_directory: "/app",
  }, undefined, undefined, { ui: { setStatus() {} } });

  assert.equal(result.isError, false);
  assert.equal(starts, 1);
  assert.equal(prompts.some(({ paneId }) => paneId === ownedAgent.pane_id), false);
  const goals = await loadSupervisorGoals(root);
  assert.deepEqual(goals.active.map(({ agentSession }) => agentSession.value).sort(), ["session_new", "session_owned"]);
  assert.equal(goals.unstarted.length, 0);
  pi.events.get("session_shutdown")();
});

test("restart never infers legacy ownership from a completed goal name collision", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "herdr-supervisor-completed-legacy-collision-"));
  const completedGoalId = "g_aaaaaaaaaaaaaaaaaaaaaaaaaaa_completed";
  const targetGoalId = "g_aaaaaaaaaaaaaaaaaaaaaaaaaaa_target";
  const completed = await registerSupervisedGoal({
    paneId: "w1:p9",
    terminalId: "term_completed",
    agentSession: { source: "herdr:codex", agent: "codex", kind: "id", value: "session_completed" },
  }, {
    objective: "Complete the earlier diagnostic.",
    acceptance: ["The earlier diagnostic is verified."],
  }, root, { goalId: completedGoalId });
  await recordDecision(completed, "accept", {
    progress: "The earlier diagnostic is verified.",
    action: "Accepted the earlier goal.",
    evidence: ["The expected result was observed."],
    terminal: { state: "accepted", summary: "The expected result was observed." },
  }, root);
  await installSupervisorGoal({
    objective: "Start the later diagnostic.",
    acceptance: ["The later diagnostic is verified."],
  }, root, { goalId: targetGoalId });

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

  const completedAgent = {
    pane_id: "w1:p9",
    terminal_id: "term_completed",
    name: legacyGoalWorkerName(targetGoalId),
    agent_status: "idle",
    interactive_ready: true,
    workspace_id: "w1",
    tab_id: "w1:t9",
    agent_session: { source: "herdr:codex", agent: "codex", kind: "id", value: "session_completed" },
  };
  let creates = 0;
  let starts = 0;
  let prompts = 0;
  t.mock.method(HerdrClient.prototype, "snapshot", async () => ({
    agents: [completedAgent],
    panes: [
      { pane_id: "w1:p1", terminal_id: "term_supervisor", workspace_id: "w1", tab_id: "w1:t1" },
      { pane_id: completedAgent.pane_id, terminal_id: completedAgent.terminal_id, workspace_id: "w1", tab_id: completedAgent.tab_id },
    ],
  }));
  t.mock.method(HerdrClient.prototype, "createTab", async () => {
    creates += 1;
    return { root_pane: { pane_id: "w1:p3" } };
  });
  t.mock.method(HerdrClient.prototype, "startAndWaitAgent", async () => { starts += 1; });
  t.mock.method(HerdrClient.prototype, "promptAgent", async () => { prompts += 1; });
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const pi = fakePi();
  herdrSupervisor(pi);
  const result = await pi.tools.get("supervisor_start_goal").execute("start", {
    goal: "Start the later diagnostic.",
    acceptance: ["The later diagnostic is verified."],
    placement: { mode: "new", label: "diagnostic" },
    working_directory: "/app",
  }, undefined, undefined, { ui: { setStatus() {} } });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /legacy worker name.*ambiguous/i);
  assert.equal(creates, 0);
  assert.equal(starts, 0);
  assert.equal(prompts, 0);
  const goals = await loadSupervisorGoals(root);
  assert.equal(goals.completed.length, 1);
  assert.equal(goals.unstarted.length, 1);
  pi.events.get("session_shutdown")();
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
  const prompts = [];
  let resumed = false;
  t.mock.method(HerdrClient.prototype, "snapshot", async () => snapshot({
    agent_status: resumed ? "working" : "idle",
    state_change_seq: resumed ? 1 : 0,
  }));
  t.mock.method(HerdrClient.prototype, "readAgent", async () => ({ read: { text: "The restored worker is idle.", truncated: false } }));
  t.mock.method(HerdrClient.prototype, "promptAgent", async (paneId, text, wait) => {
    prompts.push({ paneId, text, wait });
    if (text === "/goal resume") resumed = true;
  });
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
  assert.deepEqual(prompts, [{
    paneId: worker.paneId,
    text: "/goal resume",
    wait: { until: ["working"], timeout_ms: 5000 },
  }, {
    paneId: worker.paneId,
    text: "Continue the restored goal from current evidence.",
    wait: undefined,
  }]);
  const [continued] = (await loadSupervisorGoals(root)).active;
  assert.deepEqual(continued.evidence, [
    "The restored worker is idle and the focused proof is still missing.",
  ]);
  const continuedAudit = await readAudit("g_test", root);
  assert.deepEqual(continuedAudit.at(-1).evidence, continued.evidence);
  pi.events.get("session_shutdown")();
});

test("an accepted native Goal resume fails closed when its snapshot is unavailable", async (t) => {
  const root = await fixture();
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  let resumed = false;
  const prompts = [];
  t.mock.method(HerdrClient.prototype, "snapshot", async () => {
    if (resumed) throw new Error("updated worker snapshot unavailable");
    return snapshot({ agent_status: "idle", state_change_seq: 0 });
  });
  t.mock.method(HerdrClient.prototype, "readAgent", async () => ({ read: { text: "The restored worker is idle.", truncated: false } }));
  t.mock.method(HerdrClient.prototype, "promptAgent", async (_paneId, message) => {
    prompts.push(message);
    resumed = true;
  });
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const pi = fakePi();
  herdrSupervisor(pi);
  await pi.events.get("session_start")({}, { ui: { setStatus() {} } });
  await waitFor(() => pi.messages.length === 1);
  await pi.tools.get("supervisor_observe").execute("observe", { pane_id: worker.paneId });
  const result = await pi.tools.get("supervisor_steer").execute("steer", {
    pane_id: worker.paneId,
    message: "Continue the restored goal from current evidence.",
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /native Goal resumed.*could not be observed/);
  assert.deepEqual(prompts, ["/goal resume"]);

  const duplicate = await pi.tools.get("supervisor_steer").execute("steer-again", {
    pane_id: worker.paneId,
    message: "Continue the restored goal from current evidence.",
  });
  assert.equal(duplicate.isError, true);
  assert.match(duplicate.content[0].text, /already applied/);
  assert.deepEqual(prompts, ["/goal resume"]);
  pi.events.get("session_shutdown")();
});

test("an uncertain native Goal resume cannot send or retry a tactical instruction", async (t) => {
  const root = await fixture();
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  const prompts = [];
  t.mock.method(HerdrClient.prototype, "snapshot", async () => snapshot({ agent_status: "idle" }));
  t.mock.method(HerdrClient.prototype, "readAgent", async () => ({
    read: { text: "The worker is ready to continue.", truncated: false },
  }));
  t.mock.method(HerdrClient.prototype, "promptAgent", async (_paneId, message) => {
    prompts.push(message);
    throw new Error("prompt response timed out after possible delivery");
  });
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const pi = fakePi();
  herdrSupervisor(pi);
  await pi.events.get("session_start")({}, { ui: { setStatus() {} } });
  await waitFor(() => pi.messages.length === 1);
  await pi.tools.get("supervisor_observe").execute("observe", { pane_id: worker.paneId });
  const result = await pi.tools.get("supervisor_steer").execute("steer", {
    pane_id: worker.paneId,
    message: "Continue the same goal.",
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Could not confirm that the native Goal resumed/);
  assert.deepEqual(prompts, ["/goal resume"]);
  const duplicate = await pi.tools.get("supervisor_steer").execute("steer-again", {
    pane_id: worker.paneId,
    message: "Continue the same goal.",
  });
  assert.equal(duplicate.isError, true);
  assert.match(duplicate.content[0].text, /already applied/);
  assert.deepEqual(prompts, ["/goal resume"]);
  pi.events.get("session_shutdown")();
});

test("a replacement session after native Goal resume receives no tactical instruction", async (t) => {
  const root = await fixture();
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  let resumed = false;
  const prompts = [];
  t.mock.method(HerdrClient.prototype, "snapshot", async () => snapshot({
    agent_status: resumed ? "working" : "idle",
    agent_session: resumed
      ? { ...worker.agentSession, value: "replacement_session" }
      : worker.agentSession,
  }));
  t.mock.method(HerdrClient.prototype, "readAgent", async () => ({
    read: { text: "The worker is ready to continue.", truncated: false },
  }));
  t.mock.method(HerdrClient.prototype, "promptAgent", async (_paneId, message) => {
    prompts.push(message);
    resumed = true;
  });
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const pi = fakePi();
  herdrSupervisor(pi);
  await pi.events.get("session_start")({}, { ui: { setStatus() {} } });
  await waitFor(() => pi.messages.length === 1);
  await pi.tools.get("supervisor_observe").execute("observe", { pane_id: worker.paneId });
  const result = await pi.tools.get("supervisor_steer").execute("steer", {
    pane_id: worker.paneId,
    message: "Continue the same goal.",
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /resulting worker identity did not match/);
  assert.deepEqual(prompts, ["/goal resume"]);
  const duplicate = await pi.tools.get("supervisor_steer").execute("steer-again", {
    pane_id: worker.paneId,
    message: "Continue the same goal.",
  });
  assert.equal(duplicate.isError, true);
  assert.match(duplicate.content[0].text, /already applied/);
  assert.deepEqual(prompts, ["/goal resume"]);
  pi.events.get("session_shutdown")();
});

test("a native Goal that settles again does not receive a tactical instruction", async (t) => {
  const root = await fixture();
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  const prompts = [];
  t.mock.method(HerdrClient.prototype, "snapshot", async () => snapshot({
    agent_status: "idle",
    state_change_seq: 3,
  }));
  t.mock.method(HerdrClient.prototype, "readAgent", async () => ({
    read: { text: "The worker is ready to continue.", truncated: false },
  }));
  t.mock.method(HerdrClient.prototype, "promptAgent", async (_paneId, message) => {
    prompts.push(message);
  });
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const pi = fakePi();
  herdrSupervisor(pi);
  await pi.events.get("session_start")({}, { ui: { setStatus() {} } });
  await waitFor(() => pi.messages.length === 1);
  await pi.tools.get("supervisor_observe").execute("observe", { pane_id: worker.paneId });
  const result = await pi.tools.get("supervisor_steer").execute("steer", {
    pane_id: worker.paneId,
    message: "Continue the same goal.",
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /settled again before the follow-up instruction/);
  assert.deepEqual(prompts, ["/goal resume"]);
  pi.events.get("session_shutdown")();
});

test("a native Goal resume that cannot be confirmed fails closed without retrying", async (t) => {
  const root = await fixture();
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  const prompts = [];
  t.mock.method(HerdrClient.prototype, "snapshot", async () => snapshot({
    agent_status: "idle",
    state_change_seq: 3,
  }));
  t.mock.method(HerdrClient.prototype, "readAgent", async () => ({
    read: { text: "The worker is ready to continue.", truncated: false },
  }));
  t.mock.method(HerdrClient.prototype, "promptAgent", async (_paneId, message) => {
    prompts.push(message);
    throw new Error("agent.prompt wait timed out");
  });
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const pi = fakePi();
  herdrSupervisor(pi);
  await pi.events.get("session_start")({}, { ui: { setStatus() {} } });
  await waitFor(() => pi.messages.length === 1);
  await pi.tools.get("supervisor_observe").execute("observe", { pane_id: worker.paneId });
  const result = await pi.tools.get("supervisor_steer").execute("steer", {
    pane_id: worker.paneId,
    message: "Continue the same goal.",
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Could not confirm that the native Goal resumed/);
  assert.match(result.content[0].text, /Do not resume it again/);
  assert.deepEqual(prompts, ["/goal resume"]);

  const repeated = await pi.tools.get("supervisor_steer").execute("steer-again", {
    pane_id: worker.paneId,
    message: "Continue the same goal.",
  });
  assert.equal(repeated.isError, true);
  assert.match(repeated.content[0].text, /already applied/);
  assert.deepEqual(prompts, ["/goal resume"]);
  pi.events.get("session_shutdown")();
});

test("a native Goal resume that changes worker identity fails closed without a follow-up instruction", async (t) => {
  const root = await fixture();
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  const prompts = [];
  let resumed = false;
  t.mock.method(HerdrClient.prototype, "snapshot", async () => snapshot({
    agent_status: resumed ? "working" : "idle",
    state_change_seq: 3,
    agent_session: resumed
      ? { source: "herdr:codex", agent: "codex", kind: "id", value: "session_other" }
      : worker.agentSession,
  }));
  t.mock.method(HerdrClient.prototype, "readAgent", async () => ({
    read: { text: "The worker is ready to continue.", truncated: false },
  }));
  t.mock.method(HerdrClient.prototype, "promptAgent", async (_paneId, message) => {
    prompts.push(message);
    resumed = true;
  });
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const pi = fakePi();
  herdrSupervisor(pi);
  await pi.events.get("session_start")({}, { ui: { setStatus() {} } });
  await waitFor(() => pi.messages.length === 1);
  await pi.tools.get("supervisor_observe").execute("observe", { pane_id: worker.paneId });
  const result = await pi.tools.get("supervisor_steer").execute("steer", {
    pane_id: worker.paneId,
    message: "Continue the same goal.",
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /resulting worker identity did not match/);
  assert.deepEqual(prompts, ["/goal resume"]);

  const repeated = await pi.tools.get("supervisor_steer").execute("steer-again", {
    pane_id: worker.paneId,
    message: "Continue the same goal.",
  });
  assert.equal(repeated.isError, true);
  assert.match(repeated.content[0].text, /already applied/);
  assert.deepEqual(prompts, ["/goal resume"]);
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
  assert.equal(stored.wait.goalId, "g_peer");
  assert.equal(stored.wait.paneId, "w1:p7");
  assert.ok(Date.parse(stored.wait.reviewAt) > Date.now());
  pi.events.get("session_shutdown")();
});

test("a peer review wakes only the dependent wait selected by the model", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "herdr-supervisor-peer-wait-"));
  const sessionFile = join(root, "waiting-worker.jsonl");
  const unrelatedSessionFile = join(root, "unrelated-waiting-worker.jsonl");
  await writeFile(sessionFile, "");
  await writeFile(unrelatedSessionFile, "");
  const waitingWorker = {
    ...worker,
    agentSession: { source: "herdr:codex", agent: "codex", kind: "path", value: sessionFile },
  };
  const peerWorker = {
    paneId: "w1:p7",
    terminalId: "term_peer",
    agentSession: { source: "herdr:codex", agent: "codex", kind: "id", value: "session_peer" },
  };
  const unrelatedWaitingWorker = {
    paneId: "w1:p3",
    terminalId: "term_other_waiter",
    agentSession: { source: "herdr:codex", agent: "codex", kind: "path", value: unrelatedSessionFile },
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
      goalId: "g_peer",
      reviewAt: new Date(Date.now() + 60_000).toISOString(),
    },
    observationCursor: { kind: "codex-jsonl", path: sessionFile, offset: 0 },
  }, root);
  const unrelatedWaiting = await registerSupervisedGoal(unrelatedWaitingWorker, {
    objective: "Publish the peer's eventual capacity report.",
    acceptance: ["The report is published."],
  }, root, { goalId: "g_other_waiter" });
  await recordDecision(unrelatedWaiting, "leave", {
    progress: "The report template is ready.",
    action: "Wait for the peer's final report.",
    wait: {
      condition: "w1:p7 to publish its final capacity report",
      paneId: peerWorker.paneId,
      goalId: "g_peer",
      reviewAt: new Date(Date.now() + 60_000).toISOString(),
    },
    observationCursor: { kind: "codex-jsonl", path: unrelatedSessionFile, offset: 0 },
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
    {
      pane_id: unrelatedWaitingWorker.paneId,
      terminal_id: unrelatedWaitingWorker.terminalId,
      agent_status: "idle",
      state_change_seq: 2,
      agent_session: unrelatedWaitingWorker.agentSession,
    },
  ];
  t.mock.method(HerdrClient.prototype, "snapshot", async () => ({
    agents,
    panes: agents.map((agent) => ({ pane_id: agent.pane_id, terminal_id: agent.terminal_id })),
  }));
  t.mock.method(HerdrClient.prototype, "readAgent", async () => ({
    read: { text: "The peer recorded its current capacity decision.", truncated: false },
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
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(pi.messages.length, 0, "a raw peer event without meaningful evidence should remain cheap");

  await pi.tools.get("supervisor_reconsider").execute("reconsider-peer", {
    pane_ids: [peerWorker.paneId],
    reason: "the peer has a fresh capacity decision",
  });
  await pi.events.get("agent_settled")();
  await waitFor(() => pi.messages.length === 1);
  assert.match(pi.messages[0].content, /fresh capacity decision/);
  assert.match(pi.messages[0].content, /Goals waiting on this goal/);
  assert.match(pi.messages[0].content, /g_waiting \(w1:p2\): w1:p7 to stop using shared capacity/);
  assert.match(pi.messages[0].content, /g_other_waiter \(w1:p3\): w1:p7 to publish its final capacity report/);
  await pi.tools.get("supervisor_observe").execute("observe-peer", { pane_id: peerWorker.paneId });
  await pi.tools.get("supervisor_reconsider").execute("route-peer-effect", {
    pane_ids: [waitingWorker.paneId],
    reason: "the fresh capacity decision materially changed the shared-capacity wait but not the final-report wait",
  });
  const leave = await pi.tools.get("supervisor_leave").execute("leave-peer", {
    pane_id: peerWorker.paneId,
    progress: "The peer recorded its current capacity decision.",
  });
  assert.equal(leave.isError, false);
  await pi.events.get("agent_settled")();
  await waitFor(() => pi.messages.length === 2);
  assert.match(pi.messages[1].content, /fresh capacity decision materially changed/);
  assert.match(pi.messages[1].content, /w1:p2/);
  assert.doesNotMatch(pi.messages[1].content, /w1:p3/);
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

test("a working worker cannot be mislabeled as waiting for its own next checkpoint", async (t) => {
  const root = await fixture();
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  let agentStatus = "blocked";
  t.mock.method(HerdrClient.prototype, "snapshot", async () => snapshot({ agent_status: agentStatus, state_change_seq: 3 }));
  t.mock.method(HerdrClient.prototype, "readAgent", async () => ({ read: { text: "The worker is actively producing the next checkpoint.", truncated: false } }));
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const pi = fakePi();
  herdrSupervisor(pi);
  await pi.events.get("session_start")({}, { ui: { setStatus() {} } });
  await waitFor(() => pi.messages.length === 1);
  agentStatus = "working";
  await pi.tools.get("supervisor_observe").execute("observe", { pane_id: worker.paneId });
  const invalidWait = await pi.tools.get("supervisor_leave").execute("leave-waiting", {
    pane_id: worker.paneId,
    progress: "The worker is actively producing the next checkpoint.",
    waiting_for: "the worker's next checkpoint",
  });
  assert.equal(invalidWait.isError, true);
  assert.match(invalidWait.content[0].text, /working worker is active, not waiting/);
  assert.match(invalidWait.content[0].text, /Use null for waiting_for/);

  const active = await pi.tools.get("supervisor_leave").execute("leave-working", {
    pane_id: worker.paneId,
    progress: "The worker is actively producing the next checkpoint.",
  });
  assert.equal(active.isError, false);
  const [stored] = (await loadSupervisorGoals(root)).active;
  assert.equal(stored.wait, undefined);
  pi.events.get("session_shutdown")();
});

test("leaving rechecks live worker state before recording a wait", async (t) => {
  const root = await fixture();
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  let agentStatus = "idle";
  let decisionReads = 0;
  t.mock.method(HerdrClient.prototype, "snapshot", async () => {
    if (agentStatus === "working") decisionReads += 1;
    return snapshot({ agent_status: agentStatus, state_change_seq: agentStatus === "working" ? 4 : 3 });
  });
  t.mock.method(HerdrClient.prototype, "readAgent", async () => ({
    read: { text: "The worker has resumed useful work.", truncated: false },
  }));
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const pi = fakePi();
  herdrSupervisor(pi);
  await pi.events.get("session_start")({}, { ui: { setStatus() {} } });
  await waitFor(() => pi.messages.length === 1);
  await pi.tools.get("supervisor_observe").execute("observe", { pane_id: worker.paneId });
  agentStatus = "working";
  const leave = await pi.tools.get("supervisor_leave").execute("leave", {
    pane_id: worker.paneId,
    progress: "The worker appeared settled before this decision.",
    waiting_for: "an external result",
  });

  assert.equal(decisionReads, 1);
  assert.equal(leave.isError, true);
  assert.match(leave.content[0].text, /working worker is active, not waiting/);
  const [stored] = (await loadSupervisorGoals(root)).active;
  assert.equal(stored.wait, undefined);
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
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const leave = await pi.tools.get("supervisor_leave").execute("leave", {
    pane_id: worker.paneId,
    progress: "The authenticated request is throttled.",
    waiting_for: "the server-directed retry boundary",
    review_at: new Date(Date.now() + 2000).toISOString(),
  });
  assert.equal(leave.isError, false);

  await pi.events.get("agent_settled")();
  t.mock.timers.tick(1000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pi.messages.length, 1, "the generic interval must not replace the decision deadline");
  t.mock.timers.tick(1000);
  for (let attempt = 0; attempt < 100 && pi.messages.length < 2; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(pi.messages.length, 2, "the decision deadline must still wake the review");
  assert.match(pi.messages[1].content, /review deadline elapsed/);
  pi.events.get("session_shutdown")();
});

test("an exact steering review survives restart and cannot be suppressed as quiet work", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "herdr-supervisor-steer-review-"));
  const sessions = await mkdtemp(join(tmpdir(), "herdr-supervisor-session-"));
  const sessionFile = join(sessions, "worker.jsonl");
  const line = `${JSON.stringify({
    timestamp: "2026-08-29T14:00:00.000Z",
    type: "response_item",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Retry at the exact boundary." }] },
  })}\n`;
  await writeFile(sessionFile, line);
  const exactWorker = {
    ...worker,
    agentSession: { source: "herdr:codex", agent: "codex", kind: "path", value: sessionFile },
  };
  await registerSupervisedGoal(exactWorker, {
    objective: "Complete one retry after its exact boundary.",
    acceptance: ["The retry succeeds."],
  }, root, { goalId: "g_exact_steer_review" });

  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  let agentStatus = "idle";
  let prompts = 0;
  t.mock.method(HerdrClient.prototype, "snapshot", async () => snapshot({
    agent_status: agentStatus,
    state_change_seq: agentStatus === "working" ? 3 : 2,
    agent_session: exactWorker.agentSession,
  }));
  t.mock.method(HerdrClient.prototype, "promptAgent", async () => { prompts += 1; });
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const firstPi = fakePi({ reviewMs: "1000" });
  herdrSupervisor(firstPi);
  await firstPi.events.get("session_start")({}, { ui: { setStatus() {} } });
  await waitFor(() => firstPi.messages.length === 1);
  await firstPi.tools.get("supervisor_observe").execute("observe", { pane_id: worker.paneId });
  agentStatus = "working";
  const invalid = await firstPi.tools.get("supervisor_steer").execute("invalid-steer", {
    pane_id: worker.paneId,
    message: "Do not send this malformed schedule.",
    review_at: "later",
  });
  assert.equal(invalid.isError, true);
  assert.equal(prompts, 0, "an invalid deadline must fail before prompting the worker");
  const reviewAt = new Date(Date.now() + 1400).toISOString();
  const steer = await firstPi.tools.get("supervisor_steer").execute("steer", {
    pane_id: worker.paneId,
    message: "Retry once at the exact boundary.",
    review_at: reviewAt,
  });
  assert.equal(steer.isError, false);
  assert.equal(prompts, 1);
  const [stored] = (await loadSupervisorGoals(root)).active;
  assert.equal(stored.reviewAt, reviewAt);
  firstPi.events.get("session_shutdown")();

  const secondPi = fakePi({ reviewMs: "1000" });
  herdrSupervisor(secondPi);
  await secondPi.events.get("session_start")({}, { ui: { setStatus() {} } });
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal(secondPi.messages.length, 0, "the exact boundary must survive without firing early");
  await waitFor(() => secondPi.messages.length === 1);
  assert.match(secondPi.messages[0].content, /review deadline elapsed/);
  secondPi.events.get("session_shutdown")();
});

test("routine deadlines stay quiet while a working worker has no new evidence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "herdr-supervisor-working-quiet-"));
  const sessions = await mkdtemp(join(tmpdir(), "herdr-supervisor-session-"));
  const sessionFile = join(sessions, "worker.jsonl");
  const line = `${JSON.stringify({
    timestamp: "2026-08-28T20:00:00.000Z",
    type: "response_item",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Work continues." }] },
  })}\n`;
  await writeFile(sessionFile, line);
  const exactWorker = {
    ...worker,
    agentSession: { source: "herdr:codex", agent: "codex", kind: "path", value: sessionFile },
  };
  const binding = await registerSupervisedGoal(exactWorker, {
    objective: "Finish a long-running validation.",
    acceptance: ["The complete validation is proved."],
  }, root, { goalId: "g_working_quiet" });
  await recordDecision(binding, "steer", {
    progress: "The long-running validation is active.",
    action: "Continue the validation.",
    observationCursor: { kind: "codex-jsonl", path: sessionFile, offset: Buffer.byteLength(line) },
    evidence: ["The validation started successfully."],
  }, root);

  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  t.mock.method(HerdrClient.prototype, "snapshot", async () => snapshot({
    agent_status: "working",
    state_change_seq: 3,
    agent_session: exactWorker.agentSession,
  }));
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const pi = fakePi({ reviewMs: "1000" });
  herdrSupervisor(pi);
  await pi.events.get("session_start")({}, { ui: { setStatus() {} } });
  await new Promise((resolve) => setTimeout(resolve, 1150));
  assert.equal(pi.messages.length, 0, "a routine deadline without new evidence must not spend a model review");
  const [stored] = (await loadSupervisorGoals(root)).active;
  assert.equal(stored.progress, "The long-running validation is active.");
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(pi.messages.length, 0, "a second unchanged health check must not spend a model review");
  pi.events.get("session_shutdown")();
});

test("a live checkpoint keeps later unchanged working checks quiet", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "herdr-supervisor-live-checkpoint-"));
  const sessions = await mkdtemp(join(tmpdir(), "herdr-supervisor-session-"));
  const sessionFile = join(sessions, "worker.jsonl");
  const line = `${JSON.stringify({
    timestamp: "2026-08-28T20:00:00.000Z",
    type: "response_item",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Ready for the next action." }] },
  })}\n`;
  await writeFile(sessionFile, line);
  const exactWorker = {
    ...worker,
    agentSession: { source: "herdr:codex", agent: "codex", kind: "path", value: sessionFile },
  };
  await registerSupervisedGoal(exactWorker, {
    objective: "Finish a long-running validation.",
    acceptance: ["The complete validation is proved."],
  }, root, {
    goalId: "g_live_checkpoint",
    at: new Date(Date.now() - 60_000).toISOString(),
  });

  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  let agentStatus = "idle";
  t.mock.method(HerdrClient.prototype, "snapshot", async () => snapshot({
    agent_status: agentStatus,
    state_change_seq: agentStatus === "working" ? 3 : 2,
    agent_session: exactWorker.agentSession,
  }));
  t.mock.method(HerdrClient.prototype, "promptAgent", async () => {});
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const pi = fakePi({ reviewMs: "1000" });
  herdrSupervisor(pi);
  await pi.events.get("session_start")({}, { ui: { setStatus() {} } });
  await waitFor(() => pi.messages.length === 1);
  await pi.tools.get("supervisor_observe").execute("observe", { pane_id: exactWorker.paneId });
  agentStatus = "working";
  const steer = await pi.tools.get("supervisor_steer").execute("steer", {
    pane_id: exactWorker.paneId,
    message: "Continue the validation.",
  });
  assert.equal(steer.isError, false);
  await pi.events.get("agent_settled")();

  await new Promise((resolve) => setTimeout(resolve, 1150));
  assert.equal(pi.messages.length, 1, "the fresh live checkpoint must suppress one quiet review interval");
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(pi.messages.length, 1, "unchanged working evidence remains a cheap check rather than a model review");
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
    progress: "The service asked us to wait.\nExternal watch target: github-pr hao1939/herdr-supervisor#16",
    action: "Wait for the service retry boundary; observe github-pr hao1939/herdr-supervisor#16 when supervision resumes.",
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
  assert.match(pi.messages[0].content, /External watch target: github-pr hao1939\/herdr-supervisor#16/);
  assert.doesNotMatch(pi.messages[0].content, /Watching:/);
  const observation = await pi.tools.get("supervisor_observe").execute("observe-due", {
    pane_id: worker.paneId,
  });
  assert.match(observation.content[0].text, /No new assistant messages/);
  const staleLeave = await pi.tools.get("supervisor_leave").execute("leave-stale", {
    pane_id: worker.paneId,
    progress: "The external condition may still be active.",
    waiting_for: "the service retry boundary",
    review_at: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.equal(staleLeave.isError, true);
  assert.match(staleLeave.content[0].text, /Cannot extend this expired external wait without fresh worker evidence/);
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
      {
        role: "custom",
        customType: "herdr-supervisor-human-follow-up",
        content: "Also prefer plain language.",
      },
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
  const [stored] = (await loadSupervisorGoals(root)).active;
  assert.equal(stored.lastDecision.decision, "steer");
  assert.equal(stored.lastDecision.action, "Run the focused proof.");
  const repeated = await pi.tools.get("supervisor_steer").execute("steer-again", {
    pane_id: worker.paneId,
    message: "Run the focused proof.",
  });
  assert.equal(prompts, 1);
  assert.match(repeated.content[0].text, /already applied/);
  pi.events.get("session_shutdown")();
});

test("continuing after restart refreshes an empty pane terminal and resumes the exact session", async (t) => {
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
  const restartedTerminal = "term_after_restart";
  t.mock.method(HerdrClient.prototype, "snapshot", async () => ({
    agents: [],
    panes: [{ pane_id: worker.paneId, terminal_id: restartedTerminal }],
  }));
  t.mock.method(HerdrClient.prototype, "startAndWaitAgent", async (request) => {
    resumes += 1;
    resumeRequest = request;
    return snapshot({ terminal_id: restartedTerminal }).agents[0];
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
  assert.equal(prompts, 1);
  assert.deepEqual(resumeRequest.args, [
    "resume",
    worker.agentSession.value,
    "/goal resume",
  ]);
  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /Resumed the exact codex session and native Goal/);
  const [stored] = (await loadSupervisorGoals(root)).active;
  assert.equal(stored.terminalId, restartedTerminal);
  assert.equal(stored.progress, "The worker was steered to continue: Continue from current goal evidence.");
  const repeated = await pi.tools.get("supervisor_steer").execute("continue-again", {
    pane_id: worker.paneId,
    message: "Continue from current goal evidence.",
  });
  assert.equal(resumes, 1);
  assert.match(repeated.content[0].text, /already applied/);
  pi.events.get("session_shutdown")();
});

test("a direct human steer relocates a missing-pane worker and resumes the exact saved session", async (t) => {
  const root = await fixture();
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

  const recoveryPane = {
    pane_id: "w1:p9",
    terminal_id: "term_recovered",
    workspace_id: "w1",
    tab_id: "w1:t9",
  };
  let disappeared = false;
  let created = false;
  let creates = 0;
  let resumed = false;
  let createRequest;
  let resumeRequest;
  const recoveryName = goalWorkerName("g_test");
  const recoveredAgent = () => ({
    pane_id: recoveryPane.pane_id,
    terminal_id: recoveryPane.terminal_id,
    workspace_id: recoveryPane.workspace_id,
    tab_id: recoveryPane.tab_id,
    agent_status: "working",
    state_change_seq: 1,
    agent_session: worker.agentSession,
    interactive_ready: true,
    name: "goal-test",
  });
  t.mock.method(HerdrClient.prototype, "snapshot", async () => ({
    agents: resumed
      ? [recoveredAgent()]
      : disappeared
        ? []
        : [{
            pane_id: worker.paneId,
            terminal_id: worker.terminalId,
            workspace_id: "w1",
            tab_id: "w1:t2",
            agent_status: "working",
            state_change_seq: 1,
            agent_session: worker.agentSession,
            interactive_ready: true,
            name: "goal-test",
          }],
    panes: [
      { pane_id: "w1:p1", terminal_id: "term_supervisor", workspace_id: "w1", tab_id: "w1:t1" },
      ...(!disappeared
        ? [{ pane_id: worker.paneId, terminal_id: worker.terminalId, workspace_id: "w1", tab_id: "w1:t2" }]
        : []),
      ...(created ? [recoveryPane] : []),
    ],
    tabs: created
      ? [{ tab_id: recoveryPane.tab_id, workspace_id: "w1", label: recoveryName }]
      : [],
  }));
  t.mock.method(HerdrClient.prototype, "createTab", async (request) => {
    createRequest = request;
    creates += 1;
    created = true;
    throw new Error("Herdr tab.create connection closed");
  });
  t.mock.method(HerdrClient.prototype, "startAndWaitAgent", async (request) => {
    resumeRequest = request;
    resumed = true;
    return recoveredAgent();
  });
  const prompts = [];
  t.mock.method(HerdrClient.prototype, "promptAgent", async (paneId, message) => {
    prompts.push({ paneId, message });
  });
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const pi = fakePi({ reviewMs: "1000" });
  herdrSupervisor(pi);
  await pi.events.get("session_start")({}, { ui: { setStatus() {} } });
  assert.equal(pi.messages.length, 0);
  disappeared = true;

  const interrupted = await pi.tools.get("supervisor_steer").execute("continue-interrupted", {
    pane_id: worker.paneId,
    message: "Continue from current goal evidence.",
  });
  assert.equal(interrupted.isError, true);
  assert.match(interrupted.content[0].text, /tab\.create connection closed/);
  assert.match(interrupted.content[0].text, /Routing recovery may have partly applied/);
  assert.match(interrupted.content[0].text, /Do not retry in this turn/);

  const sameTurnRetry = await pi.tools.get("supervisor_steer").execute("continue-same-turn", {
    pane_id: worker.paneId,
    message: "Continue from current goal evidence.",
  });
  assert.equal(sameTurnRetry.isError, true);
  assert.match(sameTurnRetry.content[0].text, /already applied/);
  assert.equal(creates, 1);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await waitFor(() => pi.messages.length === 1);
  assert.match(pi.messages[0].content, /worker pane is no longer present/);
  await pi.tools.get("supervisor_observe").execute("observe-after-recovery-error", {
    pane_id: worker.paneId,
  });

  const result = await pi.tools.get("supervisor_steer").execute("continue", {
    pane_id: worker.paneId,
    message: "Continue from current goal evidence.",
  });

  assert.deepEqual(createRequest, {
    workspaceId: "w1",
    cwd: "/app",
    label: recoveryName,
    focus: false,
  });
  assert.equal(creates, 1);
  assert.deepEqual(resumeRequest.args, [
    "resume",
    worker.agentSession.value,
    "/goal resume",
  ]);
  assert.equal(resumeRequest.name, recoveryName);
  assert.equal(resumeRequest.paneId, recoveryPane.pane_id);
  assert.deepEqual(prompts.map(({ paneId }) => paneId), [recoveryPane.pane_id]);
  assert.equal(result.isError, false, result.content[0].text);
  assert.match(result.content[0].text, /Relocated and resumed the exact codex session and native Goal in w1:p9/);
  const [stored] = (await loadSupervisorGoals(root)).active;
  assert.equal(stored.paneId, recoveryPane.pane_id);
  assert.equal(stored.terminalId, recoveryPane.terminal_id);
  assert.equal(stored.agentSession.value, worker.agentSession.value);
  assert.equal(stored.lastDecision.decision, "steer");
  pi.events.get("session_shutdown")();
});

test("missing-pane recovery adopts an exact session restored after its tab is created", async (t) => {
  const root = await fixture();
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

  const createdPane = {
    pane_id: "w1:p9",
    terminal_id: "term_created",
    workspace_id: "w1",
    tab_id: "w1:t9",
  };
  const restoredAgent = {
    pane_id: "w1:p10",
    terminal_id: "term_restored",
    workspace_id: "w1",
    tab_id: "w1:t10",
    agent_status: "working",
    state_change_seq: 5,
    agent_session: worker.agentSession,
    interactive_ready: true,
    name: "already-restored",
  };
  let created = false;
  let snapshotsAfterCreate = 0;
  t.mock.method(HerdrClient.prototype, "snapshot", async () => {
    if (created) snapshotsAfterCreate += 1;
    return {
      agents: snapshotsAfterCreate > 1 ? [restoredAgent] : [],
      panes: [
        { pane_id: "w1:p1", terminal_id: "term_supervisor", workspace_id: "w1", tab_id: "w1:t1" },
        ...(created ? [createdPane, restoredAgent] : []),
      ],
      tabs: [],
    };
  });
  let creates = 0;
  t.mock.method(HerdrClient.prototype, "createTab", async () => {
    creates += 1;
    created = true;
    return { root_pane: createdPane };
  });
  let starts = 0;
  t.mock.method(HerdrClient.prototype, "startAndWaitAgent", async () => { starts += 1; });
  const prompts = [];
  t.mock.method(HerdrClient.prototype, "promptAgent", async (paneId, message) => {
    prompts.push({ paneId, message });
  });
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const pi = fakePi();
  herdrSupervisor(pi);
  const result = await pi.tools.get("supervisor_steer").execute("continue", {
    pane_id: worker.paneId,
    message: "Continue the exact goal.",
  });

  assert.equal(result.isError, false, result.content[0].text);
  assert.equal(creates, 1);
  assert.equal(starts, 0, "the already-restored native session must not be started again");
  assert.deepEqual(prompts.map(({ paneId }) => paneId), [restoredAgent.pane_id]);
  const [stored] = (await loadSupervisorGoals(root)).active;
  assert.equal(stored.paneId, restoredAgent.pane_id);
  assert.equal(stored.agentSession.value, worker.agentSession.value);
  pi.events.get("session_shutdown")();
});

test("missing-pane recovery adopts the exact session already restored elsewhere", async (t) => {
  const root = await fixture();
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  const movedAgent = {
    pane_id: "w1:p9",
    terminal_id: "term_recovered",
    workspace_id: "w1",
    tab_id: "w1:t9",
    agent_status: "idle",
    state_change_seq: 3,
    agent_session: worker.agentSession,
    interactive_ready: true,
    name: "goal-test",
  };
  let nativeGoalResumed = false;
  t.mock.method(HerdrClient.prototype, "snapshot", async () => ({
    agents: [{ ...movedAgent, agent_status: nativeGoalResumed ? "working" : "idle" }],
    panes: [{
      pane_id: movedAgent.pane_id,
      terminal_id: movedAgent.terminal_id,
      workspace_id: movedAgent.workspace_id,
      tab_id: movedAgent.tab_id,
    }],
  }));
  let creates = 0;
  let resumes = 0;
  t.mock.method(HerdrClient.prototype, "createTab", async () => { creates += 1; });
  t.mock.method(HerdrClient.prototype, "startAndWaitAgent", async () => { resumes += 1; });
  const prompts = [];
  t.mock.method(HerdrClient.prototype, "promptAgent", async (paneId, message) => {
    prompts.push({ paneId, message });
    if (message === "/goal resume") nativeGoalResumed = true;
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

  assert.equal(creates, 0);
  assert.equal(resumes, 0);
  assert.equal(prompts.length, 2);
  assert.deepEqual(prompts.map(({ paneId }) => paneId), [movedAgent.pane_id, movedAgent.pane_id]);
  assert.equal(prompts[0].message, "/goal resume");
  assert.match(prompts[1].message, /Continue from current goal evidence/);
  assert.equal(result.isError, false, result.content[0].text);
  assert.match(result.content[0].text, /Relocated the exact codex session and resumed its native Goal in w1:p9/);
  const [stored] = (await loadSupervisorGoals(root)).active;
  assert.equal(stored.paneId, movedAgent.pane_id);
  assert.equal(stored.agentSession.value, worker.agentSession.value);
  pi.events.get("session_shutdown")();
});

test("missing-pane recovery rejects duplicate processes for one native session", async (t) => {
  const root = await fixture();
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  const duplicateAgents = ["w1:p9", "w1:p10"].map((paneId, index) => ({
    pane_id: paneId,
    terminal_id: `term_duplicate_${index}`,
    agent_status: "working",
    agent_session: worker.agentSession,
    interactive_ready: true,
  }));
  t.mock.method(HerdrClient.prototype, "snapshot", async () => ({
    agents: duplicateAgents,
    panes: duplicateAgents.map((agent) => ({
      pane_id: agent.pane_id,
      terminal_id: agent.terminal_id,
    })),
  }));
  let creates = 0;
  let prompts = 0;
  t.mock.method(HerdrClient.prototype, "createTab", async () => { creates += 1; });
  t.mock.method(HerdrClient.prototype, "promptAgent", async () => { prompts += 1; });

  const pi = fakePi();
  herdrSupervisor(pi);
  const result = await pi.tools.get("supervisor_steer").execute("continue", {
    pane_id: worker.paneId,
    message: "Continue the exact goal.",
  });
  const repeated = await pi.tools.get("supervisor_steer").execute("continue-again", {
    pane_id: worker.paneId,
    message: "Continue the exact goal.",
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Could not start worker recovery/);
  assert.match(result.content[0].text, /multiple Herdr agents expose the same codex session/);
  assert.match(result.content[0].text, /may decide again in this review turn/);
  assert.equal(repeated.isError, true);
  assert.match(repeated.content[0].text, /Could not start worker recovery/);
  assert.match(repeated.content[0].text, /multiple Herdr agents expose the same codex session/);
  assert.equal(creates, 0);
  assert.equal(prompts, 0);
  pi.events.get("session_shutdown")();
});

test("post-relocation observation failure closes the turn and schedules recovery", async (t) => {
  const root = await fixture();
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  const movedAgent = {
    pane_id: "w1:p9",
    terminal_id: "term_recovered",
    agent_status: "working",
    state_change_seq: 3,
    agent_session: worker.agentSession,
    interactive_ready: true,
  };
  let snapshots = 0;
  t.mock.method(HerdrClient.prototype, "snapshot", async () => {
    snapshots += 1;
    if (snapshots === 3) throw new Error("post-relocation snapshot failed");
    return {
      agents: [movedAgent],
      panes: [{ pane_id: movedAgent.pane_id, terminal_id: movedAgent.terminal_id }],
    };
  });
  let prompts = 0;
  t.mock.method(HerdrClient.prototype, "promptAgent", async () => { prompts += 1; });
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const pi = fakePi({ reviewMs: "1000" });
  herdrSupervisor(pi);
  const result = await pi.tools.get("supervisor_steer").execute("continue", {
    pane_id: worker.paneId,
    message: "Continue the exact goal.",
  });
  const repeated = await pi.tools.get("supervisor_steer").execute("continue-again", {
    pane_id: worker.paneId,
    message: "Continue the exact goal.",
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /post-relocation snapshot failed/);
  assert.match(result.content[0].text, /bounded review will reread current state/);
  assert.equal(repeated.isError, true);
  assert.match(repeated.content[0].text, /already applied/);
  assert.equal(prompts, 0);
  const [stored] = (await loadSupervisorGoals(root)).active;
  assert.equal(stored.paneId, movedAgent.pane_id);
  pi.events.get("session_shutdown")();
});

test("a failed post-relocation reload cannot strand a durable dependent wake", async (t) => {
  const root = await fixture();
  const waitingWorker = {
    paneId: "w1:p3",
    terminalId: "term_waiting",
    agentSession: { source: "herdr:codex", agent: "codex", kind: "id", value: "session_waiting" },
  };
  const waiting = await registerSupervisedGoal(waitingWorker, {
    objective: "Continue after the peer goal finishes.",
    acceptance: ["The dependent work resumes."],
  }, root, { goalId: "g_waiting" });
  await recordDecision(waiting, "leave", {
    progress: "Waiting for the peer goal.",
    action: "Wait for the peer goal to finish.",
    evidence: [],
    wait: {
      condition: "the peer goal to finish",
      paneId: worker.paneId,
      reviewAt: new Date(Date.now() + 60_000).toISOString(),
    },
  }, root);

  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });

  const movedAgent = {
    pane_id: "w1:p9",
    terminal_id: "term_moved",
    agent_status: "working",
    state_change_seq: 3,
    agent_session: worker.agentSession,
    interactive_ready: true,
  };
  const waitingAgent = {
    pane_id: waitingWorker.paneId,
    terminal_id: waitingWorker.terminalId,
    agent_status: "working",
    state_change_seq: 4,
    agent_session: waitingWorker.agentSession,
    interactive_ready: true,
  };
  t.mock.method(HerdrClient.prototype, "snapshot", async () => ({
    agents: [movedAgent, waitingAgent],
    panes: [movedAgent, waitingAgent],
  }));
  t.mock.method(HerdrClient.prototype, "promptAgent", async () => {});
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  let loads = 0;
  const pi = fakePi();
  herdrSupervisor(pi, {
    async loadGoals() {
      loads += 1;
      if (loads === 2) throw new Error("post-relocation reload failed");
      return loadSupervisorGoals(root);
    },
  });

  const continued = await pi.tools.get("supervisor_steer").execute("continue", {
    pane_id: worker.paneId,
    message: "Continue the exact goal.",
  });
  assert.equal(continued.isError, false, continued.content[0].text);
  assert.ok(loads >= 3, "the next ordinary cache access must retry the failed reload");
  const storedWaiting = (await loadSupervisorGoals(root)).active.find((binding) => binding.goalId === "g_waiting");
  assert.equal(storedWaiting.wait.goalId, "g_test", "relocation must durably upgrade the peer identity");

  await pi.events.get("agent_settled")();
  await pi.commands.get("unsupervise").handler(movedAgent.pane_id, {
    ui: { notify() {}, setStatus() {} },
  });
  await waitFor(() => pi.messages.some((message) => (
    message.customType === "herdr-supervisor-review"
    && message.content.includes("g_waiting")
  )));
  pi.events.get("session_shutdown")();
});

test("missing-pane recovery refuses a pane assigned to another active goal", async (t) => {
  const root = await fixture();
  const otherWorker = {
    paneId: "w1:p9",
    terminalId: "term_other",
    agentSession: { source: "herdr:codex", agent: "codex", kind: "id", value: "session_other" },
  };
  await registerSupervisedGoal(otherWorker, {
    objective: "Keep the other goal isolated.",
  }, root, { goalId: "g_other" });
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });

  let conflict = false;
  t.mock.method(HerdrClient.prototype, "snapshot", async () => ({
    agents: conflict
      ? [{
          pane_id: otherWorker.paneId,
          terminal_id: otherWorker.terminalId,
          agent_status: "working",
          agent_session: worker.agentSession,
          interactive_ready: true,
        }]
      : [
          { pane_id: worker.paneId, terminal_id: worker.terminalId, agent_status: "working", agent_session: worker.agentSession },
          { pane_id: otherWorker.paneId, terminal_id: otherWorker.terminalId, agent_status: "working", agent_session: otherWorker.agentSession },
        ],
    panes: conflict
      ? [{ pane_id: otherWorker.paneId, terminal_id: otherWorker.terminalId }]
      : [
          { pane_id: worker.paneId, terminal_id: worker.terminalId },
          { pane_id: otherWorker.paneId, terminal_id: otherWorker.terminalId },
        ],
  }));
  let prompts = 0;
  t.mock.method(HerdrClient.prototype, "promptAgent", async () => { prompts += 1; });
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const pi = fakePi();
  herdrSupervisor(pi);
  await pi.events.get("session_start")({}, { ui: { setStatus() {} } });
  assert.equal(pi.messages.length, 0);
  conflict = true;
  const result = await pi.tools.get("supervisor_steer").execute("continue", {
    pane_id: worker.paneId,
    message: "Continue the exact goal.",
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /already pursues goal g_other/);
  assert.equal(prompts, 0);
  pi.events.get("session_shutdown")();
});

test("an uncertain resume response is not repeated in the same turn", async (t) => {
  const root = await fixture();
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  let resumes = 0;
  t.mock.method(HerdrClient.prototype, "snapshot", async () => snapshot(null));
  t.mock.method(HerdrClient.prototype, "startAndWaitAgent", async () => {
    resumes += 1;
    throw new Error("agent.start connection closed");
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
  assert.match(result.content[0].text, /resume may have started/);
  assert.match(result.content[0].text, /Do not resume it again in this turn/);
  const repeated = await pi.tools.get("supervisor_steer").execute("continue-again", {
    pane_id: worker.paneId,
    message: "Continue from current goal evidence.",
  });
  assert.equal(resumes, 1);
  assert.match(repeated.content[0].text, /already applied/);
  pi.events.get("session_shutdown")();
});

test("a due global review routes explicit reconsideration through ordinary focused reviews", async (t) => {
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
    reconsider: [{
      goal_id: "g_test",
      reason: "Current worker state and checkpoint need a focused decision",
    }],
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

test("an authenticated human follow-up settles a global review before its retry", async (t) => {
  const root = await fixture();
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  t.mock.method(HerdrClient.prototype, "snapshot", async () => snapshot({ agent_status: "working" }));
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const pi = fakePi({ globalReviewMs: "600000" });
  herdrSupervisor(pi);
  await pi.events.get("session_start")({}, { ui: { setStatus() {} } });
  await waitFor(() => pi.messages.length === 1);
  assert.equal(pi.messages[0].customType, "herdr-supervisor-global-review");

  assert.deepEqual(pi.events.get("input")({
    type: "input",
    text: "Answer this before retrying the global review.",
    source: "interactive",
    streamingBehavior: "steer",
  }), { action: "handled" });
  const relayed = pi.customMessages.at(-1);
  const stillActive = await pi.tools.get("supervisor_global_result").execute("before-follow-up", {
    summary: "This invalid result must not settle the review.",
    findings: [],
    reconsider: [{ goal_id: "g_missing", reason: "invalid reference" }],
  });
  assert.equal(stillActive.isError, true);
  assert.match(stillActive.content[0].text, /not found/);

  await pi.events.get("message_start")({
    type: "message_start",
    message: { role: "custom", ...relayed.message, timestamp: Date.now() },
  });
  const settled = await pi.tools.get("supervisor_global_result").execute("after-follow-up", {
    summary: "The old review should already be settled.",
    findings: [],
    reconsider: [],
  });
  assert.equal(settled.isError, true);
  assert.match(settled.content[0].text, /No global supervision review is active/);
  assert.equal(pi.messages.length, 2, "the retry must wait behind the human turn");

  await pi.events.get("agent_settled")();
  await waitFor(() => pi.messages.length === 3);
  assert.equal(pi.messages[2].customType, "herdr-supervisor-global-review");
  assert.match(pi.messages[2].content, /previous global review ended without supervisor_global_result/);
  pi.events.get("session_shutdown")();
});

test("a reported global finding does not force a focused review", async (t) => {
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

  const result = await pi.tools.get("supervisor_global_result").execute("global", {
    summary: "The finding is already represented by a future bounded wait.",
    findings: [{
      problem: "Several goals share one external condition",
      evidence: ["Each goal already has an explicit future review"],
      affected_goal_ids: ["g_test"],
    }],
    reconsider: [],
  });
  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /No focused review is needed/);
  await pi.events.get("agent_settled")();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(pi.messages.filter((message) => message.customType === "herdr-supervisor-review").length, 0);
  assert.equal(pi.messages.filter((message) => message.customType === "herdr-supervisor-global-finding").length, 1);
  pi.events.get("session_shutdown")();
});

test("a global review exposes unstarted goals without pretending they have workers", async (t) => {
  const root = await fixture();
  await installSupervisorGoal({
    objective: "Resume the saved release migration.",
    acceptance: ["The migration is verified."],
  }, root, { goalId: "g_unstarted" });
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
  assert.match(pi.messages[0].content, /"goalId": "g_unstarted"/);
  assert.match(pi.messages[0].content, /"workerState": "unstarted"/);

  const invalid = await pi.tools.get("supervisor_global_result").execute("unstarted-reconsider", {
    summary: "One saved goal has no worker.",
    findings: [{
      problem: "A saved goal has not started",
      evidence: ["Its worker state is unstarted"],
      affected_goal_ids: ["g_unstarted"],
    }],
    reconsider: [{ goal_id: "g_unstarted", reason: "Review the missing worker" }],
  });
  assert.equal(invalid.isError, true);
  assert.match(invalid.content[0].text, /no worker/);
  assert.match(invalid.content[0].text, /No focused reviews were queued/);

  const valid = await pi.tools.get("supervisor_global_result").execute("unstarted-finding", {
    summary: "One saved goal has no worker and needs a human resume decision.",
    findings: [{
      problem: "A saved goal has not started",
      evidence: ["Its worker state is unstarted"],
      affected_goal_ids: ["g_unstarted"],
    }],
    reconsider: [],
  });
  assert.equal(valid.isError, false);
  assert.match(valid.content[0].text, /No focused review is needed/);
  assert.equal(pi.messages.filter((message) => message.customType === "herdr-supervisor-global-finding").length, 1);
  pi.events.get("session_shutdown")();
});

test("a global review reloads goal contracts copied in after session start", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "herdr-supervisor-extension-"));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const reviewState = await loadGlobalReviewState(root);
  reviewState.nextReviewAt = new Date(Date.now() + 60_000).toISOString();
  await saveGlobalReviewState(reviewState, root);
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
  await installSupervisorGoal({
    objective: "Resume the copied release migration.",
    acceptance: ["The migration is verified."],
  }, root, { goalId: "g_copied" });
  t.mock.timers.tick(60_000);
  for (let attempt = 0; attempt < 1000 && !pi.messages.some(
    (message) => message.customType === "herdr-supervisor-global-review"
  ); attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const review = pi.messages.find((message) => message.customType === "herdr-supervisor-global-review");
  assert.ok(review, "timed out waiting for global review message");
  assert.match(review.content, /"goalId": "g_copied"/);
  assert.match(review.content, /"workerState": "unstarted"/);
  const result = await pi.tools.get("supervisor_global_result").execute("copied-finding", {
    summary: "A copied goal has not been started.",
    findings: [{
      problem: "A saved goal has no worker",
      evidence: ["Its worker state is unstarted"],
      affected_goal_ids: ["g_copied"],
    }],
    reconsider: [],
  });
  assert.equal(result.isError, false);
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

  const ambiguousDeadline = new Date(Date.now() + 60_000).toISOString().replace(/Z$/, "");
  const invalidDeadline = await pi.tools.get("supervisor_global_result").execute("invalid-deadline", {
    summary: "The next review time is ambiguous.",
    findings: [],
    reconsider: [],
    next_review_at: ambiguousDeadline,
  });
  assert.equal(invalidDeadline.isError, true);
  assert.match(invalidDeadline.content[0].text, /timezone-bearing ISO 8601/);
  assert.match(invalidDeadline.content[0].text, /No focused reviews were queued/);

  const invalid = await pi.tools.get("supervisor_global_result").execute("invalid", {
    summary: "One reference is invalid.",
    findings: [{ problem: "Check both", evidence: ["one is unknown"], affected_goal_ids: ["g_test", "g_unknown"] }],
    reconsider: [],
  });
  assert.equal(invalid.isError, true);
  assert.match(invalid.content[0].text, /not found among active or unstarted goals/);
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
  const finding = {
    problem: "One already reported issue",
    evidence: ["The current snapshot proves it"],
    affected_goal_ids: ["g_test"],
  };
  await pi.tools.get("supervisor_global_result").execute("first", {
    summary: "Healthy.",
    findings: [finding],
    reconsider: [],
  });
  await pi.events.get("agent_settled")();
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await waitFor(() => pi.messages.filter((message) => message.customType === "herdr-supervisor-global-review").length === 2);
  const reviews = pi.messages.filter((message) => message.customType === "herdr-supervisor-global-review");
  assert.match(reviews[1].content, /Previously active finding/);
  assert.match(reviews[1].content, /One already reported issue/);
  assert.match(reviews[1].content, /Return it again if the current snapshot still proves it/);
  await pi.tools.get("supervisor_global_result").execute("unchanged", {
    summary: "No material change.",
    findings: [finding],
    reconsider: [],
  });
  assert.match((await loadGlobalReviewState(root)).lastFinding, /One already reported issue/);
  assert.equal(pi.messages.filter((message) => message.customType === "herdr-supervisor-global-finding").length, 1);

  await pi.events.get("agent_settled")();
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await waitFor(() => pi.messages.filter((message) => message.customType === "herdr-supervisor-global-review").length === 3);
  await pi.tools.get("supervisor_global_result").execute("resolved", {
    summary: "The issue is resolved.",
    findings: [],
    reconsider: [],
  });
  assert.equal((await loadGlobalReviewState(root)).lastFinding, undefined);

  await pi.events.get("agent_settled")();
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await waitFor(() => pi.messages.filter((message) => message.customType === "herdr-supervisor-global-review").length === 4);
  await pi.tools.get("supervisor_global_result").execute("recurred", {
    summary: "The issue recurred.",
    findings: [finding],
    reconsider: [],
  });
  assert.equal(pi.messages.filter((message) => message.customType === "herdr-supervisor-global-finding").length, 2);
  pi.events.get("session_shutdown")();
});
