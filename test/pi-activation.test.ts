import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  return { root, goals, invoke };
}

async function supervisorSessionHandler(goals: string, { restored = false } = {}) {
  const previousGoals = process.env.HERDR_SUPERVISOR_GOALS;
  const previousRestored = process.env.HERDR_SUPERVISOR_RESTORED;
  process.env.HERDR_SUPERVISOR_GOALS = goals;
  if (restored) process.env.HERDR_SUPERVISOR_RESTORED = "1";
  else delete process.env.HERDR_SUPERVISOR_RESTORED;
  try {
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
    const { default: explicitSupervisor } = await import(`${pathToFileURL(activeExtension).href}?marker=${Date.now()}-${Math.random()}`);
    explicitSupervisor(pi);
    assert.ok(handlers.length >= 1);
    return handlers[0];
  } finally {
    if (previousGoals === undefined) delete process.env.HERDR_SUPERVISOR_GOALS;
    else process.env.HERDR_SUPERVISOR_GOALS = previousGoals;
    if (previousRestored === undefined) delete process.env.HERDR_SUPERVISOR_RESTORED;
    else process.env.HERDR_SUPERVISOR_RESTORED = previousRestored;
  }
}

async function emitSupervisorSession(
  handler,
  paneId: string,
  sessionFile: string,
  sessionId = "session-id",
  reason = "startup",
) {
  await writeFile(sessionFile, `${JSON.stringify({
    type: "session",
    version: 3,
    id: sessionId,
    timestamp: new Date().toISOString(),
    cwd: dirname(sessionFile),
  })}\n`);
  const previousPane = process.env.HERDR_PANE_ID;
  process.env.HERDR_PANE_ID = paneId;
  try {
    await handler({ reason }, {
      sessionManager: {
        getSessionFile: () => sessionFile,
        getSessionId: () => sessionId,
      },
    });
  } finally {
    if (previousPane === undefined) delete process.env.HERDR_PANE_ID;
    else process.env.HERDR_PANE_ID = previousPane;
  }
}

async function recordSupervisorSession(goals: string, paneId: string, sessionFile: string, sessionId = "session-id") {
  const handler = await supervisorSessionHandler(goals);
  await emitSupervisorSession(handler, paneId, sessionFile, sessionId);
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
  const savedSession = join(state.root, "saved.jsonl");
  const explicit = await state.invoke("w1:p2", ["--session", "saved.jsonl", "-e", containerActiveExtension, "--model", "test"]);
  assert.equal(explicit.stdout, `--session\nsaved.jsonl\n-e\n${containerActiveExtension}\n--model\ntest\n`);
  await assert.rejects(
    readFile(join(state.goals, ".supervisor", "pane-id")),
    { code: "ENOENT" },
  );

  await recordSupervisorSession(state.goals, "w1:p2", savedSession);
  assert.equal(await readFile(join(state.goals, ".supervisor", "pane-id"), "utf8"), `w1:p2\n${savedSession}\nsession-id\n`);
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
  const initialSession = join(state.root, "initial.jsonl");
  await recordSupervisorSession(state.goals, "w1:p2", initialSession, "initial-session");
  assert.equal(await readFile(join(state.goals, ".supervisor", "pane-id"), "utf8"), `w1:p2\n${initialSession}\ninitial-session\n`);
});

test("an explicit move transfers restart ownership to the new supervisor pane", async (t) => {
  const state = await wrapperFixture(t);
  const oldSession = join(state.root, "old.jsonl");
  const newSession = join(state.root, "new.jsonl");
  await state.invoke("w1:p2", ["--session", "old.jsonl", "-e", containerActiveExtension]);
  await recordSupervisorSession(state.goals, "w1:p2", oldSession, "old-session");
  await state.invoke("w1:p9", ["--session", "new.jsonl", "-e", containerActiveExtension]);
  await recordSupervisorSession(state.goals, "w1:p9", newSession, "new-session");
  assert.equal(await readFile(join(state.goals, ".supervisor", "pane-id"), "utf8"), `w1:p9\n${newSession}\nnew-session\n`);
  assert.equal((await state.invoke("w1:p2", ["--session", "old.jsonl"])).stdout, "--session\nold.jsonl\n");
  assert.equal((await state.invoke("w1:p9", ["--session", "new.jsonl"])).stdout, `-e\n${containerActiveExtension}\n--session\nnew.jsonl\n`);
});

