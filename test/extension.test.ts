import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import herdrSupervisor, { pullRequestTraceability } from "../src/extension.ts";
import { installSupervisorGoal, loadSupervisorGoals, recordDecision, recordExternalChange, registerSupervisedGoal } from "../src/goal-registry.ts";
import { goalPaths, loadGoalContract, readAudit } from "../src/goal-store.ts";
import { HerdrClient } from "../src/herdr-client.ts";
import { loadGlobalReviewState, saveGlobalReviewState } from "../src/global-review.ts";
import { terminalOutputCursor } from "../src/observation.ts";

const worker = {
  paneId: "w1:p2",
  terminalId: "term_test",
  agentSession: { source: "herdr:codex", agent: "codex", kind: "id", value: "session_test" },
};

function fakePi({ reviewMs = "600000", globalReviewMs = "0", externalWatchMs = "120000" } = {}): any {
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
      if (name === "supervisor-external-watch-ms") return externalWatchMs;
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
  assert.match(deliveredPrompts[0].prompt, /## Supervision/);
  assert.match(deliveredPrompts[0].prompt, /Write progress and final results in plain language/);
  assert.equal(deliveredPrompts[0].bindingExists, true);
  const goals = await loadSupervisorGoals(root);
  assert.equal(goals.active.length, 1);
  assert.equal(goals.active[0].paneId, managed.pane_id);
  assert.ok(deliveredPrompts[0].prompt.includes(`- Goal ID: ${JSON.stringify(goals.active[0].goalId)}`));
  assert.match(deliveredPrompts[0].prompt, /copy the current objective from the canonical goal\.json/);
  assert.ok(deliveredPrompts[0].prompt.includes(`- Worker: ${JSON.stringify(`goal-${goals.active[0].goalId.slice(2).replaceAll("-", "").toLowerCase().slice(0, 27)}`)}`));
  assert.ok(deliveredPrompts[0].prompt.includes(`- Codex session: ${JSON.stringify(managed.agent_session.value)}`));
  assert.ok(deliveredPrompts[0].prompt.includes(`- Pane: ${JSON.stringify(managed.pane_id)}`));
  assert.deepEqual(goals.active[0].context, ["Another worker is validating the same repository."]);
  assert.deepEqual(goals.active[0].acceptance, ["The focused test passes.", "The change is reviewed."]);
  assert.deepEqual(goals.active[0].constraints, ["Make changes only in an isolated worktree."]);
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
  assert.match(prompts[0].prompt, /Keep the native Goal active/);
  assert.match(prompts[0].prompt, /## Supervision/);
  assert.match(prompts[0].prompt, /copy the current objective from the canonical goal\.json/);
  assert.match(prompts[0].prompt, /- Worker: "refined-worker"/);
  assert.doesNotMatch(prompts[0].prompt, /Fix the focused regression\./);
  assert.match(prompts[0].prompt, /plain language/);
  assert.equal((await readAudit("g_test", root)).at(-1).type, "goal_refined");
  pi.events.get("session_shutdown")();
});

test("goal refinement drains its exact watch and preserves a change found in flight", async (t) => {
  const root = await fixture();
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  let releasePull;
  let fetches = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    fetches += 1;
    if (String(url).includes("/pulls/")) {
      return new Promise((resolve) => {
        releasePull = () => resolve(Response.json({
          head: { sha: "abc123" },
          state: "open",
          draft: false,
          mergeable: true,
        }));
      });
    }
    if (String(url).includes("/status?")) return Response.json({ statuses: [] });
    return Response.json({ check_runs: [{ id: 1, name: "test", status: "completed", conclusion: "success" }] });
  });
  t.mock.method(HerdrClient.prototype, "snapshot", async () => snapshot({ agent_status: "idle", state_change_seq: 3, name: "worker" }));
  t.mock.method(HerdrClient.prototype, "readAgent", async () => ({
    read: { text: "The worker is waiting for PR checks.", truncated: false },
  }));
  t.mock.method(HerdrClient.prototype, "promptAgent", async () => ({}));
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const pi = fakePi();
  herdrSupervisor(pi);
  await pi.events.get("session_start")({}, { ui: { setStatus() {} } });
  await waitFor(() => pi.messages.length === 1);
  await pi.tools.get("supervisor_observe").execute("observe", { pane_id: worker.paneId });
  await pi.tools.get("supervisor_leave").execute("leave", {
    pane_id: worker.paneId,
    progress: "Waiting for PR checks.",
    waiting_for: "PR checks to change",
    external_watch: { source: "github-pr", subject: "hao1939/herdr-supervisor#16", revision: "old" },
  });
  await pi.events.get("agent_settled")();
  await waitFor(() => fetches === 1);

  const refining = pi.tools.get("supervisor_update_goal").execute("refine", {
    pane_id: worker.paneId,
    goal: "Finish the exact refined goal.",
    acceptance: ["The refined proof passes."],
    summary: "The human refined the outcome.",
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await loadSupervisorGoals(root)).active[0].goal, "Finish the exact goal.");
  releasePull();
  const result = await refining;
  assert.equal(result.isError, false);
  const [refined] = (await loadSupervisorGoals(root)).active;
  assert.equal(refined.goal, "Finish the exact refined goal.");
  assert.ok(refined.externalChange, "the provider change found during refinement remains unresolved");
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
  t.mock.method(HerdrClient.prototype, "snapshot", async () => {
    snapshotCalls += 1;
    if (snapshotCalls === 1) await firstSnapshot;
    return snapshot({ agent_status: "idle", state_change_seq: snapshotCalls + 2 });
  });
  t.mock.method(HerdrClient.prototype, "readAgent", async () => ({
    read: { text: "The worker is ready to continue.", truncated: false },
  }));
  t.mock.method(HerdrClient.prototype, "promptAgent", async () => {});
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
  assert.match(result.systemPrompt, /contract itself is obsolete, contradictory, or impractical/);
  assert.match(result.systemPrompt, /objective and acceptance criteria cover the same scope and time horizon/);
  assert.match(result.systemPrompt, /final worker message, PR, run, report, or completed review cycle as evidence/);
  assert.match(result.systemPrompt, /whole objective and every acceptance criterion at their declared horizon/);
  assert.match(result.systemPrompt, /Distinguish a finite deliverable from a standing improvement outcome by meaning and conversation context, never keyword matching/);
  assert.match(result.systemPrompt, /only explicit human instruction may stop or replace it/);
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

test("leaving a worker revalidates its current state after polling drains", async (t) => {
  const root = await fixture();
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  let leaving = false;
  let leaveSnapshots = 0;
  t.mock.method(HerdrClient.prototype, "snapshot", async () => {
    const status = leaving && ++leaveSnapshots === 2 ? "working" : "idle";
    return snapshot({ agent_status: status, state_change_seq: 3 });
  });
  t.mock.method(HerdrClient.prototype, "readAgent", async () => ({
    read: { text: "The worker looked idle before the decision.", truncated: false },
  }));
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const pi = fakePi();
  herdrSupervisor(pi);
  await pi.events.get("session_start")({}, { ui: { setStatus() {} } });
  await waitFor(() => pi.messages.length === 1);
  await pi.tools.get("supervisor_observe").execute("observe", { pane_id: worker.paneId });
  leaving = true;
  const result = await pi.tools.get("supervisor_leave").execute("leave", {
    pane_id: worker.paneId,
    progress: "The worker appeared idle.",
    waiting_for: "an external result",
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /A working worker is active, not waiting/);
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

test("an external revision change wakes the exact goal while unchanged polls stay quiet", async (t) => {
  const root = await fixture();
  const previousGitHubToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "test-token";
  const unrelatedWorker = {
    paneId: "w1:p9",
    terminalId: "term_unrelated",
    agentSession: { source: "herdr:codex", agent: "codex", kind: "id", value: "session_unrelated" },
  };
  await registerSupervisedGoal(unrelatedWorker, {
    objective: "Finish an unrelated goal.",
    acceptance: ["The unrelated proof passes."],
  }, root, { goalId: "g_unrelated" });
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousGitHubToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousGitHubToken;
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  let conclusion = null;
  let fetches = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    fetches += 1;
    if (String(url).includes("/pulls/")) {
      return Response.json({
        head: { sha: "abc123" },
        state: "open",
        draft: false,
        mergeable: true,
      });
    }
    if (String(url).includes("/status?")) return Response.json({ statuses: [] });
    return Response.json({
      check_runs: [{
        name: "test",
        status: conclusion ? "completed" : "in_progress",
        conclusion,
      }],
    });
  });
  const focused = snapshot({ agent_status: "idle", state_change_seq: 3 }).agents[0];
  const unrelated = {
    pane_id: unrelatedWorker.paneId,
    terminal_id: unrelatedWorker.terminalId,
    agent_status: "working",
    state_change_seq: 1,
    agent_session: unrelatedWorker.agentSession,
    interactive_ready: true,
  };
  let workerText = "The worker is waiting for PR checks.";
  t.mock.method(HerdrClient.prototype, "snapshot", async () => ({
    agents: [focused, unrelated],
    panes: [focused, unrelated].map((agent) => ({ pane_id: agent.pane_id, terminal_id: agent.terminal_id })),
  }));
  t.mock.method(HerdrClient.prototype, "readAgent", async () => ({ read: { text: workerText, truncated: false } }));
  t.mock.method(HerdrClient.prototype, "promptAgent", async () => ({}));
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const pi = fakePi({ externalWatchMs: "1000" });
  herdrSupervisor(pi);
  await pi.events.get("session_start")({}, { ui: { setStatus() {} } });
  await waitFor(() => pi.messages.length === 1);
  await pi.tools.get("supervisor_observe").execute("observe", { pane_id: worker.paneId });
  const leave = await pi.tools.get("supervisor_leave").execute("leave", {
    pane_id: worker.paneId,
    progress: "The implementation is ready and its PR checks are running.",
    waiting_for: "GitHub PR checks to change",
    external_watch: { source: "github-pr", subject: "hao1939/herdr-supervisor#16" },
  });
  assert.equal(leave.isError, false);
  assert.match(leave.content[0].text, /Watching github-pr hao1939\/herdr-supervisor#16 between model turns/);
  await pi.events.get("agent_settled")();

  await waitFor(() => fetches >= 2);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.ok(fetches >= 4, "the unchanged source should be observed again");
  assert.equal(pi.messages.length, 1, "an unchanged observation must not start a model turn");

  conclusion = "success";
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await waitFor(() => pi.messages.length === 2);
  assert.match(pi.messages[1].content, /GitHub PR hao1939\/herdr-supervisor#16 is open; 1\/1 checks completed/);
  assert.match(pi.messages[1].content, /only a wake hint/);
  assert.match(pi.messages[1].content, /w1:p2/);
  assert.doesNotMatch(pi.messages[1].content, /w1:p9/);

  workerText = "";
  const changedObservation = await pi.tools.get("supervisor_observe").execute("observe-change", { pane_id: worker.paneId });
  assert.match(changedObservation.content[0].text, /Review trigger: GitHub PR hao1939\/herdr-supervisor#16 is open; 1\/1 checks completed/);
  const staleRenewal = await pi.tools.get("supervisor_leave").execute("renew-without-reread", {
    pane_id: worker.paneId,
    progress: "The old PR snapshot still looks healthy.",
    waiting_for: "PR checks to change again",
    external_watch: { source: "github-pr", subject: "hao1939/herdr-supervisor#16" },
  });
  assert.equal(staleRenewal.isError, true);
  assert.match(staleRenewal.content[0].text, /(external watch change triggered this review|authoritative reread evidence is still pending)/);
  const staleFinish = await pi.tools.get("supervisor_finish").execute("finish-without-reread", {
    pane_id: worker.paneId,
    summary: "The old PR snapshot looked complete.",
    evidence: ["Only the pre-change snapshot is available."],
  }, undefined, undefined, { ui: { setStatus() {} } });
  assert.equal(staleFinish.isError, true);
  assert.match(staleFinish.content[0].text, /(external watch change triggered this review|authoritative reread evidence is still pending)/);
  const staleQuestion = await pi.tools.get("supervisor_ask_human").execute("ask-without-reread", {
    pane_id: worker.paneId,
    question: "Should the worker trust the old PR result?",
  });
  assert.equal(staleQuestion.isError, true);
  assert.match(staleQuestion.content[0].text, /authoritative reread evidence is still pending/);
  const fetchesBeforeSecondChange = fetches;
  conclusion = "failure";
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await waitFor(() => fetches > fetchesBeforeSecondChange);
  assert.equal(pi.messages.length, 2, "a second change is queued behind the active review");
  const steer = await pi.tools.get("supervisor_steer").execute("steer", {
    pane_id: worker.paneId,
    message: "Recheck the failed PR checks and continue the same goal.",
  });
  assert.equal(steer.isError, false);
  assert.ok((await loadSupervisorGoals(root)).active.find((item) => item.goalId === "g_test")?.externalChange);
  await pi.events.get("agent_settled")();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(pi.messages.length, 2, "clearing the watch also removes its stale queued wake");
  pi.events.get("session_shutdown")();
});

test("missing-decision retries keep requiring a reread after an external change wake", async (t) => {
  const root = await fixture();
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  const binding = (await loadSupervisorGoals(root)).active[0];
  await recordExternalChange(binding, {
    source: "github-pr",
    subject: "hao1939/herdr-supervisor#16",
    revision: "changed-revision",
    observedAt: "2026-08-30T05:01:00.000Z",
  }, root, () => "2026-08-30T05:01:00.000Z");

  t.mock.method(HerdrClient.prototype, "snapshot", async () => snapshot({ agent_status: "idle", state_change_seq: 4 }));
  t.mock.method(HerdrClient.prototype, "readAgent", async () => ({ read: { text: "", truncated: false } }));
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const pi = fakePi();
  herdrSupervisor(pi);
  await pi.events.get("session_start")({}, { ui: { setStatus() {} } });
  await waitFor(() => pi.messages.length === 1);
  assert.match(pi.messages[0].content, /authoritative reread is still pending/);

  await pi.tools.get("supervisor_observe").execute("observe-initial", { pane_id: worker.paneId });
  const firstLeave = await pi.tools.get("supervisor_leave").execute("leave-initial", {
    pane_id: worker.paneId,
    progress: "The old PR snapshot still looks healthy.",
    waiting_for: "PR checks to change again",
    external_watch: { source: "github-pr", subject: "hao1939/herdr-supervisor#16" },
  });
  assert.equal(firstLeave.isError, true);
  assert.match(firstLeave.content[0].text, /authoritative reread evidence is still pending/);

  await pi.events.get("agent_settled")();
  await waitFor(() => pi.messages.length === 2);
  assert.match(pi.messages[1].content, /authoritative reread is still pending/);

  await pi.tools.get("supervisor_observe").execute("observe-retry", { pane_id: worker.paneId });
  const retryLeave = await pi.tools.get("supervisor_leave").execute("leave-retry", {
    pane_id: worker.paneId,
    progress: "Still no new authoritative read.",
    waiting_for: "PR checks to change again",
    external_watch: { source: "github-pr", subject: "hao1939/herdr-supervisor#16" },
  });
  assert.equal(retryLeave.isError, true);
  assert.match(retryLeave.content[0].text, /authoritative reread evidence is still pending/);
  pi.events.get("session_shutdown")();
});

test("restart retains an external reread until a later native final response", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "herdr-supervisor-external-restart-"));
  const sessionFile = join(root, "worker.jsonl");
  const firstLine = `${JSON.stringify({
    timestamp: "2026-08-30T05:00:00.000Z",
    type: "response_item",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "The old checks are pending." }] },
  })}\n`;
  await writeFile(sessionFile, firstLine);
  const exactWorker = {
    ...worker,
    agentSession: { source: "herdr:codex", agent: "codex", kind: "path", value: sessionFile },
  };
  const binding = await registerSupervisedGoal(exactWorker, {
    objective: "Verify PR 16 after its checks change.",
    acceptance: ["Current authoritative checks are reread and handled."],
  }, root, { goalId: "g_external_restart", at: "2026-08-30T05:00:00.000Z" });
  const cursor = { kind: "codex-jsonl", path: sessionFile, offset: Buffer.byteLength(firstLine) };
  await recordExternalChange(binding, {
    source: "github-pr",
    subject: "hao1939/herdr-supervisor#16",
    revision: "changed-revision",
    observedAt: "2026-08-30T05:01:00.000Z",
  }, root, () => "2026-08-30T05:01:00.000Z");
  await recordDecision(binding, "steer", {
    progress: "The worker was told to reread PR 16.",
    action: "Reread current PR 16 checks.",
    observationCursor: cursor,
    externalChangeRevision: "changed-revision",
    workerSequence: 3,
  }, root, () => "2026-08-30T05:02:00.000Z");

  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  t.mock.method(HerdrClient.prototype, "snapshot", async () => snapshot({
    agent_status: "idle",
    state_change_seq: 4,
    agent_session: exactWorker.agentSession,
  }));
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const beforeEvidence = fakePi();
  herdrSupervisor(beforeEvidence);
  await beforeEvidence.events.get("session_start")({}, { ui: { setStatus() {} } });
  await waitFor(() => beforeEvidence.messages.length === 1);
  assert.match(beforeEvidence.messages[0].content, /authoritative reread is still pending/);
  await beforeEvidence.tools.get("supervisor_observe").execute("observe-before-evidence", { pane_id: worker.paneId });
  const staleFinish = await beforeEvidence.tools.get("supervisor_finish").execute("finish-before-evidence", {
    pane_id: worker.paneId,
    summary: "The old evidence looked complete.",
    evidence: ["Only old evidence exists."],
  }, undefined, undefined, { ui: { setStatus() {} } });
  assert.equal(staleFinish.isError, true);
  assert.ok((await loadSupervisorGoals(root)).active[0].externalChange);
  beforeEvidence.events.get("session_shutdown")();

  const secondLine = `${JSON.stringify({
    timestamp: "2026-08-30T05:03:00.000Z",
    type: "response_item",
    payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "I reread PR 16; all current checks pass." }] },
  })}\n`;
  await appendFile(sessionFile, secondLine);
  const afterEvidence = fakePi();
  herdrSupervisor(afterEvidence);
  await afterEvidence.events.get("session_start")({}, { ui: { setStatus() {} } });
  await waitFor(() => afterEvidence.messages.length === 1);
  const observation = await afterEvidence.tools.get("supervisor_observe").execute("observe-after-evidence", { pane_id: worker.paneId });
  assert.match(observation.content[0].text, /I reread PR 16; all current checks pass/);
  assert.equal((await loadSupervisorGoals(root)).active[0].externalChange, undefined);
  const finish = await afterEvidence.tools.get("supervisor_finish").execute("finish-after-evidence", {
    pane_id: worker.paneId,
    summary: "The worker reread PR 16 and verified the current checks.",
    evidence: ["The post-change native Codex message reports all current checks pass."],
  }, undefined, undefined, { ui: { setStatus() {} } });
  assert.equal(finish.isError, false);
  afterEvidence.events.get("session_shutdown")();
});

test("steering records a delivery boundary after its prompt is accepted", async (t) => {
  const root = await fixture();
  const [binding] = (await loadSupervisorGoals(root)).active;
  await recordExternalChange(binding, {
    source: "github-pr",
    subject: "hao1939/herdr-supervisor#16",
    revision: "changed-revision",
    observedAt: "2026-08-30T05:01:00.000Z",
  }, root, () => "2026-08-30T05:01:00.000Z");
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  let sequence = 3;
  let workerOutput = "The old PR state was still pending.";
  t.mock.method(HerdrClient.prototype, "snapshot", async () => snapshot({ agent_status: "idle", state_change_seq: sequence }));
  t.mock.method(HerdrClient.prototype, "readAgent", async () => ({ read: { text: workerOutput, truncated: false } }));
  t.mock.method(HerdrClient.prototype, "promptAgent", async () => {
    workerOutput = "The worker settled while the reread instruction was delivered.";
  });
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const beforeSteer = fakePi();
  herdrSupervisor(beforeSteer);
  await beforeSteer.events.get("session_start")({}, { ui: { setStatus() {} } });
  await waitFor(() => beforeSteer.messages.length === 1);
  await beforeSteer.tools.get("supervisor_observe").execute("observe-old", { pane_id: worker.paneId });
  const steer = await beforeSteer.tools.get("supervisor_steer").execute("steer-reread", {
    pane_id: worker.paneId,
    message: "Reread the current PR state and continue.",
  });
  assert.equal(steer.isError, false);
  assert.deepEqual(
    (await loadSupervisorGoals(root)).active[0].observationCursor,
    terminalOutputCursor(workerOutput),
    "the checkpoint conservatively includes output produced during delivery",
  );
  beforeSteer.events.get("session_shutdown")();

  sequence = 4;
  const afterSteer = fakePi();
  herdrSupervisor(afterSteer);
  await afterSteer.events.get("session_start")({}, { ui: { setStatus() {} } });
  await waitFor(() => afterSteer.messages.length === 1);
  await afterSteer.tools.get("supervisor_observe").execute("observe-same-output", { pane_id: worker.paneId });
  assert.ok(
    (await loadSupervisorGoals(root)).active[0].externalChange,
    "output produced during delivery cannot satisfy the reread",
  );
  afterSteer.events.get("session_shutdown")();
});

test("steering fails closed when its post-delivery boundary cannot be observed", async (t) => {
  const root = await fixture();
  const [binding] = (await loadSupervisorGoals(root)).active;
  await recordExternalChange(binding, {
    source: "github-pr",
    subject: "hao1939/herdr-supervisor#16",
    revision: "changed-revision",
    observedAt: "2026-08-30T05:01:00.000Z",
  }, root, () => "2026-08-30T05:01:00.000Z");
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  let reads = 0;
  let prompts = 0;
  t.mock.method(HerdrClient.prototype, "snapshot", async () => snapshot({ agent_status: "idle", state_change_seq: 3 }));
  t.mock.method(HerdrClient.prototype, "readAgent", async () => {
    reads += 1;
    if (reads > 1) throw new Error("terminal observation unavailable");
    return { read: { text: "The old PR state was pending.", truncated: false } };
  });
  t.mock.method(HerdrClient.prototype, "promptAgent", async () => { prompts += 1; });
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const pi = fakePi();
  herdrSupervisor(pi);
  await pi.events.get("session_start")({}, { ui: { setStatus() {} } });
  await waitFor(() => pi.messages.length === 1);
  await pi.tools.get("supervisor_observe").execute("observe-old", { pane_id: worker.paneId });
  const result = await pi.tools.get("supervisor_steer").execute("steer-reread", {
    pane_id: worker.paneId,
    message: "Reread the current PR state and continue.",
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /safe boundary could not be observed afterward/);
  assert.equal(prompts, 1);
  const [stored] = (await loadSupervisorGoals(root)).active;
  assert.equal(stored.observationCursor.kind, "reread-boundary-unavailable");
  assert.equal(stored.externalChange.workerSequence, Number.MAX_SAFE_INTEGER);
  assert.equal(stored.lastDecision.decision, "steer");
  pi.events.get("session_shutdown")();
});

test("Codex fallback cannot treat a non-assistant record as reread evidence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "herdr-supervisor-codex-fallback-"));
  const sessionFile = join(root, "worker.jsonl");
  const oldLine = `${JSON.stringify({
    timestamp: "2026-08-30T05:00:00.000Z",
    type: "response_item",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "The old checks are pending." }] },
  })}\n`;
  await writeFile(sessionFile, oldLine);
  const exactWorker = {
    ...worker,
    agentSession: { source: "herdr:codex", agent: "codex", kind: "path", value: sessionFile },
  };
  const binding = await registerSupervisedGoal(exactWorker, {
    objective: "Verify PR 16 after its checks change.",
    acceptance: ["Current authoritative checks are reread and handled."],
  }, root, { goalId: "g_codex_fallback", at: "2026-08-30T05:00:00.000Z" });
  await recordExternalChange(binding, {
    source: "github-pr",
    subject: "hao1939/herdr-supervisor#16",
    revision: "changed-revision",
    observedAt: "2026-08-30T05:01:00.000Z",
  }, root, () => "2026-08-30T05:01:00.000Z");
  await recordDecision(binding, "steer", {
    progress: "The worker was told to reread PR 16.",
    action: "Reread current PR 16 checks.",
    observationCursor: { kind: "codex-jsonl", path: sessionFile, offset: Buffer.byteLength(oldLine) },
    externalChangeRevision: "changed-revision",
    workerSequence: 2,
  }, root, () => "2026-08-30T05:02:00.000Z");
  await appendFile(sessionFile, `${JSON.stringify({
    timestamp: "2026-08-30T05:03:00.000Z",
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Reread PR 16." }] },
  })}\n`);

  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  t.mock.method(HerdrClient.prototype, "snapshot", async () => snapshot({
    agent_status: "blocked",
    state_change_seq: 3,
    agent_session: exactWorker.agentSession,
  }));
  t.mock.method(HerdrClient.prototype, "readAgent", async () => ({
    read: { text: "The old terminal text is unchanged.", truncated: false },
  }));
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const pi = fakePi();
  herdrSupervisor(pi);
  await pi.events.get("session_start")({}, { ui: { setStatus() {} } });
  await waitFor(() => pi.messages.length === 1);
  await pi.tools.get("supervisor_observe").execute("observe-non-assistant", { pane_id: worker.paneId });
  assert.ok((await loadSupervisorGoals(root)).active[0].externalChange);
  pi.events.get("session_shutdown")();
});

test("a post-instruction final response clears the reread despite an earlier worker timestamp", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "herdr-supervisor-clock-skew-"));
  const sessionFile = join(root, "worker.jsonl");
  const oldLine = `${JSON.stringify({
    timestamp: "2026-08-30T05:00:00.000Z",
    type: "response_item",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "The old checks are pending." }] },
  })}\n`;
  await writeFile(sessionFile, oldLine);
  const exactWorker = {
    ...worker,
    agentSession: { source: "herdr:codex", agent: "codex", kind: "path", value: sessionFile },
  };
  const binding = await registerSupervisedGoal(exactWorker, {
    objective: "Verify PR 16 after its checks change.",
    acceptance: ["Current authoritative checks are reread and handled."],
  }, root, { goalId: "g_clock_skew", at: "2026-08-30T05:00:00.000Z" });
  await recordExternalChange(binding, {
    source: "github-pr",
    subject: "hao1939/herdr-supervisor#16",
    revision: "changed-revision",
    observedAt: "2026-08-30T05:01:00.000Z",
  }, root, () => "2026-08-30T05:01:00.000Z");
  await recordDecision(binding, "steer", {
    progress: "The worker was told to reread PR 16.",
    action: "Reread current PR 16 checks.",
    observationCursor: { kind: "codex-jsonl", path: sessionFile, offset: Buffer.byteLength(oldLine) },
    externalChangeRevision: "changed-revision",
    workerSequence: 2,
  }, root, () => "2026-08-30T05:02:00.000Z");
  await appendFile(sessionFile, `${JSON.stringify({
    timestamp: "2026-08-30T04:30:00.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      phase: "final_answer",
      content: [{ type: "output_text", text: "I reread PR 16; all current checks pass." }],
    },
  })}\n`);

  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  t.mock.method(HerdrClient.prototype, "snapshot", async () => snapshot({
    agent_status: "idle",
    state_change_seq: 3,
    agent_session: exactWorker.agentSession,
  }));
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const pi = fakePi();
  herdrSupervisor(pi);
  await pi.events.get("session_start")({}, { ui: { setStatus() {} } });
  await waitFor(() => pi.messages.length === 1);
  await pi.tools.get("supervisor_observe").execute("observe-skewed-final", { pane_id: worker.paneId });
  assert.equal(
    (await loadSupervisorGoals(root)).active[0].externalChange,
    undefined,
    "a transcript timestamp behind the supervisor clock cannot block a real reread",
  );
  pi.events.get("session_shutdown")();
});

