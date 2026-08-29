import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
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

function run(script, args) {
  const result = spawnSync(script, args, { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split("\n");
}

test("restored Codex sessions resume idle in their saved directory without a prompt", async () => {
  const script = await wrapper();
  assert.deepEqual(run(script, ["resume", "session-1"]), [
    "-c",
    'tui.resume_cwd="session"',
    "resume",
    "session-1",
    "/goal resume",
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

test("new Codex sessions do not receive a resume-directory override", async () => {
  const script = await wrapper();
  assert.deepEqual(run(script, ["Start work."]), ["Start work."]);
});

test("the wrapper preserves native Codex Goals", async () => {
  const script = await wrapper();
  assert.deepEqual(run(script, ["--enable", "goals", "Start work."]), ["--enable", "goals", "Start work."]);
});