test("a former supervisor cannot reclaim ownership after an explicit transfer", async (t) => {
  const state = await wrapperFixture(t);
  const oldHandler = await supervisorSessionHandler(state.goals);
  const newHandler = await supervisorSessionHandler(state.goals);
  const oldSession = join(state.root, "old.jsonl");
  const newSession = join(state.root, "new.jsonl");
  const laterOldSession = join(state.root, "later-old.jsonl");

  await emitSupervisorSession(oldHandler, "w1:p2", oldSession, "old-session");
  await emitSupervisorSession(newHandler, "w1:p9", newSession, "new-session");
  const recreatedOldHandler = await supervisorSessionHandler(state.goals);
  await emitSupervisorSession(recreatedOldHandler, "w1:p2", laterOldSession, "later-old-session", "resume");

  assert.equal(
    await readFile(join(state.goals, ".supervisor", "pane-id"), "utf8"),
    `w1:p9\n${newSession}\nnew-session\n`,
  );
});

test("a delayed restored supervisor cannot overwrite a newer explicit owner", async (t) => {
  const state = await wrapperFixture(t);
  const restoredHandler = await supervisorSessionHandler(state.goals, { restored: true });
  const explicitHandler = await supervisorSessionHandler(state.goals);
  const oldSession = join(state.root, "old.jsonl");
  const newSession = join(state.root, "new.jsonl");

  await recordSupervisorSession(state.goals, "w1:p2", oldSession, "old-session");
  await emitSupervisorSession(explicitHandler, "w1:p9", newSession, "new-session");
  await emitSupervisorSession(restoredHandler, "w1:p2", oldSession, "old-session");

  assert.equal(
    await readFile(join(state.goals, ".supervisor", "pane-id"), "utf8"),
    `w1:p9\n${newSession}\nnew-session\n`,
  );
});

test("an unsuccessful initial marker update remains retryable", async (t) => {
  const state = await wrapperFixture(t);
  const handler = await supervisorSessionHandler(state.goals);
  await emitSupervisorSession(handler, "w1:p2", join(state.root, "invalid.jsonl"), "");
  await emitSupervisorSession(handler, "w1:p2", join(state.root, "valid.jsonl"), "valid-session", "reload");

  assert.equal(
    await readFile(join(state.goals, ".supervisor", "pane-id"), "utf8"),
    `w1:p2\n${join(state.root, "valid.jsonl")}\nvalid-session\n`,
  );
});