test("acceptance rejects an external change recorded after its cached read", async (t) => {
  const root = await fixture();
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  t.mock.method(HerdrClient.prototype, "snapshot", async () => snapshot({ agent_status: "idle" }));
  t.mock.method(HerdrClient.prototype, "readAgent", async () => ({ read: { text: "The old result looked complete.", truncated: false } }));
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const pi = fakePi();
  herdrSupervisor(pi);
  await pi.events.get("session_start")({}, { ui: { setStatus() {} } });
  await waitFor(() => pi.messages.length === 1);
  await pi.tools.get("supervisor_observe").execute("observe-old", { pane_id: worker.paneId });
  const [binding] = (await loadSupervisorGoals(root)).active;
  await recordExternalChange(binding, {
    source: "github-pr",
    subject: "hao1939/herdr-supervisor#16",
    revision: "revision-after-cache",
    observedAt: new Date().toISOString(),
  }, root);
  const finish = await pi.tools.get("supervisor_finish").execute("finish-stale", {
    pane_id: worker.paneId,
    summary: "The old result passed.",
    evidence: ["Only the old result was observed."],
  }, undefined, undefined, { ui: { setStatus() {} } });

  assert.equal(finish.isError, true);
  assert.match(finish.content[0].text, /changed before acceptance/);
  assert.ok((await loadSupervisorGoals(root)).active[0].externalChange);
  pi.events.get("session_shutdown")();
});

