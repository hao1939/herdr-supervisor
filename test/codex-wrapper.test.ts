import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { installSupervisorGoal, recordDecision, registerSupervisedGoal } from "../src/goal-registry.ts";
import { startGoal } from "../src/goal-store.ts";

async function wrapper() {
  const directory = await mkdtemp(join(tmpdir(), "herdr-supervisor-codex-"));
  const agent = join(directory, "codex-agent");
  const script = join(directory, "codex");
  await writeFile(agent, "#!/bin/sh\nprintf '%s\\n' \"$@\"\n");
  await chmod(agent, 0o755);
  const source = await readFile(new URL("../container/bin/codex", import.meta.url), "utf8");
  await writeFile(script, source
    .replace("/usr/local/bin/codex-agent", agent)
    .replace(
      "file:///opt/herdr-supervisor/src/goal-registry.ts",
      new URL("../src/goal-registry.ts", import.meta.url).href,
    )
    .replace(
      "file:///opt/herdr-supervisor/src/identity.ts",
      new URL("../src/identity.ts", import.meta.url).href,
    ));
  await chmod(script, 0o755);
  return script;
}

function run(
  script: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) {
  const result = spawnSync(script, args, {
    encoding: "utf8",
    ...options,
    env: { ...process.env, HERDR_SUPERVISOR_CODEX_FULL_ACCESS: "0", ...options.env },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split("\n");
}

async function activeGoal(sessionId = "session-1") {
  const root = await mkdtemp(join(tmpdir(), "herdr-supervisor-goals-"));
  const binding = await registerSupervisedGoal({
    paneId: "w1:p2",
    terminalId: "term-1",
    agentSession: {
      source: "herdr:codex",
      agent: "codex",
      kind: "id",
      value: sessionId,
    },
  }, {
    objective: "Continue one active goal after process restoration.",
    acceptance: ["The active goal resumes in its exact session."],
  }, root, { goalId: "g_active" });
  return { root, binding };
}

test("restored active Codex sessions resume idle in their saved directory without a prompt", async () => {
  const script = await wrapper();
  const { root } = await activeGoal();
  assert.deepEqual(run(script, ["resume", "session-1"], {
    env: { HERDR_PANE_ID: "w1:p2", HERDR_SUPERVISOR_GOALS: root },
  }), [
    "-c",
    'tui.resume_cwd="session"',
    "resume",
    "session-1",
    "/goal resume",
  ]);
  assert.deepEqual(run(script, ["resume", "session-1"], {
    env: { HERDR_PANE_ID: "w1:p9", HERDR_SUPERVISOR_GOALS: root },
  }), ["-c", 'tui.resume_cwd="session"', "resume", "session-1"]);
});

test("restored stopped and unknown sessions stay parked", async () => {
  const script = await wrapper();
  const { root, binding } = await activeGoal();
  await recordDecision(binding, "stop", {
    progress: "The human stopped supervision.",
    action: "Stopped supervision without stopping the worker.",
    evidence: [],
    terminal: { state: "stopped", summary: "Stopped explicitly by the human." },
  }, root);

  const expected = ["-c", 'tui.resume_cwd="session"', "resume", "session-1"];
  assert.deepEqual(run(script, ["resume", "session-1"], {
    env: { HERDR_PANE_ID: "w1:p2", HERDR_SUPERVISOR_GOALS: root },
  }), expected);
  assert.deepEqual(run(script, ["resume", "unknown-session"], {
    env: { HERDR_PANE_ID: "w1:p2", HERDR_SUPERVISOR_GOALS: root },
  }), ["-c", 'tui.resume_cwd="session"', "resume", "unknown-session"]);
});

test("a native session bound to active goals in different panes stays parked", async () => {
  const script = await wrapper();
  const { root, binding } = await activeGoal();
  await installSupervisorGoal({
    objective: "Expose an invalid duplicate active binding.",
    acceptance: ["The duplicate never receives a native Goal resume."],
  }, root, { goalId: "g_duplicate" });
  await startGoal("g_duplicate", {
    paneId: "w1:p9",
    terminalId: "term-9",
    agentSession: binding.agentSession,
  }, root);

  assert.deepEqual(run(script, ["resume", "session-1"], {
    env: { HERDR_PANE_ID: "w1:p2", HERDR_SUPERVISOR_GOALS: root },
  }), ["-c", 'tui.resume_cwd="session"', "resume", "session-1"]);
});

test("an unreadable goal store parks an otherwise active session", async () => {
  const script = await wrapper();
  const { root } = await activeGoal();
  const broken = join(root, "g_broken");
  await mkdir(broken);
  await writeFile(join(broken, "goal.json"), "{");

  assert.deepEqual(run(script, ["resume", "session-1"], {
    env: { HERDR_PANE_ID: "w1:p2", HERDR_SUPERVISOR_GOALS: root },
  }), ["-c", 'tui.resume_cwd="session"', "resume", "session-1"]);
});

test("an explicit Codex resume-directory choice remains authoritative", async () => {
  const script = await wrapper();
  assert.deepEqual(run(script, ["-c", 'tui.resume_cwd="current"', "resume", "session-1", "Continue now."]), [
    "-c",
    'tui.resume_cwd="current"',
    "resume",
    "session-1",
    "Continue now.",
  ]);
});

test("a caller-supplied resume prompt remains authoritative", async () => {
  const script = await wrapper();
  assert.deepEqual(run(script, ["resume", "session-1", "Continue now."]), [
    "-c",
    'tui.resume_cwd="session"',
    "resume",
    "session-1",
    "Continue now.",
  ]);
});

test("new Codex sessions do not receive a resume-directory override", async () => {
  const script = await wrapper();
  assert.deepEqual(run(script, ["Start work."]), ["Start work."]);
});

test("the wrapper preserves native Codex Goals", async () => {
  const script = await wrapper();
  assert.deepEqual(run(script, ["--enable", "goals", "Start work."]), ["--enable", "goals", "Start work."]);
});

test("full-access workers trust their pane directory for unattended resume", async () => {
  const script = await wrapper();
  const { root } = await activeGoal();
  const cwd = await mkdtemp(join(tmpdir(), 'herdr-supervisor-project-"quoted"-'));
  const physicalCwd = await realpath(cwd);
  assert.deepEqual(run(script, ["resume", "session-1"], {
    cwd,
    env: { HERDR_PANE_ID: "w1:p2", HERDR_SUPERVISOR_CODEX_FULL_ACCESS: "1", HERDR_SUPERVISOR_GOALS: root },
  }), [
    "--dangerously-bypass-approvals-and-sandbox",
    "--dangerously-bypass-hook-trust",
    "-c",
    `projects={${JSON.stringify(physicalCwd)}={trust_level="trusted"}}`,
    "-c",
    'tui.resume_cwd="session"',
    "resume",
    "session-1",
    "/goal resume",
  ]);
});

test("caller-supplied project trust remains authoritative", async () => {
  const script = await wrapper();
  const { root } = await activeGoal();
  const projectTrust = 'projects={"/explicit/project"={trust_level="untrusted"}}';
  assert.deepEqual(run(script, ["-c", projectTrust, "resume", "session-1"], {
    env: { HERDR_PANE_ID: "w1:p2", HERDR_SUPERVISOR_CODEX_FULL_ACCESS: "1", HERDR_SUPERVISOR_GOALS: root },
  }), [
    "--dangerously-bypass-approvals-and-sandbox",
    "--dangerously-bypass-hook-trust",
    "-c",
    'tui.resume_cwd="session"',
    "-c",
    projectTrust,
    "resume",
    "session-1",
    "/goal resume",
  ]);
});

test("project trust is not added outside full-access mode", async () => {
  const script = await wrapper();
  assert.deepEqual(run(script, ["Start work."], {
    env: { HERDR_SUPERVISOR_CODEX_FULL_ACCESS: "0" },
  }), ["Start work."]);
});
