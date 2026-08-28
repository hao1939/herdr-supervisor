import assert from "node:assert/strict";
import { mkdir, mkdtemp, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import herdrSupervisor from "../extension.ts";
import { loadSupervisorGoals, registerSupervisedGoal } from "../src/goal-registry.js";
import { goalPaths } from "../src/goal-store.js";
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
  return { agents: agent === null ? [] : [current], panes: [{ pane_id: worker.paneId, terminal_id: worker.terminalId }] };
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
    terminal_id: "term_managed",
    agent_status: "idle",
    state_change_seq: 1,
    agent_session: { source: "herdr:codex", agent: "codex", kind: "id", value: "session_managed" },
    interactive_ready: true,
  };
  let splitRequest;
  let startRequest;
  let initialPrompt;
  t.mock.method(HerdrClient.prototype, "splitPane", async (request) => {
    splitRequest = request;
    return { type: "pane_info", pane: { pane_id: managed.pane_id } };
  });
  t.mock.method(HerdrClient.prototype, "startAndWaitAgent", async (request) => {
    startRequest = request;
    return managed;
  });
  t.mock.method(HerdrClient.prototype, "snapshot", async () => ({
    agents: [managed],
    panes: [{ pane_id: managed.pane_id, terminal_id: managed.terminal_id }],
  }));
  t.mock.method(HerdrClient.prototype, "promptAgent", async (_paneId, prompt) => {
    initialPrompt = prompt;
  });
  t.mock.method(HerdrClient.prototype, "subscribe", () => () => {});

  const pi = fakePi();
  herdrSupervisor(pi);
  const result = await pi.tools.get("supervisor_start_goal").execute("start", {
    goal: "Fix the focused regression.",
    acceptance: ["The focused test passes.", "The change is reviewed."],
    working_directory: "/app/projects/sample-project",
    direction: "down",
  }, undefined, undefined, { ui: { setStatus() {} } });

  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /Started and supervised goal/);
  assert.deepEqual(splitRequest, {
    paneId: "w1:p1",
    direction: "down",
    cwd: "/app/projects/sample-project",
    focus: false,
  });
  assert.equal(startRequest.kind, "codex");
  assert.equal(startRequest.paneId, managed.pane_id);
  assert.match(initialPrompt, /Fix the focused regression/);
  assert.match(initialPrompt, /The focused test passes/);
  const goals = await loadSupervisorGoals(root);
  assert.equal(goals.active.length, 1);
  assert.equal(goals.active[0].paneId, managed.pane_id);
  assert.deepEqual(goals.active[0].acceptance, ["The focused test passes.", "The change is reviewed."]);
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

test("recovery reports a resumed session separately from a failed continuation", async (t) => {
  const root = await fixture();
  const previousRoot = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_SUPERVISOR_GOALS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousRoot;
  });
  let resumes = 0;
  let prompts = 0;
  t.mock.method(HerdrClient.prototype, "snapshot", async () => snapshot(null));
  t.mock.method(HerdrClient.prototype, "startAndWaitAgent", async () => {
    resumes += 1;
    return snapshot().agents[0];
  });
  t.mock.method(HerdrClient.prototype, "promptAgent", async () => {
    prompts += 1;
    throw new Error("prompt transport closed");
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
  assert.equal(prompts, 1);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Resumed the exact codex session/);
  assert.match(result.content[0].text, /could not confirm whether the continuation was delivered/);
  assert.doesNotMatch(result.content[0].text, /^Could not recover worker/);
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