test("an unrelated signal does not duplicate the same pending external reread review", async (t) => {
  const root = await fixture();
  const [binding] = (await loadSupervisorGoals(root)).active;
  await recordExternalChange(binding, {
    source: "github-pr",
    subject: "hao1939/herdr-supervisor#16",
    revision: "pending-revision",
    observedAt: "2026-08-30T05:01:00.000Z",
  }, root, () => "2026-08-30T05:01:00.000Z");
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  t.mock.method(HerdrClient.prototype, "snapshot", async () => snapshot({ agent_status: "idle", state_change_seq: 3 }));
  t.mock.method(HerdrClient.prototype, "readAgent", async () => ({ read: { text: "Only the old PR result is visible.", truncated: false } }));
  t.mock.method(HerdrClient.prototype, "promptAgent", async () => ({}));
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const pi = fakePi();
  herdrSupervisor(pi);
  await pi.events.get("session_start")({}, { ui: { setStatus() {} } });
  await waitFor(() => pi.messages.length === 1);
  assert.match(pi.messages[0].content, /authoritative reread is still pending/);
  await pi.tools.get("supervisor_observe").execute("observe-pending", { pane_id: worker.paneId });
  const steer = await pi.tools.get("supervisor_steer").execute("steer-reread", {
    pane_id: worker.paneId,
    message: "Reread PR 16 now.",
  });
  assert.equal(steer.isError, false);
  await pi.events.get("agent_settled")();

  await pi.tools.get("supervisor_reconsider").execute("human-reconsider", {
    pane_ids: [worker.paneId],
    reason: "the human asked for another look",
  });
  await pi.events.get("agent_settled")();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(pi.messages.length, 1, "an unrelated signal must not duplicate the same pending external reread review");
  pi.events.get("session_shutdown")();
});

