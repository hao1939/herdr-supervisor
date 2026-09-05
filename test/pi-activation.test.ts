import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
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
