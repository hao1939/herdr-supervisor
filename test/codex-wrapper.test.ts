import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

async function wrapper() {
  const directory = await mkdtemp(join(tmpdir(), "herdr-supervisor-codex-"));
  const agent = join(directory, "codex-agent");
  const script = join(directory, "codex");
  await writeFile(agent, "#!/bin/sh\nprintf '%s\\n' \"$@\"\n");
  await chmod(agent, 0o755);
  const source = await readFile(new URL("../container/bin/codex", import.meta.url), "utf8");
  await writeFile(script, source.replace("/usr/local/bin/codex-agent", agent));
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

test("restored Codex sessions show paused Goals without resuming them", async () => {
  const script = await wrapper();
  assert.deepEqual(run(script, ["resume", "session-1"]), [
    "-c",
    'tui.resume_cwd="session"',
    "resume",
    "session-1",
    "/goal",
  ]);
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

test("a caller-supplied native Goal resume remains authoritative", async () => {
  const script = await wrapper();
  assert.deepEqual(run(script, ["resume", "session-1", "/goal resume"]), [
    "-c",
    'tui.resume_cwd="session"',
    "resume",
    "session-1",
    "/goal resume",
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
  const cwd = await mkdtemp(join(tmpdir(), 'herdr-supervisor-project-"quoted"-'));
  const physicalCwd = await realpath(cwd);
  assert.deepEqual(run(script, ["resume", "session-1"], {
    cwd,
    env: { HERDR_SUPERVISOR_CODEX_FULL_ACCESS: "1" },
  }), [
    "--dangerously-bypass-approvals-and-sandbox",
    "--dangerously-bypass-hook-trust",
    "-c",
    `projects={${JSON.stringify(physicalCwd)}={trust_level="trusted"}}`,
    "-c",
    'tui.resume_cwd="session"',
    "resume",
    "session-1",
    "/goal",
  ]);
});

test("caller-supplied project trust remains authoritative", async () => {
  const script = await wrapper();
  const projectTrust = 'projects={"/explicit/project"={trust_level="untrusted"}}';
  assert.deepEqual(run(script, ["-c", projectTrust, "resume", "session-1"], {
    env: { HERDR_SUPERVISOR_CODEX_FULL_ACCESS: "1" },
  }), [
    "--dangerously-bypass-approvals-and-sandbox",
    "--dangerously-bypass-hook-trust",
    "-c",
    'tui.resume_cwd="session"',
    "-c",
    projectTrust,
    "resume",
    "session-1",
    "/goal",
  ]);
});

test("project trust is not added outside full-access mode", async () => {
  const script = await wrapper();
  assert.deepEqual(run(script, ["Start work."], {
    env: { HERDR_SUPERVISOR_CODEX_FULL_ACCESS: "0" },
  }), ["Start work."]);
});