test("a newer external change cannot fail the observation that discharged the old one", async (t) => {
  const root = await fixture();
  const [binding] = (await loadSupervisorGoals(root)).active;
  const oldOutput = "The old PR 16 terminal result.";
  await recordExternalChange(binding, {
    source: "github-pr",
    subject: "hao1939/herdr-supervisor#16",
    revision: "first-revision",
    observedAt: "2026-08-30T05:01:00.000Z",
  }, root, () => "2026-08-30T05:01:00.000Z");
  await recordDecision(binding, "steer", {
    progress: "The worker was told to reread PR 16.",
    action: "Reread current PR 16 checks.",
    externalChangeRevision: "first-revision",
    workerSequence: 2,
    observationCursor: terminalOutputCursor(oldOutput),
  }, root, () => "2026-08-30T05:02:00.000Z");
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  t.mock.method(HerdrClient.prototype, "snapshot", async () => snapshot({ agent_status: "idle", state_change_seq: 3 }));
  t.mock.method(HerdrClient.prototype, "readAgent", async () => ({ read: { text: "I reread PR 16; its current checks pass.", truncated: false } }));
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const pi = fakePi();
  herdrSupervisor(pi);
  await pi.events.get("session_start")({}, { ui: { setStatus() {} } });
  await waitFor(() => pi.messages.length === 1);
  await recordExternalChange(binding, {
    source: "github-pr",
    subject: "hao1939/herdr-supervisor#16",
    revision: "second-revision",
    observedAt: "2026-08-30T05:03:00.000Z",
  }, root, () => "2026-08-30T05:03:00.000Z");
  const observation = await pi.tools.get("supervisor_observe").execute("observe-after-second-change", { pane_id: worker.paneId });
  assert.equal(observation.isError, false, "a superseding external change must not lose the worker evidence");
  assert.match(observation.content[0].text, /I reread PR 16; its current checks pass/);
  assert.match(observation.content[0].text, /Pending external change: github-pr hao1939\/herdr-supervisor#16 at revision second-revision/);
  assert.match(observation.content[0].text, /Checkpoint warning/);
  assert.equal(
    (await loadSupervisorGoals(root)).active[0].externalChange?.revision,
    "second-revision",
    "the newer unresolved change survives the stale clear",
  );
  pi.events.get("session_shutdown")();
});

test("a settled terminal fallback needs output produced after its reread instruction", async (t) => {
  const root = await fixture();
  const oldOutput = "The old PR 16 terminal result.";
  const [binding] = (await loadSupervisorGoals(root)).active;
  await recordExternalChange(binding, {
    source: "github-pr",
    subject: "hao1939/herdr-supervisor#16",
    revision: "fallback-revision",
    observedAt: "2026-08-30T05:01:00.000Z",
  }, root, () => "2026-08-30T05:01:00.000Z");
  await recordDecision(binding, "steer", {
    progress: "The fallback worker was told to reread PR 16.",
    action: "Reread current PR 16 checks.",
    externalChangeRevision: "fallback-revision",
    workerSequence: 2,
    observationCursor: terminalOutputCursor(oldOutput),
  }, root, () => "2026-08-30T05:02:00.000Z");
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  let workerOutput = oldOutput;
  t.mock.method(HerdrClient.prototype, "snapshot", async () => snapshot({ agent_status: "idle", state_change_seq: 3 }));
  t.mock.method(HerdrClient.prototype, "readAgent", async () => ({ read: { text: workerOutput, truncated: false } }));
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const beforeOutput = fakePi();
  herdrSupervisor(beforeOutput);
  await beforeOutput.events.get("session_start")({}, { ui: { setStatus() {} } });
  await waitFor(() => beforeOutput.messages.length === 1);
  await beforeOutput.tools.get("supervisor_observe").execute("observe-old-fallback", { pane_id: worker.paneId });
  assert.ok((await loadSupervisorGoals(root)).active[0].externalChange, "old terminal output cannot satisfy the reread");
  beforeOutput.events.get("session_shutdown")();

  workerOutput = "I reread PR 16; its current checks pass.";
  const afterOutput = fakePi();
  herdrSupervisor(afterOutput);
  await afterOutput.events.get("session_start")({}, { ui: { setStatus() {} } });
  await waitFor(() => afterOutput.messages.length === 1);
  const observation = await afterOutput.tools.get("supervisor_observe").execute("observe-new-fallback", { pane_id: worker.paneId });
  assert.match(observation.content[0].text, /I reread PR 16; its current checks pass/);
  assert.equal((await loadSupervisorGoals(root)).active[0].externalChange, undefined);
  afterOutput.events.get("session_shutdown")();
});

test("a working reread stays quiet until its worker settles", async (t) => {
  const root = await fixture();
  const [binding] = (await loadSupervisorGoals(root)).active;
  const reviewAt = new Date(Date.now() + 60_000).toISOString();
  await recordExternalChange(binding, {
    source: "github-pr",
    subject: "hao1939/herdr-supervisor#16",
    revision: "working-revision",
    observedAt: new Date(Date.now() + 60_000).toISOString(),
  }, root);
  await recordDecision(binding, "steer", {
    progress: "The worker is rereading PR 16.",
    action: "Reread current PR 16 checks.",
    externalChangeRevision: "working-revision",
    workerSequence: 2,
    reviewAt,
  }, root);
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  let status = "working";
  let sequence = 3;
  let subscriptionEvent;
  t.mock.method(HerdrClient.prototype, "snapshot", async () => snapshot({ agent_status: status, state_change_seq: sequence }));
  t.mock.method(HerdrClient.prototype, "readAgent", async () => ({ read: { text: "Current PR reread finished.", truncated: false } }));
  t.mock.method(HerdrClient.prototype, "subscribe", (_subscriptions, onEvent) => {
    subscriptionEvent = onEvent;
    return () => {};
  });

  const pi = fakePi();
  herdrSupervisor(pi);
  await pi.events.get("session_start")({}, { ui: { setStatus() {} } });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(pi.messages.length, 0, "restart must not duplicate a reread already in flight");
  subscriptionEvent({ data: { pane_id: worker.paneId } });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(pi.messages.length, 0, "a working event must not duplicate the reread instruction");

  status = "idle";
  sequence = 4;
  subscriptionEvent({ data: { pane_id: worker.paneId } });
  await waitFor(() => pi.messages.length === 1);
  assert.match(pi.messages[0].content, /authoritative reread is still pending/);
  pi.events.get("session_shutdown")();
});

test("a slow failing provider stays single-flight while the bounded review still runs", async (t) => {
  const root = await fixture();
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  let fetches = 0;
  let failRead;
  t.mock.method(globalThis, "fetch", async () => {
    fetches += 1;
    return new Promise((_resolve, reject) => { failRead = () => reject(new Error("temporary provider failure")); });
  });
  t.mock.method(HerdrClient.prototype, "snapshot", async () => snapshot({ agent_status: "idle", state_change_seq: 3 }));
  t.mock.method(HerdrClient.prototype, "readAgent", async () => ({ read: { text: "The worker is waiting for PR checks.", truncated: false } }));
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const pi = fakePi({ reviewMs: "1000", externalWatchMs: "1000" });
  herdrSupervisor(pi);
  await pi.events.get("session_start")({}, { ui: { setStatus() {} } });
  await waitFor(() => pi.messages.filter((message) => message.customType === "herdr-supervisor-review").length === 1);
  await pi.tools.get("supervisor_observe").execute("observe", { pane_id: worker.paneId });
  const leave = await pi.tools.get("supervisor_leave").execute("leave", {
    pane_id: worker.paneId,
    progress: "The implementation is waiting for PR checks.",
    waiting_for: "GitHub PR checks to change",
    external_watch: { source: "github-pr", subject: "hao1939/herdr-supervisor#16" },
  });
  assert.equal(leave.isError, false);
  await pi.events.get("agent_settled")();
  await waitFor(() => fetches === 1);

  await new Promise((resolve) => setTimeout(resolve, 1100));
  await waitFor(() => pi.messages.filter((message) => message.customType === "herdr-supervisor-review").length === 2);
  assert.equal(fetches, 1, "a worker deadline must not start a second provider read");

  failRead();
  await waitFor(() => pi.messages.some((message) => message.customType === "herdr-supervisor-error"));
  assert.equal(
    pi.messages.filter((message) => message.customType === "herdr-supervisor-review").length,
    2,
    "a provider diagnostic must not start another model review",
  );
  pi.events.get("session_shutdown")();
});

test("steering drains an in-flight external observation before clearing its watch", async (t) => {
  const root = await fixture();
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  let releasePull;
  let fetches = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    fetches += 1;
    if (String(url).includes("/pulls/")) {
      return new Promise((resolve) => {
        releasePull = () => resolve(Response.json({
          head: { sha: "abc123" },
          state: "open",
          draft: false,
          mergeable: true,
        }));
      });
    }
    if (String(url).includes("/status?")) return Response.json({ statuses: [] });
    return Response.json({ check_runs: [{ id: 1, name: "test", status: "completed", conclusion: "success" }] });
  });
  t.mock.method(HerdrClient.prototype, "snapshot", async () => snapshot({ agent_status: "idle", state_change_seq: 3 }));
  t.mock.method(HerdrClient.prototype, "readAgent", async () => ({ read: { text: "The worker can continue independently.", truncated: false } }));
  let prompt;
  t.mock.method(HerdrClient.prototype, "promptAgent", async (_paneId, message) => {
    prompt = message;
    throw new Error("prompt response timed out after possible delivery");
  });
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const pi = fakePi();
  herdrSupervisor(pi);
  await pi.events.get("session_start")({}, { ui: { setStatus() {} } });
  await waitFor(() => pi.messages.filter((message) => message.customType === "herdr-supervisor-review").length === 1);
  await pi.tools.get("supervisor_observe").execute("observe", { pane_id: worker.paneId });
  await pi.tools.get("supervisor_leave").execute("leave", {
    pane_id: worker.paneId,
    progress: "The worker was waiting for PR checks.",
    waiting_for: "GitHub PR checks to change",
    external_watch: { source: "github-pr", subject: "hao1939/herdr-supervisor#16", revision: "old" },
  });
  await pi.events.get("agent_settled")();
  await waitFor(() => fetches === 1);

  await pi.tools.get("supervisor_reconsider").execute("reconsider", {
    pane_ids: [worker.paneId],
    reason: "independent work can continue without the PR result",
  });
  await pi.events.get("agent_settled")();
  await waitFor(() => pi.messages.filter((message) => message.customType === "herdr-supervisor-review").length === 2);
  await pi.tools.get("supervisor_observe").execute("observe-again", { pane_id: worker.paneId });
  const steering = pi.tools.get("supervisor_steer").execute("steer", {
    pane_id: worker.paneId,
    message: "Continue the independent work now.",
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(prompt, undefined, "steering must wait for the active provider read");
  releasePull();
  const steered = await steering;
  assert.equal(steered.isError, true);
  assert.match(steered.content[0].text, /Could not confirm whether w1:p2 received the instruction/);
  assert.match(prompt, /watched github-pr hao1939\/herdr-supervisor#16 changed/);
  assert.ok((await loadSupervisorGoals(root)).active.find((item) => item.goalId === "g_test")?.externalChange);
  await pi.events.get("agent_settled")();

  await waitFor(() => fetches === 3);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    pi.messages.filter((message) => message.customType === "herdr-supervisor-review").length,
    2,
    "the drained provider result must not create a duplicate review",
  );
  pi.events.get("session_shutdown")();
});

test("steering rereads worker identity after its provider fence", async (t) => {
  const root = await fixture();
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  let steering = false;
  let steeringSnapshots = 0;
  t.mock.method(HerdrClient.prototype, "snapshot", async () => {
    if (steering && ++steeringSnapshots === 2) {
      return snapshot({
        agent_status: "idle",
        agent_session: { ...worker.agentSession, value: "replacement-session" },
      });
    }
    return snapshot({ agent_status: "idle" });
  });
  t.mock.method(HerdrClient.prototype, "readAgent", async () => ({
    read: { text: "The registered worker was ready.", truncated: false },
  }));
  let prompts = 0;
  t.mock.method(HerdrClient.prototype, "promptAgent", async () => { prompts += 1; });
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const pi = fakePi();
  herdrSupervisor(pi);
  await pi.events.get("session_start")({}, { ui: { setStatus() {} } });
  await waitFor(() => pi.messages.length === 1);
  await pi.tools.get("supervisor_observe").execute("observe", { pane_id: worker.paneId });
  steering = true;
  const result = await pi.tools.get("supervisor_steer").execute("steer", {
    pane_id: worker.paneId,
    message: "Continue the same goal.",
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /rereading worker identity: worker value changed/);
  assert.equal(prompts, 0, "a replacement worker must not receive the instruction");
  pi.events.get("session_shutdown")();
});

test("a recovered provider error can be reported again after a later failure", async (t) => {
  const root = await fixture();
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  const previousGitHubToken = process.env.GITHUB_TOKEN;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  process.env.GITHUB_TOKEN = "test-token";
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
    if (previousGitHubToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousGitHubToken;
  });
  let pullReads = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).includes("/pulls/")) {
      pullReads += 1;
      if (pullReads !== 2) return new Response(null, { status: 503 });
      return Response.json({ head: { sha: "abc123" }, state: "open", draft: false, mergeable: true });
    }
    if (String(url).includes("/status?")) return Response.json({ statuses: [] });
    return Response.json({ check_runs: [] });
  });
  t.mock.method(HerdrClient.prototype, "snapshot", async () => snapshot({ agent_status: "idle", state_change_seq: 3 }));
  t.mock.method(HerdrClient.prototype, "readAgent", async () => ({ read: { text: "The worker is waiting for PR checks.", truncated: false } }));
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const pi = fakePi({ reviewMs: "10000", externalWatchMs: "1000" });
  herdrSupervisor(pi);
  await pi.events.get("session_start")({}, { ui: { setStatus() {} } });
  await waitFor(() => pi.messages.filter((message) => message.customType === "herdr-supervisor-review").length === 1);
  await pi.tools.get("supervisor_observe").execute("observe", { pane_id: worker.paneId });
  await pi.tools.get("supervisor_leave").execute("leave", {
    pane_id: worker.paneId,
    progress: "The worker is waiting for PR checks.",
    waiting_for: "GitHub PR checks to change",
    external_watch: { source: "github-pr", subject: "hao1939/herdr-supervisor#16" },
  });
  await pi.events.get("agent_settled")();

  await waitFor(() => pi.messages.filter((message) => message.customType === "herdr-supervisor-error").length === 1);
  await new Promise((resolve) => setTimeout(resolve, 2100));
  await waitFor(() => pi.messages.filter((message) => message.customType === "herdr-supervisor-error").length === 2);
  assert.equal(pullReads, 3);
  assert.equal(
    pi.messages.filter((message) => message.customType === "herdr-supervisor-review").length,
    1,
    "provider recovery and repeat failure must not start model turns",
  );
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

  const active = await pi.tools.get("supervisor_leave").execute("leave-working", {
    pane_id: worker.paneId,
    progress: "The worker is actively producing the next checkpoint.",
  });
  assert.equal(active.isError, false);
  const [stored] = (await loadSupervisorGoals(root)).active;
  assert.equal(stored.wait, undefined);
  pi.events.get("session_shutdown")();
});

