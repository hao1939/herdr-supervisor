import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

const run = promisify(execFile);
const entrypoint = fileURLToPath(new URL("../container/container-entrypoint.sh", import.meta.url));
const directExtension = fileURLToPath(new URL("../src/extension.ts", import.meta.url));
const activeExtension = fileURLToPath(new URL("../container/supervisor-extension.ts", import.meta.url));
const legacyExtension = fileURLToPath(new URL("../container/pi-extension.ts", import.meta.url));
const managedTarget = "/opt/herdr-supervisor/container/pi-extension.ts";
const piWrapper = fileURLToPath(new URL("../container/bin/pi", import.meta.url));
const containerActiveExtension = "/opt/herdr-supervisor/container/supervisor-extension.ts";
const supervisorInstall = fileURLToPath(new URL("..", import.meta.url));

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "herdr-pi-activation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "pi");
  const discoveryDir = join(agentDir, "extensions");
  await mkdir(discoveryDir, { recursive: true });
  return {
    root,
    agentDir,
    discoveryDir,
    legacyLink: join(discoveryDir, "herdr-supervisor.ts"),
    start: () => run(entrypoint, ["true"], {
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        CODEX_HOME: join(root, "codex"),
        HERDR_WATCH_GITHUB_REPOSITORIES: "",
        HERDR_WATCH_ADO_DEFINITIONS: "",
        HERDR_WATCH_ADO_REPOSITORIES: "",
      },
    }),
  };
}

async function loadPi(root: string, agentDir: string, additionalExtensionPaths: string[] = []) {
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager: SettingsManager.inMemory(),
    additionalExtensionPaths,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  return loader.getExtensions();
}

async function wrapperFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "herdr-pi-wrapper-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agent = join(root, "pi-agent");
  const wrapper = join(root, "pi");
  await writeFile(agent, [
    "#!/bin/sh",
    "if [ -n \"${REPORT_UMASK:-}\" ]; then umask; exit; fi",
    "printf '%s\\n' \"$@\"",
    "",
  ].join("\n"), { mode: 0o700 });
  await writeFile(
    wrapper,
    (await readFile(piWrapper, "utf8")).replace("/usr/local/bin/pi-agent", agent),
  );
  await chmod(wrapper, 0o700);
  const goals = join(root, "goals");
  const invoke = (paneId: string, args: string[] = [], env = {}) => run(wrapper, args, {
    env: {
      ...process.env,
      HERDR_PANE_ID: paneId,
      HERDR_SUPERVISOR_DIRECTORY: root,
      HERDR_SUPERVISOR_INSTALL: supervisorInstall,
      HERDR_SUPERVISOR_GOALS: goals,
      ...env,
    },
  });
  return { goals, invoke };
}

test("ordinary Pi loads no supervisor; explicit Pi extension loading installs the single path", async (t) => {
  const fixtureState = await fixture(t);
  await fixtureState.start();
  await assert.rejects(lstat(fixtureState.legacyLink), { code: "ENOENT" });

  const ordinary = await loadPi(fixtureState.root, fixtureState.agentDir);
  assert.deepEqual(ordinary.errors, []);
  assert.equal(ordinary.extensions.length, 0);

  const oldDirectLoad = await loadPi(fixtureState.root, fixtureState.agentDir, [directExtension]);
  assert.equal(oldDirectLoad.extensions.length, 0);
  assert.equal(oldDirectLoad.errors.length, 1);
  assert.match(oldDirectLoad.errors[0].error, /Direct supervisor loading was removed/);
  assert.match(oldDirectLoad.errors[0].error, /Source checkout: pi -e \/path\/to\/herdr-supervisor\/container\/supervisor-extension\.ts/);
  assert.match(oldDirectLoad.errors[0].error, /\/opt\/herdr-supervisor\/container\/supervisor-extension\.ts/);

  // additionalExtensionPaths is the same resource-loader input used by Pi's -e.
  const dedicated = await loadPi(fixtureState.root, fixtureState.agentDir, [activeExtension]);
  assert.deepEqual(dedicated.errors, []);
  assert.equal(dedicated.extensions.length, 1);
  const supervisor = dedicated.extensions[0];
  assert.ok(supervisor.tools.has("supervisor_start_goal"));
  assert.ok(supervisor.tools.has("supervisor_steer"));
  assert.equal(supervisor.flags.has("supervisor-mode"), false);
  assert.ok(supervisor.handlers.has("session_start"));
});