test("wrapper recognizes extension options anywhere before the option boundary", async (t) => {
  const optionState = await wrapperFixture(t);
  await recordSupervisorSession(optionState.goals, "w1:p2", join(optionState.root, "saved.jsonl"));
  const afterOptionValue = await optionState.invoke("w1:p2", ["--model", "test", "--session", "saved.jsonl", "-e", containerActiveExtension]);
  assert.equal(afterOptionValue.stdout, `--model\ntest\n--session\nsaved.jsonl\n-e\n${containerActiveExtension}\n`);

  const optionalFlagState = await wrapperFixture(t);
  await recordSupervisorSession(optionalFlagState.goals, "w1:p2", join(optionalFlagState.root, "print.jsonl"));
  const afterOptionalFlag = await optionalFlagState.invoke("w1:p2", ["--print", "-e", containerActiveExtension, "--session", "print.jsonl"]);
  assert.equal(afterOptionalFlag.stdout, `--print\n-e\n${containerActiveExtension}\n--session\nprint.jsonl\n`);

  const promptArgumentState = await wrapperFixture(t);
  await recordSupervisorSession(promptArgumentState.goals, "w1:p2", join(promptArgumentState.root, "prompt.jsonl"));
  const promptArgument = await promptArgumentState.invoke("w1:p2", ["review", "-e", containerActiveExtension, "--session", "prompt.jsonl"]);
  assert.equal(promptArgument.stdout, `review\n-e\n${containerActiveExtension}\n--session\nprompt.jsonl\n`);

  const separatorState = await wrapperFixture(t);
  await recordSupervisorSession(separatorState.goals, "w1:p2", join(separatorState.root, "separator.jsonl"));
  const afterSeparator = await separatorState.invoke("w1:p2", ["--session", "separator.jsonl", "--", "-e", containerActiveExtension]);
  assert.equal(afterSeparator.stdout, `-e\n${containerActiveExtension}\n--session\nseparator.jsonl\n--\n-e\n${containerActiveExtension}\n`);

  const consumedOptionState = await wrapperFixture(t);
  await recordSupervisorSession(consumedOptionState.goals, "w1:p2", join(consumedOptionState.root, "model.jsonl"));
  const consumedOptionValue = await consumedOptionState.invoke("w1:p2", ["--model", "-e", containerActiveExtension, "--session", "model.jsonl"]);
  assert.equal(consumedOptionValue.stdout, `-e\n${containerActiveExtension}\n--model\n-e\n${containerActiveExtension}\n--session\nmodel.jsonl\n`);

  const equalsState = await wrapperFixture(t);
  await recordSupervisorSession(equalsState.goals, "w1:p2", join(equalsState.root, "equals.jsonl"));
  const equalsForm = await equalsState.invoke("w1:p2", ["--session", "equals.jsonl", `--extension=${containerActiveExtension}`]);
  assert.equal(equalsForm.stdout, `-e\n${containerActiveExtension}\n--session\nequals.jsonl\n--extension=${containerActiveExtension}\n`);

  const optionValueState = await wrapperFixture(t);
  await recordSupervisorSession(optionValueState.goals, "w1:p2", join(optionValueState.root, "value.jsonl"));
  const optionValue = await optionValueState.invoke("w1:p2", ["--system-prompt", "-e", containerActiveExtension, "--session", "value.jsonl"]);
  assert.equal(optionValue.stdout, `-e\n${containerActiveExtension}\n--system-prompt\n-e\n${containerActiveExtension}\n--session\nvalue.jsonl\n`);
});

test("wrapper restores only canonical session marker matches", async (t) => {
  const state = await wrapperFixture(t);
  await recordSupervisorSession(state.goals, "w1:p2", join(state.root, "exact.jsonl"), "exact-session");

  const exactPath = await state.invoke("w1:p2", ["--session", "exact.jsonl"]);
  assert.equal(exactPath.stdout, `-e\n${containerActiveExtension}\n--session\nexact.jsonl\n`);

  const exactId = await state.invoke("w1:p2", ["--session-id", "exact-session"]);
  assert.equal(exactId.stdout, `-e\n${containerActiveExtension}\n--session-id\nexact-session\n`);

  const partialId = await state.invoke("w1:p2", ["--session", "exact"]);
  assert.equal(partialId.stdout, "--session\nexact\n");

  const noSession = await state.invoke("w1:p2", ["--no-session", "--session", "exact.jsonl"]);
  assert.equal(noSession.stdout, "--no-session\n--session\nexact.jsonl\n");

  const metadataOnly = await state.invoke("w1:p2", ["--help", "--session", "exact.jsonl"]);
  assert.equal(metadataOnly.stdout, "--help\n--session\nexact.jsonl\n");

  const conflictingIdentity = await state.invoke("w1:p2", ["--session", "exact.jsonl", "--session-id", "exact-session"]);
  assert.equal(conflictingIdentity.stdout, "--session\nexact.jsonl\n--session-id\nexact-session\n");

  await writeFile(join(state.root, "exact.jsonl"), `${JSON.stringify({ type: "session", version: 3, id: "replacement" })}\n`);
  const replacedFile = await state.invoke("w1:p2", ["--session", "exact.jsonl"]);
  assert.equal(replacedFile.stdout, "--session\nexact.jsonl\n");
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