test("a self peer hint cannot block an exact external watch", async (t) => {
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
    waiting_for: "PR checks to change",
    waiting_on_pane: worker.paneId,
    external_watch: { source: "github-pr", subject: "hao1939/herdr-supervisor#16" },
    review_at: new Date(Date.now() + 60_000).toISOString(),
  });

  assert.equal(leave.isError, false);
  assert.match(leave.content[0].text, /ignored a self-reference/);
  assert.match(leave.content[0].text, /Watching github-pr hao1939\/herdr-supervisor#16/);
  const [stored] = (await loadSupervisorGoals(root)).active;
  assert.equal(stored.wait.condition, "PR checks to change");
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

  const reviewAt = new Date(Date.now() + 1400).toISOString();
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
  const [binding] = (await loadSupervisorGoals(root)).active;
  await recordExternalChange(binding, {
    source: "github-pr",
    subject: "hao1939/herdr-supervisor#16",
    revision: "changed-revision",
    observedAt: new Date(Date.now() - 1000).toISOString(),
  }, root);
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
  assert.ok(stored.externalChange, "uncertain delivery must retain the reread obligation");
  assert.match(stored.lastDecision.action, /watched github-pr hao1939\/herdr-supervisor#16 changed/);
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
  assert.equal(prompts, 1);
  assert.deepEqual(resumeRequest.args, [
    "resume",
    worker.agentSession.value,
    "/goal resume",
  ]);
  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /Resumed the exact codex session and native Goal/);
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