test("an explicitly chosen supervisor pane keeps its role across native Pi resume", async (t) => {
  const state = await wrapperFixture(t);
  const explicit = await state.invoke("w1:p2", ["--session", "saved.jsonl", "-e", containerActiveExtension, "--model", "test"]);
  assert.equal(explicit.stdout, `--session\nsaved.jsonl\n-e\n${containerActiveExtension}\n--model\ntest\n`);
  assert.equal(await readFile(join(state.goals, ".supervisor", "pane-id"), "utf8"), "w1:p2\nsaved.jsonl\n");
  assert.equal((await stat(join(state.goals, ".supervisor", "pane-id"))).mode & 0o777, 0o600);

  const resumed = await state.invoke("w1:p2", ["--session", "saved.jsonl"]);
  assert.equal(resumed.stdout, `-e\n${containerActiveExtension}\n--session\nsaved.jsonl\n`);

  const recycled = await state.invoke("w1:p2", ["--session", "replacement.jsonl"]);
  assert.equal(recycled.stdout, "--session\nreplacement.jsonl\n");

  const ordinary = await state.invoke("w1:p3", ["--session", "other.jsonl"]);
  assert.equal(ordinary.stdout, "--session\nother.jsonl\n");
});

test("the explicit supervisor entry records the native Pi session once it exists", async (t) => {
  const state = await wrapperFixture(t);
  const previousPane = process.env.HERDR_PANE_ID;
  const previousGoals = process.env.HERDR_SUPERVISOR_GOALS;
  process.env.HERDR_PANE_ID = "w1:p2";
  process.env.HERDR_SUPERVISOR_GOALS = state.goals;
  t.after(() => {
    if (previousPane === undefined) delete process.env.HERDR_PANE_ID;
    else process.env.HERDR_PANE_ID = previousPane;
    if (previousGoals === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousGoals;
  });

  const handlers = [];
  const pi = new Proxy({
    getActiveTools: () => [],
    getFlag: () => undefined,
    on(event, handler) {
      if (event === "session_start") handlers.push(handler);
    },
  }, {
    get(target, property) {
      if (property in target) return target[property];
      return () => undefined;
    },
  });
  const { default: explicitSupervisor } = await import(`${pathToFileURL(activeExtension).href}?marker=${Date.now()}`);
  explicitSupervisor(pi);

  await handlers[0]({}, {
    sessionManager: {
      getSessionFile: () => "initial.jsonl",
    },
  });
  assert.equal(await readFile(join(state.goals, ".supervisor", "pane-id"), "utf8"), "w1:p2\ninitial.jsonl\n");
});

test("an explicit move transfers restart ownership to the new supervisor pane", async (t) => {
  const state = await wrapperFixture(t);
  await state.invoke("w1:p2", ["--session", "old.jsonl", "-e", containerActiveExtension]);
  await state.invoke("w1:p9", ["--session", "new.jsonl", "-e", containerActiveExtension]);
  assert.equal(await readFile(join(state.goals, ".supervisor", "pane-id"), "utf8"), "w1:p9\nnew.jsonl\n");
  assert.equal((await state.invoke("w1:p2", ["--session", "old.jsonl"])).stdout, "--session\nold.jsonl\n");
  assert.equal((await state.invoke("w1:p9", ["--session", "new.jsonl"])).stdout, `-e\n${containerActiveExtension}\n--session\nnew.jsonl\n`);
});

test("wrapper recognizes extension options anywhere before the option boundary", async (t) => {
  const optionState = await wrapperFixture(t);
  const afterOptionValue = await optionState.invoke("w1:p2", ["--model", "test", "--session", "saved.jsonl", "-e", containerActiveExtension]);
  assert.equal(afterOptionValue.stdout, `--model\ntest\n--session\nsaved.jsonl\n-e\n${containerActiveExtension}\n`);
  assert.equal(
    await readFile(join(optionState.goals, ".supervisor", "pane-id"), "utf8"),
    "w1:p2\nsaved.jsonl\n",
  );

  const optionalFlagState = await wrapperFixture(t);
  const afterOptionalFlag = await optionalFlagState.invoke("w1:p2", ["--print", "-e", containerActiveExtension, "--session", "print.jsonl"]);
  assert.equal(afterOptionalFlag.stdout, `--print\n-e\n${containerActiveExtension}\n--session\nprint.jsonl\n`);
  assert.equal(
    await readFile(join(optionalFlagState.goals, ".supervisor", "pane-id"), "utf8"),
    "w1:p2\nprint.jsonl\n",
  );

  const promptArgumentState = await wrapperFixture(t);
  const promptArgument = await promptArgumentState.invoke("w1:p2", ["review", "-e", containerActiveExtension, "--session", "prompt.jsonl"]);
  assert.equal(promptArgument.stdout, `review\n-e\n${containerActiveExtension}\n--session\nprompt.jsonl\n`);
  assert.equal(
    await readFile(join(promptArgumentState.goals, ".supervisor", "pane-id"), "utf8"),
    "w1:p2\nprompt.jsonl\n",
  );

  const separatorState = await wrapperFixture(t);
  const afterSeparator = await separatorState.invoke("w1:p2", ["--session", "separator.jsonl", "--", "-e", containerActiveExtension]);
  assert.equal(afterSeparator.stdout, `--session\nseparator.jsonl\n--\n-e\n${containerActiveExtension}\n`);
  await assert.rejects(
    readFile(join(separatorState.goals, ".supervisor", "pane-id")),
    { code: "ENOENT" },
  );

  const consumedOptionState = await wrapperFixture(t);
  const consumedOptionValue = await consumedOptionState.invoke("w1:p2", ["--model", "-e", containerActiveExtension, "--session", "model.jsonl"]);
  assert.equal(consumedOptionValue.stdout, `--model\n-e\n${containerActiveExtension}\n--session\nmodel.jsonl\n`);
  await assert.rejects(
    readFile(join(consumedOptionState.goals, ".supervisor", "pane-id")),
    { code: "ENOENT" },
  );
});

test("wrapper restores the caller umask before launching Pi", async (t) => {
  const state = await wrapperFixture(t);
  const ordinary = await state.invoke("w1:p3", [], { REPORT_UMASK: "1" });
  const supervisor = await state.invoke(
    "w1:p2",
    ["-e", containerActiveExtension],
    { REPORT_UMASK: "1" },
  );
  assert.equal(supervisor.stdout, ordinary.stdout);
});

test("a preserved discovery entry to the former direct entry point fails closed", async (t) => {
  const fixtureState = await fixture(t);
  const source = `export { default } from ${JSON.stringify(pathToFileURL(directExtension).href)};\n`;
  await writeFile(fixtureState.legacyLink, source);
  await fixtureState.start();
  assert.equal(await readFile(fixtureState.legacyLink, "utf8"), source);

  const ordinary = await loadPi(fixtureState.root, fixtureState.agentDir);
  assert.equal(ordinary.extensions.length, 0);
  assert.equal(ordinary.errors.length, 1);
  assert.match(ordinary.errors[0].error, /Direct supervisor loading was removed/);
  assert.match(ordinary.errors[0].error, /Source checkout: pi -e \/path\/to\/herdr-supervisor\/container\/supervisor-extension\.ts/);
});

test("container upgrades remove only the known managed supervisor discovery link", async (t) => {
  const fixtureState = await fixture(t);
  await symlink(managedTarget, fixtureState.legacyLink);
  const unrelated = join(fixtureState.discoveryDir, "operator.ts");
  await symlink("/operator/extension.ts", unrelated);

  await fixtureState.start();
  await assert.rejects(lstat(fixtureState.legacyLink), { code: "ENOENT" });
  assert.equal(await readlink(unrelated), "/operator/extension.ts");
  await fixtureState.start();
  await assert.rejects(lstat(fixtureState.legacyLink), { code: "ENOENT" });
});

test("container upgrades preserve operator-owned entries at the old discovery path", async (t) => {
  for (const kind of ["file", "symlink", "directory"]) {
    await t.test(kind, async (t) => {
      const fixtureState = await fixture(t);
      if (kind === "file") await writeFile(fixtureState.legacyLink, "operator-owned content");
      if (kind === "symlink") await symlink("/operator/supervisor.ts", fixtureState.legacyLink);
      if (kind === "directory") await mkdir(fixtureState.legacyLink);

      await fixtureState.start();
      if (kind === "file") assert.equal(await readFile(fixtureState.legacyLink, "utf8"), "operator-owned content");
      if (kind === "symlink") assert.equal(await readlink(fixtureState.legacyLink), "/operator/supervisor.ts");
      if (kind === "directory") assert.ok((await lstat(fixtureState.legacyLink)).isDirectory());
    });
  }
});

test("a stale legacy discovery link fails before any supervisor tools or hooks are installed", async (t) => {
  const fixtureState = await fixture(t);
  await symlink(legacyExtension, fixtureState.legacyLink);

  const ordinary = await loadPi(fixtureState.root, fixtureState.agentDir);
  assert.equal(ordinary.extensions.length, 0);
  assert.equal(ordinary.errors.length, 1);
  assert.match(ordinary.errors[0].error, /auto-loading was removed/);
  assert.match(ordinary.errors[0].error, /pi -e \/opt\/herdr-supervisor\/container\/supervisor-extension\.ts/);
});
