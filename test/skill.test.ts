import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readlink, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const skillPath = new URL("../skills/herdr-goals/SKILL.md", import.meta.url);
const skillMetadataPath = new URL("../skills/herdr-goals/agents/openai.yaml", import.meta.url);
const entrypointPath = new URL("../container/container-entrypoint.sh", import.meta.url);
const run = promisify(execFile);

test("the container installs the bundled goal skill when no entry exists", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "herdr-skill-entrypoint-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const codexHome = join(root, "codex");

  await run(entrypointPath.pathname, ["true"], {
    env: { ...process.env, CODEX_HOME: codexHome, PI_CODING_AGENT_DIR: join(root, "pi") },
  });

  assert.equal(
    await readlink(join(codexHome, "skills", "herdr-goals")),
    "/opt/herdr-supervisor/skills/herdr-goals",
  );
});

test("the container preserves an operator-owned goal skill symlink", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "herdr-skill-entrypoint-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const codexHome = join(root, "codex");
  const piHome = join(root, "pi");
  const target = join(codexHome, "skills", "herdr-goals");
  await mkdir(join(codexHome, "skills"), { recursive: true });
  await symlink("/operator/herdr-goals", target);

  await run(entrypointPath.pathname, ["true"], {
    env: { ...process.env, CODEX_HOME: codexHome, PI_CODING_AGENT_DIR: piHome },
  });

  assert.equal(await readlink(target), "/operator/herdr-goals");
});

test("the bundled goal-management skill keeps one validated action path", async () => {
  const skill = await readFile(skillPath, "utf8");

  assert.match(skill, /single live Herdr agent named/);
  assert.match(skill, /`supervisor`/);
  assert.match(skill, /Never edit goal-store files directly/);
  assert.match(skill, /`\/unsupervise <pane-id>`/);
  assert.match(skill, /ends\s+supervision without stopping the worker/);
  assert.match(skill, /Do not wake an/);
  assert.match(skill, /entire portfolio merely to refresh its display/);
});

test("the bundled goal-management skill verifies explicit stops as terminal state", async () => {
  const skill = await readFile(skillPath, "utf8");

  assert.match(skill, /canonical `current\.json` is/);
  assert.match(skill, /terminal with state `stopped`/);
  assert.match(skill, /worker was not stopped/);
});

test("the bundled goal-management skill limits discard to explicit unstarted goals", async () => {
  const skill = await readFile(skillPath, "utf8");

  assert.match(skill, /human explicitly asks to discard an exact saved goal/);
  assert.match(skill, /Never infer this\s+authority from age, duplication, a global-review finding, or an absent worker/);
  assert.match(skill, /fail closed for active or completed goals/);
  assert.match(skill, /exact\s+ID is no longer listed/);
});

test("the bundled goal-management skill distinguishes scheduled reconsideration", async () => {
  const skill = await readFile(skillPath, "utf8");

  assert.match(skill, /acknowledgement proves only that a focused review was\s+scheduled/);
  assert.match(skill, /until the resulting review or fresh\s+checkpoint is observed/);
});

test("the bundled goal-management skill supplies local worker start inputs", async () => {
  const skill = await readFile(skillPath, "utf8");

  assert.match(skill, /absolute worker\s+working directory/);
  assert.match(skill, /either a new tab or the exact pane of a related\s+worker/);
  assert.match(skill, /local execution inputs, not goal context/);
});

test("the bundled goal-management skill gives portfolio reviews bounded context", async () => {
  const skill = await readFile(skillPath, "utf8");

  assert.match(skill, /\.supervisor\/global-review\.json/);
  assert.match(skill, /timestamped advisory/);
  assert.match(skill, /finding, not goal authority/);
  assert.match(skill, /outcome,/);
  assert.match(skill, /current state, latest material change, blocker if any, and next action/);
});

test("the bundled goal-management skill keeps goal contracts concise", async () => {
  const skill = await readFile(skillPath, "utf8");

  assert.match(skill, /Write the smallest complete contract/);
  assert.match(skill, /One-time adoption, migration, backlog transfer, or evidence reconciliation/);
  assert.match(skill, /stable reference and integrity/);
  assert.match(skill, /proof instead of copying or replaying it/);
});

test("the bundled skill metadata provides an explicit example invocation", async () => {
  const metadata = await readFile(skillMetadataPath, "utf8");

  assert.match(metadata, /default_prompt: .*\$herdr-goals/);
});
