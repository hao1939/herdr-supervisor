import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { once } from "node:events";
import { promisify } from "node:util";
import { adoBuildSource, ambientAdoAuthorization, taggedGoal } from "../src/event-watcher/ado-build.mjs";
import { adoPullRequestSource } from "../src/event-watcher/ado-pr.mjs";
import { ExternalEventWatcher } from "../src/event-watcher/core.mjs";
import { githubPullRequestSource, supervisionGoal } from "../src/event-watcher/github-pr.mjs";
import { herdrGoalDelivery, herdrSupervisorDiagnostic } from "../src/event-watcher/herdr.mjs";
import {
  eventMessageContract,
  supervisorDiagnosticMessage,
  watcherHelpMessage,
  watcherStartupMessage,
  workerEventMessage,
} from "../src/event-watcher/messages.mjs";
import { boundedRefreshWindow } from "../src/event-watcher/refresh-window.mjs";
import { acquireWatcherLock } from "../src/event-watcher/process-lock.mjs";
import { recordDecision, registerSupervisedGoal } from "../src/goal-registry.ts";
import { withGoalActionLock } from "../src/goal-action-lock.mjs";

const execFileAsync = promisify(execFile);

test("bounded windows keep their place when new resources arrive first", () => {
  const next = boundedRefreshWindow(2, (item) => item.id);
  assert.deepEqual(next([{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }]), [
    { id: "a" },
    { id: "b" },
  ]);
  assert.deepEqual(next([
    { id: "new-1" },
    { id: "new-2" },
    { id: "a" },
    { id: "b" },
    { id: "c" },
    { id: "d" },
  ]), [{ id: "c" }, { id: "d" }]);
});

async function temporary(t, label) {
  const directory = await mkdtemp(join(tmpdir(), label));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("one process owns an event watcher checkpoint", async (t) => {
  const root = await temporary(t, "event-watch-process-lock-");
  const lock = join(root, "external-events.json");
  const lockModule = new URL("../src/event-watcher/process-lock.mjs", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", `
    import { acquireWatcherLock } from ${JSON.stringify(lockModule)};
    const release = await acquireWatcherLock(process.argv[1]);
    process.once("SIGTERM", async () => { await release(); process.exit(0); });
    process.stdout.write("ready\\n");
    setInterval(() => {}, 1_000);
  `, lock], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => child.kill("SIGKILL"));
  const [ready] = await once(child.stdout, "data");
  assert.equal(String(ready), "ready\n");

  await assert.rejects(
    acquireWatcherLock(lock),
    /event-watchd checkpoint .* is already owned by another process/,
  );
  child.kill("SIGTERM");
  const [code] = await once(child, "exit");
  assert.equal(code, 0);

  const releaseAgain = await acquireWatcherLock(lock);
  await releaseAgain();
});

test("event watcher ownership recovers after its process is gone", async (t) => {
  const root = await temporary(t, "event-watch-stale-process-lock-");
  const lock = join(root, "external-events.json");
  const staleLock = `${lock}.lock`;
  await mkdir(staleLock, { recursive: true });
  const expired = new Date(Date.now() - 60_000);
  await utimes(staleLock, expired, expired);

  const release = await acquireWatcherLock(lock);
  await release();
});

test("watcher shutdown interrupts provider I/O and releases checkpoint ownership", async (t) => {
  const root = await temporary(t, "event-watch-shutdown-");
  const statePath = join(root, "external-events.json");
  const daemonModule = new URL("../src/event-watcher/daemon.mjs", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", `
    globalThis.fetch = async (_url, { signal }) => {
      process.stdout.write("scanning\\n");
      await new Promise((resolve, reject) => {
        const keepAlive = setInterval(() => {}, 1_000);
        signal.addEventListener("abort", () => {
          clearInterval(keepAlive);
          reject(signal.reason);
        }, { once: true });
      });
    };
    await import(${JSON.stringify(daemonModule)});
  `], {
    env: {
      ...process.env,
      GITHUB_TOKEN: "token",
      HERDR_WATCH_GITHUB_REPOSITORIES: "owner/repo",
      HERDR_WATCH_STATE_HOME: root,
      HERDR_WATCH_INTERVAL_MS: "60000",
      HERDR_WATCH_ADO_DEFINITIONS: "",
      HERDR_WATCH_ADO_REPOSITORIES: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGKILL"));
  const [started] = await once(child.stdout, "data");
  assert.equal(String(started), "scanning\n");

  child.kill("SIGTERM");
  const [code, signal] = await once(child, "exit");
  assert.equal(code, 0);
  assert.equal(signal, null);

  const release = await acquireWatcherLock(statePath);
  await release();
});

test("goal action locks recover after their owning process is gone", async (t) => {
  const root = await temporary(t, "event-watch-stale-action-");
  const lock = join(root, ".action-locks", "g_stale");
  await mkdir(lock, { recursive: true });
  await writeFile(join(lock, "owner.json"), `${JSON.stringify({
    token: "dead-owner",
    pid: 2_147_483_647,
    startTime: "missing",
  })}\n`);
  let ran = false;
  await withGoalActionLock(root, "g_stale", async () => { ran = true; });
  assert.equal(ran, true);
});

test("provider metadata names one durable goal without a watch registration", () => {
  assert.equal(supervisionGoal([
    "Useful pull request explanation.",
    "",
    "## Supervision",
    "- Goal: Improve the watcher.",
    "- Goal ID: \"g_exact-1\"",
    "- Pane: \"w1:p7\"",
  ].join("\n")), "g_exact-1");
  assert.equal(supervisionGoal("## Supervision\n- Goal ID: g_one\n- Goal ID: g_two"), undefined);
  assert.equal(supervisionGoal([
    "## Supervision",
    "- Goal ID: g_one",
    "",
    "## Other",
    "",
    "## Supervision",
    "- Goal ID: g_two",
  ].join("\n")), undefined);
  assert.equal(supervisionGoal([
    "## Supervision",
    "- Goal ID: g_one",
    "",
    "## Supervision",
    "- Goal ID: \"g_two",
  ].join("\n")), undefined);
  assert.equal(supervisionGoal("## Supervision\n- Goal ID: \"g_one"), undefined);
  assert.equal(supervisionGoal("## Supervision\n- Goal ID: g_one\""), undefined);
  assert.equal(supervisionGoal("No metadata"), undefined);
  assert.equal(supervisionGoal([
    "## Supervision",
    "- Goal: Improve the watcher.",
    "",
    "# Unrelated later section",
    "- Goal ID: \"g_other-1\"",
  ].join("\n")), undefined);
  assert.equal(taggedGoal(["unrelated", "herdr-goal=g_exact-1"]), "g_exact-1");
  assert.equal(taggedGoal(["herdr-goal=g_one", "herdr-goal=g_two"]), undefined);
});

test("watcher startup explains its complete observation and delivery path", () => {
  const message = watcherStartupMessage({
    scopes: {
      "github-pr": ["owner/repo"],
      "ado-pr": [],
      "ado-build": ["org/project/42"],
    },
    intervalMs: 60_000,
    statePath: "/state/external-events.json",
  });

  assert.match(message, /event-watchd started/);
  assert.match(message, /github-pr: owner\/repo/);
  assert.match(message, /ado-build: org\/project\/42/);
  assert.doesNotMatch(message, /ado-pr:/);
  assert.match(message, /Stale notification: disabled/);
  assert.match(message, /linked resource -> durable goal ID -> exact current worker/);
  assert.match(message, /bounded diagnostic -> one Pi supervisor/);
  assert.match(message, /startup only; verify provider access, metadata, and one changed-resource delivery/);

  assert.match(watcherStartupMessage({
    scopes: { "github-pr": ["owner/repo"] },
    intervalMs: 60_000,
    staleAfterMs: 86_400_000,
    statePath: "/state/external-events.json",
  }), /Stale notification: after 1 day unchanged/);
});

test("watcher help explains setup, linking, and end-to-end proof", () => {
  const message = watcherHelpMessage();

  assert.match(message, /HERDR_WATCH_GITHUB_REPOSITORIES=owner\/repository/);
  assert.match(message, /HERDR_WATCH_ADO_REPOSITORIES=organization\/project\/repository/);
  assert.match(message, /HERDR_WATCH_ADO_CREATOR_ID=identity-uuid/);
  assert.match(message, /HERDR_WATCH_ADO_DEFINITIONS=organization\/project\/definition-id/);
  assert.match(message, /HERDR_WATCH_STALE_AFTER_MS=milliseconds/);
  assert.match(message, /Goal ID: <durable-goal-id>/);
  assert.match(message, /herdr-goal=<durable-goal-id>/);
  assert.match(message, /Verify provider access, exact metadata/);
});

test("worker event message explains facts, delivery, response, and expected output", () => {
  const message = workerEventMessage("g_owner", [{
    source: "github-pr",
    subject: "owner/repo#42",
    observedAt: "2026-09-03T00:00:00.000Z",
    revision: "revision-1",
    payload: { draft: false, checks: [{ name: "test", conclusion: "failure" }] },
  }]);

  assert.equal(eventMessageContract, "event-watchd/v1");
  assert.match(message, /^\[event-watchd\/v1\]\nEvent: linked-resource-change\nRecipient role: goal-worker/);
  assert.match(message, /Event facts\n  Goal ID: g_owner\n  Resource count: 1/);
  assert.match(message, /Resource 1\n    Source: github-pr\n    Subject: owner\/repo#42/);
  assert.match(message, /Why you received this: trusted provider metadata links the resource/);
  assert.match(message, /Observed at: 2026-09-03T00:00:00.000Z/);
  assert.match(message, /Revision: revision-1/);
  assert.match(message, /"conclusion": "failure"/);
  assert.match(message, /rereading the provider's current state/);
  assert.match(message, /Report what materially changed, what you did/);
});

test("stale resource message explains elapsed time and keeps the decision with the worker", () => {
  const message = workerEventMessage("g_owner", [{
    event: "stale",
    source: "ado-pr",
    subject: "org/project/repo/42",
    observedAt: "2026-09-04T00:00:00.000Z",
    unchangedSince: "2026-09-03T00:00:00.000Z",
    staleForMs: 86_400_000,
    staleAfterMs: 86_400_000,
    revision: "revision-1",
    payload: { draft: true, mergeStatus: "conflicts" },
  }]);

  assert.match(message, /^\[event-watchd\/v1\]\nEvent: linked-resource-stale\nRecipient role: goal-worker/);
  assert.match(message, /Unchanged since: 2026-09-03T00:00:00.000Z/);
  assert.match(message, /Unchanged for: 1 day/);
  assert.match(message, /Stale threshold: 1 day/);
  assert.match(message, /Why you received this: trusted provider metadata links these resources/);
  assert.match(message, /Check for review feedback, conflicts, failed or missing checks/);
  assert.match(message, /keep independent work moving/);
});

test("event watcher guide catalogs every agent event and its response knowledge", async () => {
  const guide = await readFile(new URL("../src/event-watcher/README.md", import.meta.url), "utf8");

  assert.match(guide, /`linked-resource-change`[^\n]+`knowledge\/linked-resource-change\.md`/);
  assert.match(guide, /`linked-resource-stale`[^\n]+`knowledge\/linked-resource-stale\.md`/);
  assert.match(guide, /`watcher-diagnostic`[^\n]+`knowledge\/watcher-diagnostic\.md`/);
});

test("supervisor diagnostic uses the same versioned fact-and-knowledge contract", () => {
  const message = supervisorDiagnosticMessage({
    kind: "source",
    source: "ado-build",
    affectedGoalIds: ["g_release"],
    observedAt: "2026-09-03T00:00:00.000Z",
    message: "ADO discovery failed",
    retry: "Retry on the next bounded scan.",
  });

  assert.match(message, /^\[event-watchd\/v1\]\nEvent: watcher-diagnostic\nRecipient role: supervisor/);
  assert.match(message, /Event facts\n  Diagnostic kind: source/);
  assert.match(message, /Affected Goal IDs: g_release/);
  assert.match(message, /Observed at: 2026-09-03T00:00:00.000Z/);
  assert.match(message, /Agent response knowledge\n  # External watcher diagnostic/);
  assert.match(message, /Inspect the current watcher, provider, and\s+affected existing/);
});

test("watcher daemon rejects an empty source set without changing its checkpoint", async (t) => {
  const directory = await temporary(t, "event-watch-empty-sources-");
  const statePath = join(directory, "external-events.json");
  const checkpoint = `${JSON.stringify({
    version: 1,
    resources: {
      "source\0subject": {
        source: "source",
        subject: "subject",
        goalId: "g_preserved",
        revision: "one",
        observedAt: "2026-09-01T00:00:00Z",
      },
    },
  }, null, 2)}\n`;
  await writeFile(statePath, checkpoint);
  const environment: NodeJS.ProcessEnv = { ...process.env, HERDR_WATCH_STATE_HOME: directory };
  delete environment.HERDR_WATCH_GITHUB_REPOSITORIES;
  delete environment.HERDR_WATCH_ADO_DEFINITIONS;
  delete environment.HERDR_WATCH_ADO_REPOSITORIES;

  await assert.rejects(
    execFileAsync(process.execPath, ["src/event-watcher/daemon.mjs"], { env: environment }),
    /no trusted provider scope configured[\s\S]*HERDR_WATCH_GITHUB_REPOSITORIES=owner\/repository/,
  );
  assert.equal(await readFile(statePath, "utf8"), checkpoint);
});

test("watcher daemon rejects intervals above the Node timer limit", async () => {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    GITHUB_TOKEN: "test-token",
    HERDR_WATCH_GITHUB_REPOSITORIES: "owner/repo",
    HERDR_WATCH_INTERVAL_MS: "2147483648",
  };
  delete environment.HERDR_WATCH_ADO_DEFINITIONS;
  delete environment.HERDR_WATCH_ADO_REPOSITORIES;

  await assert.rejects(
    execFileAsync(process.execPath, ["src/event-watcher/daemon.mjs"], { env: environment }),
    /HERDR_WATCH_INTERVAL_MS must be between 10000 and 2147483647/,
  );
});

test("watcher daemon rejects an invalid stale threshold", async () => {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    GITHUB_TOKEN: "test-token",
    HERDR_WATCH_GITHUB_REPOSITORIES: "owner/repo",
    HERDR_WATCH_STALE_AFTER_MS: "often",
  };
  delete environment.HERDR_WATCH_ADO_DEFINITIONS;
  delete environment.HERDR_WATCH_ADO_REPOSITORIES;

  await assert.rejects(
    execFileAsync(process.execPath, ["src/event-watcher/daemon.mjs"], { env: environment }),
    /HERDR_WATCH_STALE_AFTER_MS must be a non-negative integer/,
  );
});

test("first discovery and every later revision wake the goal without renewal", async (t) => {
  const directory = await temporary(t, "event-watch-discovery-");
  let revision = "one";
  const delivered = [];
  const watcher = new ExternalEventWatcher({
    statePath: join(directory, "state.json"),
    sources: {
      source: { scan: async () => discovery([{ subject: "resource-1", goalId: "g_owner", revision, payload: { revision } }]) },
    },
    deliver: async (goalId, events) => delivered.push({ goalId, events }),
  });

  await watcher.runOnce();
  await watcher.runOnce();
  revision = "two";
  await watcher.runOnce();

  assert.deepEqual(delivered.map((item) => [item.goalId, item.events[0].revision]), [
    ["g_owner", "one"],
    ["g_owner", "two"],
  ]);
  const state = JSON.parse(await readFile(join(directory, "state.json"), "utf8"));
  assert.equal(Object.keys(state.resources).length, 1);
  assert.equal((Object.values(state.resources)[0] as any).revision, "two");
  assert.equal((Object.values(state.resources)[0] as any).pending, undefined);
});

test("unchanged resources produce one durable stale notification batched by goal", async (t) => {
  const directory = await temporary(t, "event-watch-stale-resource-");
  let now = new Date("2026-09-03T00:00:00.000Z");
  let firstRevision = "one";
  const delivered = [];
  const watcher = new ExternalEventWatcher({
    statePath: join(directory, "state.json"),
    sources: {
      source: { scan: async () => discovery([
        { subject: "resource-1", goalId: "g_owner", revision: firstRevision, payload: { id: 1 } },
        { subject: "resource-2", goalId: "g_owner", revision: "one", payload: { id: 2 } },
      ]) },
    },
    deliver: async (goalId, events) => delivered.push({ goalId, events }),
    now: () => now,
    staleAfterMs: 60_000,
  });

  await watcher.runOnce();
  now = new Date("2026-09-03T00:00:59.999Z");
  await watcher.runOnce();
  now = new Date("2026-09-03T00:01:00.000Z");
  await watcher.runOnce();
  await watcher.runOnce();

  assert.equal(delivered.length, 2);
  assert.deepEqual(delivered.map((item) => [
    item.goalId,
    item.events[0].event,
    item.events.map((event) => event.subject),
  ]), [
    ["g_owner", "change", ["resource-1", "resource-2"]],
    ["g_owner", "stale", ["resource-1", "resource-2"]],
  ]);
  assert.ok(delivered[1].events.every((event) =>
    event.unchangedSince === "2026-09-03T00:00:00.000Z"
      && event.staleForMs === 60_000
      && event.staleAfterMs === 60_000));

  firstRevision = "two";
  await watcher.runOnce();
  now = new Date("2026-09-03T00:02:00.000Z");
  await watcher.runOnce();

  assert.deepEqual(delivered.slice(2).map((item) => [item.events[0].event, item.events[0].subject]), [
    ["change", "resource-1"],
    ["stale", "resource-1"],
  ]);
  const resources = Object.values(JSON.parse(await readFile(join(directory, "state.json"), "utf8")).resources) as any[];
  assert.ok(resources.every((resource) => resource.staleNotified === true));
  assert.ok(resources.every((resource) => resource.pending === undefined));
});

test("a failed stale notification survives restart without becoming a repeated reminder", async (t) => {
  const directory = await temporary(t, "event-watch-stale-restart-");
  const statePath = join(directory, "state.json");
  let now = new Date("2026-09-03T00:00:00.000Z");
  const source = { scan: async () => discovery([
    { subject: "resource", goalId: "g_owner", revision: "one", payload: { state: "waiting" } },
  ]) };
  let attempts = 0;
  const first = new ExternalEventWatcher({
    statePath,
    sources: { source },
    deliver: async (_goalId, events) => {
      attempts += 1;
      if (events[0].event === "stale") throw new Error("worker unavailable");
    },
    diagnose: () => {},
    now: () => now,
    staleAfterMs: 60_000,
  });
  await first.runOnce();
  now = new Date("2026-09-03T00:01:00.000Z");
  await first.runOnce();
  assert.equal(attempts, 2);

  const recovered = [];
  const second = new ExternalEventWatcher({
    statePath,
    sources: { source },
    deliver: async (_goalId, events) => recovered.push(events[0].event),
    now: () => now,
    staleAfterMs: 60_000,
  });
  await second.runOnce();
  await second.runOnce();

  assert.deepEqual(recovered, ["stale"]);
  const resource = Object.values(JSON.parse(await readFile(statePath, "utf8")).resources)[0] as any;
  assert.equal(resource.staleNotified, true);
  assert.equal(resource.pending, undefined);
});

test("provider scans receive the remembered revision and delivery state", async (t) => {
  const directory = await temporary(t, "event-watch-provider-state-");
  const known = [];
  let deliveries = 0;
  const watcher = new ExternalEventWatcher({
    statePath: join(directory, "state.json"),
    sources: {
      source: {
        async scan(resources) {
          known.push(resources);
          return discovery([{
            subject: "resource-1", goalId: "g_owner", revision: "one", payload: {},
          }]);
        },
      },
    },
    deliver: async () => {
      deliveries += 1;
      if (deliveries === 1) throw new Error("worker unavailable");
    },
    diagnose: () => {},
  });

  await watcher.runOnce();
  await watcher.runOnce();
  await watcher.runOnce();

  assert.deepEqual(known, [
    [],
    [{ subject: "resource-1", goalId: "g_owner", revision: "one", pending: true }],
    [{ subject: "resource-1", goalId: "g_owner", revision: "one", pending: false }],
  ]);
});

test("shutdown aborts an in-flight provider scan without reporting a provider failure", async (t) => {
  const directory = await temporary(t, "event-watch-abort-");
  const controller = new AbortController();
  const diagnostics = [];
  let started;
  const scanning = new Promise((resolve) => { started = resolve; });
  const watcher = new ExternalEventWatcher({
    statePath: join(directory, "state.json"),
    sources: {
      source: {
        async scan(_known, { signal }) {
          assert.equal(signal, controller.signal);
          started();
          await new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        },
      },
    },
    deliver: async () => {},
    diagnose: async (diagnostic) => diagnostics.push(diagnostic),
  });

  const running = watcher.runOnce(controller.signal);
  await scanning;
  controller.abort();

  await assert.rejects(running, { name: "AbortError" });
  assert.deepEqual(diagnostics, []);
});

test("completed goal metadata does not consume checkpoint space", async (t) => {
  const directory = await temporary(t, "event-watch-completed-goal-");
  const delivered = [];
  const watcher = new ExternalEventWatcher({
    statePath: join(directory, "state.json"),
    sources: {
      provider: {
        async scan() {
          return {
            observations: [
              { subject: "active", goalId: "g_active", revision: "one", payload: {} },
              { subject: "completed", goalId: "g_completed", revision: "one", payload: {} },
            ],
            absent: [],
          };
        },
      },
    },
    activeGoals: async (...args) => {
      assert.equal(args.length, 0, "metadata must not be passed to canonical goal authority");
      return new Set(["g_active"]);
    },
    deliver: async (goalId) => delivered.push(goalId),
  });

  await watcher.runOnce();

  assert.deepEqual(delivered, ["g_active"]);
  const state = JSON.parse(await readFile(join(directory, "state.json"), "utf8"));
  assert.deepEqual(Object.keys(state.resources), ["provider\0active"]);
});

test("metadata moved to an inactive goal removes its former active-owner checkpoint", async (t) => {
  const directory = await temporary(t, "event-watch-retargeted-goal-");
  const statePath = join(directory, "state.json");
  await writeFile(statePath, `${JSON.stringify({
    version: 1,
    resources: {
      "provider\0resource": {
        source: "provider",
        subject: "resource",
        goalId: "g_active",
        revision: "old",
        observedAt: "2026-09-01T00:00:00.000Z",
      },
    },
  }, null, 2)}\n`);
  const watcher = new ExternalEventWatcher({
    statePath,
    sources: {
      provider: { scan: async () => discovery([
        { subject: "resource", goalId: "g_completed", revision: "new", payload: {} },
      ]) },
    },
    activeGoals: async () => new Set(["g_active"]),
    deliver: async () => assert.fail("inactive metadata must not wake the former owner"),
  });

  await watcher.runOnce();

  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.deepEqual(state.resources, {});
});

test("goal ownership failure preserves the current watcher checkpoint", async (t) => {
  const directory = await temporary(t, "event-watch-goal-authority-");
  const statePath = join(directory, "state.json");
  const original = {
    version: 1,
    resources: {
      "provider\0kept": {
        source: "provider",
        subject: "kept",
        goalId: "g_kept",
        revision: "one",
        observedAt: "2026-09-01T00:00:00.000Z",
      },
    },
  };
  await writeFile(statePath, `${JSON.stringify(original, null, 2)}\n`);
  const diagnostics = [];
  const watcher = new ExternalEventWatcher({
    statePath,
    sources: {
      provider: { async scan() { return { observations: [], absent: [] }; } },
    },
    activeGoals: async () => { throw new Error("goal store unavailable"); },
    deliver: async () => assert.fail("delivery must not run without goal authority"),
    diagnose: async (diagnostic) => diagnostics.push(diagnostic),
  });

  await watcher.runOnce();

  assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), original);
  assert.match(diagnostics[0].message, /could not resolve active goal ownership: goal store unavailable/);
});

test("a failed delivery survives restart and retries from the bounded revision checkpoint", async (t) => {
  const directory = await temporary(t, "event-watch-restart-");
  const statePath = join(directory, "state.json");
  const diagnostics = [];
  const source = { scan: async () => discovery([{ subject: "resource-1", goalId: "g_owner", revision: "one", payload: {} }]) };
  const failing = new ExternalEventWatcher({
    statePath,
    sources: { source },
    deliver: async () => { throw new Error("Herdr unavailable"); },
    diagnose: (item) => diagnostics.push(item),
  });
  await failing.runOnce();
  assert.equal(diagnostics.length, 1);
  assert.ok((Object.values(JSON.parse(await readFile(statePath, "utf8")).resources)[0] as any).pending);

  const delivered = [];
  const recovered = new ExternalEventWatcher({
    statePath,
    sources: { source },
    deliver: async (goalId, events) => delivered.push([goalId, events[0].revision]),
  });
  await recovered.runOnce();
  assert.deepEqual(delivered, [["g_owner", "one"]]);
  assert.equal((Object.values(JSON.parse(await readFile(statePath, "utf8")).resources)[0] as any).pending, undefined);
});

test("an uncertain delivery is diagnosed without automatically sending the event again", async (t) => {
  const directory = await temporary(t, "event-watch-uncertain-delivery-");
  const statePath = join(directory, "state.json");
  const diagnostics = [];
  let deliveries = 0;
  const watcher = new ExternalEventWatcher({
    statePath,
    sources: {
      source: {
        scan: async () => discovery([{
          subject: "resource-1", goalId: "g_owner", revision: "one", payload: {},
        }]),
      },
    },
    deliver: async () => {
      deliveries += 1;
      return { warning: "the transport response was lost" };
    },
    diagnose: async (diagnostic) => diagnostics.push(diagnostic),
  });

  await watcher.runOnce();
  await watcher.runOnce();

  assert.equal(deliveries, 1);
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0].message, /transport response was lost/);
  assert.match(diagnostics[0].retry, /will not be sent again automatically/);
  assert.equal((Object.values(JSON.parse(await readFile(statePath, "utf8")).resources)[0] as any).pending, undefined);
});

test("restart replaces a pending revision with current provider state before waking", async (t) => {
  const directory = await temporary(t, "event-watch-current-revision-");
  const statePath = join(directory, "state.json");
  let revision = "old";
  const source = { scan: async () => discovery([{ subject: "resource-1", goalId: "g_owner", revision, payload: {} }]) };
  const first = new ExternalEventWatcher({
    statePath,
    sources: { source },
    deliver: async () => { throw new Error("Herdr unavailable"); },
    diagnose: () => {},
  });
  await first.runOnce();

  revision = "current";
  const delivered = [];
  const recovered = new ExternalEventWatcher({
    statePath,
    sources: { source },
    deliver: async (_goalId, events) => delivered.push(events[0].revision),
  });
  await recovered.runOnce();

  assert.deepEqual(delivered, ["current"]);
});

test("a pending wake waits for a current read of its exact resource", async (t) => {
  const directory = await temporary(t, "event-watch-current-read-");
  let scan = 0;
  let now = new Date("2026-09-03T00:00:00.000Z");
  const delivered = [];
  const watcher = new ExternalEventWatcher({
    statePath: join(directory, "state.json"),
    sources: { source: { scan: async () => {
      scan += 1;
      if (scan === 1) return discovery([{
        subject: "resource-1", goalId: "g_owner", revision: "old", payload: {},
      }]);
      if (scan === 2) throw new Error("provider unavailable");
      return discovery([{
        subject: "resource-1", goalId: "g_owner", revision: "current", payload: {},
      }]);
    } } },
    deliver: async (_goalId, events) => {
      delivered.push(events[0].revision);
      if (delivered.length === 1) throw new Error("worker unavailable");
    },
    diagnose: () => {},
    now: () => now,
  });

  await watcher.runOnce();
  await watcher.runOnce();
  assert.deepEqual(delivered, ["old"]);

  now = new Date("2026-09-03T00:01:00.000Z");
  await watcher.runOnce();
  assert.deepEqual(delivered, ["old", "current"]);
});

test("authoritative absence forgets a resource without delivering its stale pending revision", async (t) => {
  const directory = await temporary(t, "event-watch-absent-");
  const statePath = join(directory, "state.json");
  let present = true;
  let deliveries = 0;
  const watcher = new ExternalEventWatcher({
    statePath,
    sources: { source: { scan: async () => present
      ? discovery([{ subject: "resource-1", goalId: "g_owner", revision: "old", payload: {} }])
      : discovery([], ["resource-1"]) } },
    deliver: async () => {
      deliveries += 1;
      throw new Error("worker unavailable");
    },
    diagnose: () => {},
  });
  await watcher.runOnce();
  present = false;
  await watcher.runOnce();

  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(deliveries, 1);
  assert.deepEqual(state.resources, {});
});

test("removing a configured provider forgets its checkpoint without stale delivery", async (t) => {
  const directory = await temporary(t, "event-watch-provider-removed-");
  const statePath = join(directory, "state.json");
  let deliveries = 0;
  const initial = new ExternalEventWatcher({
    statePath,
    sources: { removed: { scan: async () => discovery([{
      subject: "resource-1", goalId: "g_owner", revision: "one", payload: {},
    }]) } },
    deliver: async () => {
      deliveries += 1;
      throw new Error("worker unavailable");
    },
    diagnose: () => {},
  });
  await initial.runOnce();

  const cleanup = new ExternalEventWatcher({
    statePath,
    sources: {},
    deliver: async () => { deliveries += 1; },
  });
  await cleanup.runOnce();

  assert.equal(deliveries, 1);
  assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")).resources, {});
});

test("array-shaped checkpoint resources fail instead of losing observations", async (t) => {
  const directory = await temporary(t, "event-watch-invalid-state-");
  const statePath = join(directory, "state.json");
  await writeFile(statePath, '{"version":1,"resources":[]}\n');
  const watcher = new ExternalEventWatcher({
    statePath,
    sources: { source: { scan: async () => discovery() } },
    deliver: async () => {},
  });
  await assert.rejects(watcher.runOnce(), /state is invalid or unsupported/);
});

test("source backoff and delivery diagnostics recover naturally", async (t) => {
  const directory = await temporary(t, "event-watch-diagnostics-");
  let sourceFails = true;
  let deliveryFails = true;
  let now = new Date("2026-09-03T00:00:00.000Z");
  const diagnostics = [];
  const watcher = new ExternalEventWatcher({
    statePath: join(directory, "state.json"),
    sources: {
      source: { scan: async () => {
        if (sourceFails) throw new Error("provider unavailable");
        return discovery([{ subject: "resource-1", goalId: "g_owner", revision: "one", payload: {} }]);
      } },
    },
    deliver: async () => {
      if (deliveryFails) throw new Error("worker unavailable");
    },
    diagnose: (item) => diagnostics.push(item),
    now: () => now,
  });

  await watcher.runOnce();
  await watcher.runOnce();
  sourceFails = false;
  now = new Date("2026-09-03T00:01:00.000Z");
  await watcher.runOnce();
  await watcher.runOnce();
  assert.deepEqual(diagnostics.map((item) => item.kind), ["source", "delivery"]);
  assert.deepEqual(diagnostics.map((item) => item.observedAt), [
    "2026-09-03T00:00:00.000Z",
    "2026-09-03T00:01:00.000Z",
  ]);
  assert.deepEqual(diagnostics[0].affectedGoalIds, []);
  assert.match(diagnostics[0].retry, /no earlier than 2026-09-03T00:01:00.000Z/);
  assert.deepEqual(diagnostics[1].affectedGoalIds, ["g_owner"]);
  assert.match(diagnostics[1].retry, /remains pending/);
  deliveryFails = false;
  await watcher.runOnce();
  sourceFails = true;
  await watcher.runOnce();
  assert.deepEqual(diagnostics.map((item) => item.kind), ["source", "delivery", "source"]);
  assert.deepEqual(diagnostics[2].affectedGoalIds, ["g_owner"]);
});

test("every source shares bounded backoff without delaying healthy sources", async (t) => {
  const directory = await temporary(t, "event-watch-source-backoff-");
  let now = new Date("2026-09-03T00:00:00.000Z");
  let failingScans = 0;
  let healthyScans = 0;
  let sourceFails = true;
  const diagnostics = [];
  const watcher = new ExternalEventWatcher({
    statePath: join(directory, "state.json"),
    sources: {
      failing: { scan: async () => {
        failingScans += 1;
        if (sourceFails) throw new Error("provider unavailable");
        return discovery();
      } },
      healthy: { scan: async () => {
        healthyScans += 1;
        return discovery();
      } },
    },
    deliver: async () => {},
    diagnose: (item) => diagnostics.push(item),
    now: () => now,
  });

  await watcher.runOnce();
  now = new Date("2026-09-03T00:00:30.000Z");
  await watcher.runOnce();
  now = new Date("2026-09-03T00:01:00.000Z");
  await watcher.runOnce();
  for (const stamp of [
    "2026-09-03T00:05:59.000Z",
    "2026-09-03T00:06:00.000Z",
    "2026-09-03T00:20:59.000Z",
    "2026-09-03T00:21:00.000Z",
    "2026-09-03T01:20:59.000Z",
    "2026-09-03T01:21:00.000Z",
    "2026-09-03T02:20:59.000Z",
    "2026-09-03T02:21:00.000Z",
  ]) {
    now = new Date(stamp);
    await watcher.runOnce();
  }

  assert.equal(failingScans, 6);
  assert.equal(healthyScans, 11);
  assert.deepEqual(diagnostics.map((item) => item.observedAt), [
    "2026-09-03T00:00:00.000Z",
    "2026-09-03T00:01:00.000Z",
    "2026-09-03T00:06:00.000Z",
    "2026-09-03T00:21:00.000Z",
    "2026-09-03T01:21:00.000Z",
    "2026-09-03T02:21:00.000Z",
  ]);
  assert.match(diagnostics[0].retry, /2026-09-03T00:01:00.000Z/);
  assert.match(diagnostics[1].retry, /2026-09-03T00:06:00.000Z/);
  assert.match(diagnostics[2].retry, /2026-09-03T00:21:00.000Z/);
  assert.match(diagnostics[3].retry, /2026-09-03T01:21:00.000Z/);
  assert.match(diagnostics[4].retry, /2026-09-03T02:21:00.000Z/);
  assert.match(diagnostics[5].retry, /2026-09-03T03:21:00.000Z/);

  sourceFails = false;
  now = new Date("2026-09-03T03:21:00.000Z");
  await watcher.runOnce();
  await watcher.runOnce();
  assert.equal(failingScans, 8, "success resets the source to the normal scan cadence");

  sourceFails = true;
  await watcher.runOnce();
  assert.match(diagnostics[6].retry, /2026-09-03T03:22:00.000Z/);
});

test("source backoff starts when a failed scan finishes", async (t) => {
  const directory = await temporary(t, "event-watch-source-duration-");
  let now = new Date("2026-09-03T00:00:00.000Z");
  let scans = 0;
  const diagnostics = [];
  const watcher = new ExternalEventWatcher({
    statePath: join(directory, "state.json"),
    sources: { source: { scan: async () => {
      scans += 1;
      if (scans === 1) now = new Date("2026-09-03T00:00:30.000Z");
      throw new Error("provider unavailable");
    } } },
    deliver: async () => {},
    diagnose: (item) => diagnostics.push(item),
    now: () => now,
  });

  await watcher.runOnce();
  now = new Date("2026-09-03T00:01:29.999Z");
  await watcher.runOnce();
  assert.equal(scans, 1);
  assert.match(diagnostics[0].retry, /2026-09-03T00:01:30.000Z/);

  now = new Date("2026-09-03T00:01:30.000Z");
  await watcher.runOnce();
  assert.equal(scans, 2);
});

test("source backoff is disposable across watcher restart", async (t) => {
  const directory = await temporary(t, "event-watch-source-restart-");
  const statePath = join(directory, "state.json");
  let scans = 0;
  const source = { scan: async () => {
    scans += 1;
    throw new Error("provider unavailable");
  } };
  const options = {
    statePath,
    sources: { source },
    deliver: async () => {},
    diagnose: () => {},
    now: () => new Date("2026-09-03T00:00:00.000Z"),
  };

  await new ExternalEventWatcher(options).runOnce();
  await new ExternalEventWatcher(options).runOnce();

  assert.equal(scans, 2, "a new process retries immediately from provider authority");
});

test("source warnings notify the supervisor without discarding valid observations", async (t) => {
  const directory = await temporary(t, "event-watch-warning-");
  let warning = true;
  const diagnostics = [];
  const delivered = [];
  const watcher = new ExternalEventWatcher({
    statePath: join(directory, "state.json"),
    sources: {
      source: { scan: async () => ({
        ...discovery([{
          subject: "resource-1",
          goalId: "g_owner",
          revision: "one",
          payload: {},
        }]),
        warnings: warning ? [{ code: "bounded-window", message: "Discovery may be incomplete." }] : [],
      }) },
    },
    deliver: async (_goalId, observations) => delivered.push(...observations),
    diagnose: (item) => diagnostics.push(item),
    now: () => new Date("2026-09-03T00:00:00.000Z"),
  });

  await watcher.runOnce();
  await watcher.runOnce();
  assert.equal(delivered.length, 1);
  assert.deepEqual(diagnostics.map((item) => item.kind), ["source-warning"]);
  assert.deepEqual(diagnostics[0].affectedGoalIds, ["g_owner"]);
  assert.equal(diagnostics[0].message, "Discovery may be incomplete.");

  warning = false;
  await watcher.runOnce();
  warning = true;
  await watcher.runOnce();
  assert.deepEqual(diagnostics.map((item) => item.kind), ["source-warning", "source-warning"]);
});

test("a pending delivery stays coalesced while its resource rotates out of a scan", async (t) => {
  const directory = await temporary(t, "event-watch-rotated-diagnostic-");
  let present = true;
  const diagnostics = [];
  const watcher = new ExternalEventWatcher({
    statePath: join(directory, "state.json"),
    sources: { source: { scan: async () => discovery(present ? [{
      subject: "resource-1", goalId: "g_owner", revision: "one", payload: {},
    }] : []) } },
    deliver: async () => { throw new Error("worker unavailable"); },
    diagnose: (item) => diagnostics.push(item),
  });

  await watcher.runOnce();
  present = false;
  await watcher.runOnce();
  present = true;
  await watcher.runOnce();

  assert.deepEqual(diagnostics.map((item) => item.kind), ["delivery"]);
});

test("a failed diagnostic delivery is retried without blocking observation", async (t) => {
  const directory = await temporary(t, "event-watch-diagnostic-retry-");
  let attempts = 0;
  let now = new Date("2026-09-03T00:00:00.000Z");
  const watcher = new ExternalEventWatcher({
    statePath: join(directory, "state.json"),
    sources: { source: { scan: async () => { throw new Error("provider unavailable"); } } },
    deliver: async () => {},
    diagnose: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("supervisor unavailable");
    },
    now: () => now,
  });

  await watcher.runOnce();
  await watcher.runOnce();
  now = new Date("2026-09-03T00:01:00.000Z");
  await watcher.runOnce();

  assert.equal(attempts, 2);
});

test("the checkpoint stays bounded without evicting remembered resources", async (t) => {
  const directory = await temporary(t, "event-watch-bound-");
  const diagnostics = [];
  let observations = [
    { subject: "old", goalId: "g_old", revision: "one", payload: {} },
    { subject: "pending", goalId: "g_pending", revision: "one", payload: {} },
  ];
  const watcher = new ExternalEventWatcher({
    statePath: join(directory, "state.json"),
    sources: { source: { scan: async () => discovery(observations) } },
    deliver: async (goalId) => {
      if (goalId === "g_pending") throw new Error("keep pending");
    },
    diagnose: (item) => diagnostics.push(item),
    maxResources: 2,
  });
  await watcher.runOnce();
  observations = [{ subject: "new", goalId: "g_new", revision: "one", payload: {} }];
  await watcher.runOnce();
  const resources = Object.values(JSON.parse(await readFile(join(directory, "state.json"), "utf8")).resources) as any[];
  assert.equal(resources.length, 2);
  assert.deepEqual(resources.map((resource) => resource.subject).sort(), ["old", "pending"]);
  assert.deepEqual(diagnostics.map((item) => item.kind), ["delivery", "checkpoint-limit"]);
  assert.match(diagnostics[1].message, /preserved existing monitoring/);
});

test("authoritative absence frees checkpoint space without losing pending delivery", async (t) => {
  const directory = await temporary(t, "event-watch-pending-space-");
  const statePath = join(directory, "state.json");
  let failing = true;
  let observations = [
    { subject: "one", goalId: "g_same", revision: "one", payload: {} },
    { subject: "two", goalId: "g_same", revision: "one", payload: {} },
  ];
  const delivered = [];
  const watcher = new ExternalEventWatcher({
    statePath,
    sources: { source: { scan: async () => discovery(observations) } },
    deliver: async (_goalId, events) => {
      if (failing) throw new Error("worker unavailable");
      delivered.push(events.map((event) => event.subject));
    },
    diagnose: () => {},
    maxResources: 2,
  });

  await watcher.runOnce();
  failing = false;
  const source = watcher.sources.source;
  source.scan = async () => discovery([
    { subject: "one", goalId: "g_same", revision: "one", payload: {} },
    { subject: "new", goalId: "g_same", revision: "one", payload: {} },
  ], ["two"]);
  await watcher.runOnce();

  assert.deepEqual(delivered, [["one", "new"]]);
  const resources = Object.values(JSON.parse(await readFile(statePath, "utf8")).resources) as any[];
  assert.deepEqual(resources.map((resource) => resource.subject).sort(), ["new", "one"]);
  assert.ok(resources.every((resource) => !resource.pending));
});

test("checkpoint saturation is visible when pending delivery cannot recover", async (t) => {
  const directory = await temporary(t, "event-watch-checkpoint-limit-");
  let observations = [
    { subject: "one", goalId: "g_same", revision: "one", payload: {} },
    { subject: "two", goalId: "g_same", revision: "one", payload: {} },
  ];
  const diagnostics = [];
  const watcher = new ExternalEventWatcher({
    statePath: join(directory, "state.json"),
    sources: { source: { scan: async () => discovery(observations) } },
    deliver: async () => { throw new Error("worker unavailable"); },
    diagnose: (item) => diagnostics.push(item),
    maxResources: 2,
  });

  await watcher.runOnce();
  observations = [
    { subject: "one", goalId: "g_same", revision: "one", payload: {} },
    { subject: "new", goalId: "g_same", revision: "one", payload: {} },
  ];
  await watcher.runOnce();
  observations = [];
  await watcher.runOnce();
  observations = [
    { subject: "one", goalId: "g_same", revision: "one", payload: {} },
    { subject: "new", goalId: "g_same", revision: "one", payload: {} },
  ];
  await watcher.runOnce();

  assert.deepEqual(diagnostics.map((item) => item.kind), ["delivery", "checkpoint-limit"]);
  assert.match(diagnostics[1].message, /source new/);
  assert.deepEqual(diagnostics[1].affectedGoalIds, ["g_same"]);
  assert.match(diagnostics[1].retry, /checkpoint space becomes available/);
});

test("checkpoint turnover allows a later distinct deferral diagnostic", async (t) => {
  const directory = await temporary(t, "event-watch-checkpoint-turnover-");
  let result = discovery([
    { subject: "one", goalId: "g_same", revision: "one", payload: {} },
    { subject: "two", goalId: "g_same", revision: "one", payload: {} },
  ]);
  const diagnostics = [];
  const watcher = new ExternalEventWatcher({
    statePath: join(directory, "state.json"),
    sources: { source: { scan: async () => result } },
    deliver: async () => {},
    diagnose: (item) => diagnostics.push(item),
    maxResources: 2,
  });

  await watcher.runOnce();
  result = discovery([
    { subject: "one", goalId: "g_same", revision: "one", payload: {} },
    { subject: "deferred-one", goalId: "g_same", revision: "one", payload: {} },
  ]);
  await watcher.runOnce();
  result = discovery([
    { subject: "one", goalId: "g_same", revision: "one", payload: {} },
    { subject: "replacement", goalId: "g_same", revision: "one", payload: {} },
  ], ["two"]);
  await watcher.runOnce();
  result = discovery([
    { subject: "one", goalId: "g_same", revision: "one", payload: {} },
    { subject: "deferred-two", goalId: "g_same", revision: "one", payload: {} },
  ]);
  await watcher.runOnce();

  assert.deepEqual(diagnostics.map((item) => item.kind), ["checkpoint-limit", "checkpoint-limit"]);
  assert.match(diagnostics[0].message, /deferred-one/);
  assert.match(diagnostics[1].message, /deferred-two/);
});

test("one scan coalesces several resource changes into one wake per goal", async (t) => {
  const directory = await temporary(t, "event-watch-coalesce-");
  const delivered = [];
  const watcher = new ExternalEventWatcher({
    statePath: join(directory, "state.json"),
    sources: { source: { scan: async () => discovery([
      { subject: "one", goalId: "g_same", revision: "one", payload: {} },
      { subject: "two", goalId: "g_same", revision: "one", payload: {} },
      { subject: "other", goalId: "g_other", revision: "one", payload: {} },
    ]) } },
    deliver: async (goalId, events) => delivered.push({ goalId, subjects: events.map((event) => event.subject) }),
  });
  await watcher.runOnce();
  assert.deepEqual(delivered, [
    { goalId: "g_same", subjects: ["one", "two"] },
    { goalId: "g_other", subjects: ["other"] },
  ]);
});

test("the shared checkpoint accepts both built-in provider bounds together", async (t) => {
  const directory = await temporary(t, "event-watch-provider-bounds-");
  const observations = (prefix, count) => Array.from({ length: count }, (_, index) => ({
    subject: `${prefix}-${index}`,
    goalId: "g_same",
    revision: "one",
    payload: {},
  }));
  const watcher = new ExternalEventWatcher({
    statePath: join(directory, "state.json"),
    sources: {
      "github-pr": { scan: async () => discovery(observations("pr", 20)) },
      "ado-build": { scan: async () => discovery(observations("build", 500)) },
    },
    deliver: async () => {},
  });

  await watcher.runOnce();

  const state = JSON.parse(await readFile(join(directory, "state.json"), "utf8"));
  assert.equal(Object.keys(state.resources).length, 520);
});

test("GitHub discovery reads only annotated pull requests", async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    if (String(url).includes("/pulls?")) return response([
      {
        number: 42,
        body: "## Supervision\n- Goal ID: \"g_pr\"",
        head: { sha: "abc" },
        state: "open",
        draft: false,
        updated_at: "2026-09-01T00:00:00Z",
      },
      {
        number: 43,
        body: "No supervision metadata",
        head: { sha: "def" },
        state: "open",
        draft: false,
        updated_at: "2026-09-01T00:00:00Z",
      },
    ]);
    if (String(url).includes("check-runs")) return response({
      check_runs: [{ id: 1, name: "test", status: "completed", conclusion: "success" }],
    });
    if (String(url).includes("/status?")) return response({ statuses: [] });
    throw new Error(`unexpected URL ${url}`);
  };
  const source = githubPullRequestSource({ repositories: ["owner/repo"], fetchImpl, token: "token" });
  const { observations: found } = await source.scan();
  assert.equal(found.length, 1);
  assert.equal(found[0].subject, "owner/repo#42");
  assert.equal(found[0].goalId, "g_pr");
  assert.equal(urls.some((url) => url.includes("/commits/def/")), false);
});

test("GitHub discovery requires credentials and a bounded repository scope", () => {
  assert.throws(
    () => githubPullRequestSource({ repositories: ["owner/repo"], token: "" }),
    /requires GITHUB_TOKEN or GH_TOKEN/,
  );
  assert.throws(
    () => githubPullRequestSource({
      repositories: Array.from({ length: 11 }, (_, index) => `owner/repo-${index}`),
      token: "token",
    }),
    /at most 10 repositories/,
  );
});

test("built-in sources pass daemon shutdown to provider requests", async () => {
  const factories = [
    (fetchImpl) => githubPullRequestSource({ repositories: ["owner/repo"], token: "token", fetchImpl }),
    (fetchImpl) => adoPullRequestSource({ repositories: ["org/project/repo"], authorization: "Bearer token", fetchImpl }),
    (fetchImpl) => adoBuildSource({ definitions: ["org/project/1"], authorization: "Bearer token", fetchImpl }),
  ];

  for (const create of factories) {
    const controller = new AbortController();
    let started;
    const requested = new Promise((resolve) => { started = resolve; });
    const source = create(async (_url, { signal }) => {
      started();
      await new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const running = source.scan([], { signal: controller.signal });
    await requested;
    controller.abort();
    await assert.rejects(running, { name: "AbortError" });
  }
});

for (const truncated of ["checks", "statuses"]) {
  test(`GitHub discovery rejects truncated ${truncated} instead of hashing partial state`, async () => {
    const items = Array.from({ length: 100 }, (_, id) => ({
      id,
      name: `check-${id}`,
      status: "completed",
      conclusion: "success",
      context: `status-${id}`,
      state: "success",
    }));
    const source = githubPullRequestSource({
      repositories: ["owner/repo"],
      token: "token",
      fetchImpl: async (url) => {
        const text = String(url);
        if (text.includes("/pulls?")) return response([{
          number: 42,
          body: "## Supervision\n- Goal ID: g_pr",
          head: { sha: "abc" },
          state: "open",
          draft: false,
          updated_at: "2026-09-01T00:00:00Z",
        }]);
        if (text.includes("check-runs")) {
          return response({ check_runs: truncated === "checks" ? items : [], total_count: truncated === "checks" ? 101 : 0 });
        }
        if (text.includes("/status?")) {
          return response({ statuses: truncated === "statuses" ? items : [], total_count: truncated === "statuses" ? 101 : 0 });
        }
        throw new Error(`unexpected URL ${url}`);
      },
    });

    await assert.rejects(source.scan(), new RegExp(`GitHub ${truncated} returned truncated state`));
  });
}

test("GitHub discovery refreshes a remembered pull request outside the recent window", async () => {
  const urls = [];
  const pull = {
    number: 42,
    body: "## Supervision\n- Goal ID: g_pr",
    head: { sha: "abc" },
    state: "open",
    draft: false,
    updated_at: "2026-09-01T00:00:00Z",
  };
  const source = githubPullRequestSource({
    repositories: ["owner/repo"],
    token: "token",
    fetchImpl: async (url) => {
      urls.push(String(url));
      if (String(url).includes("/pulls?")) return response([]);
      if (String(url).endsWith("/pulls/42")) return response(pull);
      if (String(url).includes("check-runs")) return response({ check_runs: [] });
      if (String(url).includes("/status?")) return response({ statuses: [] });
      throw new Error(`unexpected URL ${url}`);
    },
  });
  const { observations: found } = await source.scan([{ subject: "owner/repo#42", goalId: "g_pr" }]);
  assert.equal(found.length, 1);
  assert.equal(found[0].goalId, "g_pr");
  assert.ok(urls.some((url) => url.endsWith("/pulls/42")));
});

test("GitHub discovery retires a delivered closed revision outside the recent window", async () => {
  const pull = {
    number: 42,
    body: "## Supervision\n- Goal ID: g_pr",
    head: { sha: "abc" },
    state: "closed",
    draft: false,
    updated_at: "2026-09-01T00:01:00Z",
  };
  const source = githubPullRequestSource({
    repositories: ["owner/repo"],
    token: "token",
    fetchImpl: async (url) => {
      if (String(url).includes("/pulls?")) return response([]);
      if (String(url).endsWith("/pulls/42")) return response(pull);
      if (String(url).includes("check-runs")) return response({ check_runs: [] });
      if (String(url).includes("/status?")) return response({ statuses: [] });
      throw new Error(`unexpected URL ${url}`);
    },
  });

  const first = await source.scan([{ subject: "owner/repo#42", goalId: "g_pr", revision: "old" }]);
  assert.equal(first.observations.length, 1);
  assert.deepEqual(first.absent, []);

  const retargeted = await source.scan([{
    subject: "owner/repo#42", goalId: "g_old", revision: first.observations[0].revision,
  }]);
  assert.equal(retargeted.observations[0].goalId, "g_pr");
  assert.deepEqual(retargeted.absent, []);

  const pending = await source.scan([{
    subject: "owner/repo#42", goalId: "g_pr", revision: first.observations[0].revision, pending: true,
  }]);
  assert.equal(pending.observations.length, 1);
  assert.deepEqual(pending.absent, []);

  const settled = await source.scan([{
    subject: "owner/repo#42",
    goalId: "g_pr",
    revision: first.observations[0].revision,
  }]);
  assert.deepEqual(settled, { observations: [], absent: ["owner/repo#42"] });
});

test("GitHub discovery reports removed goal metadata as authoritative absence", async () => {
  const source = githubPullRequestSource({
    repositories: ["owner/repo"],
    token: "token",
    fetchImpl: async (url) => {
      if (String(url).includes("/pulls?")) return response([{
        number: 42,
        body: "Metadata removed",
        head: { sha: "abc" },
        state: "open",
        draft: false,
      }]);
      throw new Error(`unexpected URL ${url}`);
    },
  });

  const found = await source.scan([{ subject: "owner/repo#42", goalId: "g_pr" }]);

  assert.deepEqual(found, { observations: [], absent: ["owner/repo#42"] });
});

test("GitHub discovery does not crowd a remembered pull request out with recent results", async () => {
  const recent = Array.from({ length: 20 }, (_, index) => ({
    number: index + 1,
    body: `## Supervision\n- Goal ID: g_recent_${index + 1}`,
    head: { sha: `recent-${index + 1}` },
    state: "open",
    draft: false,
    updated_at: "2026-09-01T00:00:00Z",
  }));
  const remembered = {
    number: 42,
    body: "## Supervision\n- Goal ID: g_remembered",
    head: { sha: "remembered" },
    state: "open",
    draft: false,
    updated_at: "2026-09-01T00:00:00Z",
  };
  const source = githubPullRequestSource({
    repositories: ["owner/repo"],
    token: "token",
    fetchImpl: async (url) => {
      if (String(url).includes("/pulls?")) return response(recent);
      if (String(url).endsWith("/pulls/42")) return response(remembered);
      if (String(url).includes("check-runs")) return response({ check_runs: [] });
      if (String(url).includes("/status?")) return response({ statuses: [] });
      throw new Error(`unexpected URL ${url}`);
    },
  });

  const { observations: found } = await source.scan([{ subject: "owner/repo#42", goalId: "g_remembered" }]);

  assert.equal(found.length, 11);
  assert.ok(found.some((item) => item.subject === "owner/repo#42"));
});

test("GitHub discovery rotates through recent annotated pull requests", async () => {
  const pulls = Array.from({ length: 25 }, (_, index) => ({
    number: index + 1,
    body: `## Supervision\n- Goal ID: g_recent_${index + 1}`,
    head: { sha: `sha-${index + 1}` },
    state: "open",
    draft: false,
    updated_at: "2026-09-01T00:00:00Z",
  }));
  const source = githubPullRequestSource({
    repositories: ["owner/repo"],
    token: "token",
    fetchImpl: async (url) => {
      if (String(url).includes("/pulls?")) return response(pulls);
      if (String(url).includes("check-runs")) return response({ check_runs: [] });
      if (String(url).includes("/status?")) return response({ statuses: [] });
      throw new Error(`unexpected URL ${url}`);
    },
  });

  const seen = new Set();
  for (let scan = 0; scan < 3; scan += 1) {
    const { observations: found } = await source.scan();
    assert.equal(found.length, 10);
    for (const item of found) seen.add(item.subject);
  }

  assert.equal(seen.size, 25);
});

test("ADO discovery uses the durable build tag and current build revision", async () => {
  let lastChangedDate = "2026-09-01T00:00:00Z";
  const source = adoBuildSource({
    definitions: ["org/project/77"],
    authorization: "Bearer token",
    fetchImpl: async () => response({ value: [
      {
        id: 101,
        tags: ["herdr-goal=g_build"],
        sourceVersion: "abc",
        status: "inProgress",
        result: null,
        finishTime: null,
        lastChangedDate,
      },
      { id: 102, tags: [], sourceVersion: "def", status: "completed", result: "succeeded" },
    ] }),
  });
  const { observations: found } = await source.scan();
  assert.equal(found.length, 1);
  assert.equal(found[0].subject, "org/project/101");
  assert.equal(found[0].goalId, "g_build");
  lastChangedDate = "2026-09-01T00:01:00Z";
  const { observations: refreshed } = await source.scan();
  assert.equal(refreshed[0].revision, found[0].revision);
  assert.equal("lastChangedDate" in refreshed[0].payload, false);
});

test("ADO pull request discovery observes reviews, discussions, and policies", async () => {
  let vote = 0;
  let threadStatus = "active";
  let commentUpdated = "2026-09-01T00:01:00Z";
  let policyStatus = "queued";
  const source = adoPullRequestSource({
    repositories: ["org/project/repo"],
    authorization: "Bearer token",
    fetchImpl: async (url) => {
      const text = String(url);
      if (text.includes("/threads?")) return response({ count: 1, value: [{
        id: 7,
        status: threadStatus,
        lastUpdatedDate: "2026-09-01T00:01:00Z",
        comments: [{ id: 1, commentType: "text", lastUpdatedDate: commentUpdated }],
      }] });
      if (text.includes("/policy/evaluations?")) return response({ count: 1, value: [{
        evaluationId: "evaluation-1",
        configuration: { id: 8 },
        status: policyStatus,
        startedDate: "2026-09-01T00:00:00Z",
      }] });
      if (text.includes("/pullRequests/42?")) return response({
        pullRequestId: 42,
        description: `${"Meaningful explanation. ".repeat(30)}\n\n## Supervision\n- Goal ID: g_pr`,
        lastMergeSourceCommit: { commitId: "abc" },
        status: "active",
        isDraft: false,
        mergeStatus: "succeeded",
        repository: { project: { id: "project-id" } },
        reviewers: [{ id: "reviewer-1", vote }],
      });
      if (text.includes("/pullRequests?")) return response({ count: 1, value: [{
        pullRequestId: 42,
        description: "List descriptions are not authoritative.",
      }] });
      throw new Error(`unexpected URL ${url}`);
    },
  });

  const first = await source.scan();
  assert.equal(first.observations.length, 1);
  assert.equal(first.observations[0].subject, "org/project/repo/42");
  assert.equal(first.observations[0].goalId, "g_pr");
  assert.equal(first.observations[0].payload.discussions[0].status, "active");

  commentUpdated = "2026-09-01T00:02:00Z";
  const commentChanged = await source.scan();
  assert.notEqual(commentChanged.observations[0].revision, first.observations[0].revision);

  vote = 10;
  threadStatus = "fixed";
  policyStatus = "approved";
  const second = await source.scan();
  assert.notEqual(second.observations[0].revision, commentChanged.observations[0].revision);
  assert.equal(second.observations[0].payload.reviewers[0].vote, 10);
  assert.equal(second.observations[0].payload.policies[0].status, "approved");
});

test("ADO pull request discovery narrows candidates by creator before checking metadata", async () => {
  const creatorId = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
  const otherCreatorId = "11111111-2222-3333-4444-555555555555";
  const listRequests = [];
  const source = adoPullRequestSource({
    repositories: ["org/project/repo"],
    creatorId,
    authorization: "Bearer token",
    fetchImpl: async (url) => {
      const parsed = new URL(String(url));
      if (parsed.pathname.endsWith("/pullRequests")) {
        listRequests.push(parsed);
        return response({ count: 2, value: [
          { pullRequestId: 42 },
          { pullRequestId: 43 },
        ] });
      }
      if (parsed.pathname.endsWith("/pullRequests/42")) return response({
        pullRequestId: 42,
        description: "## Supervision\n- Goal ID: g_selected",
        createdBy: { id: creatorId.toLowerCase() },
        status: "active",
        repository: { project: { id: "project-id" } },
      });
      if (parsed.pathname.endsWith("/pullRequests/43")) return response({
        pullRequestId: 43,
        description: "## Supervision\n- Goal ID: g_previous",
        createdBy: { id: otherCreatorId },
        status: "active",
        repository: { project: { id: "project-id" } },
      });
      if (parsed.pathname.endsWith("/threads")) return response({ count: 0, value: [] });
      if (parsed.pathname.endsWith("/policy/evaluations")) return response({ count: 0, value: [] });
      throw new Error(`unexpected URL ${url}`);
    },
  });

  const found = await source.scan([{
    subject: "org/project/repo/43",
    goalId: "g_previous",
  }]);

  assert.equal(listRequests.length, 1);
  assert.equal(
    listRequests[0].searchParams.get("searchCriteria.creatorId"),
    creatorId.toLowerCase(),
  );
  assert.deepEqual(found.observations.map((item) => item.subject), ["org/project/repo/42"]);
  assert.deepEqual(found.absent, ["org/project/repo/43"]);
});

test("ADO pull request discovery rereads remembered pulls and forgets removed metadata", async () => {
  const urls = [];
  const source = adoPullRequestSource({
    repositories: ["org/project/repo"],
    authorization: "Bearer token",
    fetchImpl: async (url) => {
      const text = String(url);
      urls.push(text);
      if (text.includes("/pullRequests?")) return response({ count: 0, value: [] });
      if (text.includes("/pullRequests/42?")) return response({
        pullRequestId: 42,
        description: "Metadata removed",
        status: "completed",
        repository: { project: { id: "project-id" } },
      });
      throw new Error(`unexpected URL ${url}`);
    },
  });

  const found = await source.scan([{ subject: "org/project/repo/42", goalId: "g_pr" }]);

  assert.deepEqual(found, { observations: [], absent: ["org/project/repo/42"] });
  assert.ok(urls.some((url) => url.includes("/pullRequests/42?")));
});

test("ADO pull request discovery retires a delivered terminal revision", async () => {
  let listedAsActive = true;
  const source = adoPullRequestSource({
    repositories: ["org/project/repo"],
    authorization: "Bearer token",
    fetchImpl: async (url) => {
      const text = String(url);
      if (text.includes("/pullRequests?")) {
        const value = listedAsActive ? [{ pullRequestId: 42 }] : [];
        return response({ count: value.length, value });
      }
      if (text.includes("/pullRequests/42?")) return response({
        pullRequestId: 42,
        description: "## Supervision\n- Goal ID: g_pr",
        lastMergeSourceCommit: { commitId: "abc" },
        status: "completed",
        isDraft: false,
        mergeStatus: "succeeded",
        closedDate: "2026-09-01T00:01:00Z",
        repository: { project: { id: "project-id" } },
      });
      if (text.includes("/threads?")) return response({ count: 0, value: [] });
      if (text.includes("/policy/evaluations?")) return response({ count: 0, value: [] });
      throw new Error(`unexpected URL ${url}`);
    },
  });

  const first = await source.scan([{ subject: "org/project/repo/42", goalId: "g_pr", revision: "old" }]);
  assert.equal(first.observations.length, 1);
  assert.deepEqual(first.absent, []);

  const retargeted = await source.scan([{
    subject: "org/project/repo/42", goalId: "g_old", revision: first.observations[0].revision,
  }]);
  assert.equal(retargeted.observations[0].goalId, "g_pr");
  assert.deepEqual(retargeted.absent, []);

  const pending = await source.scan([{
    subject: "org/project/repo/42", goalId: "g_pr",
    revision: first.observations[0].revision, pending: true,
  }]);
  assert.equal(pending.observations.length, 1);
  assert.deepEqual(pending.absent, []);

  const staleList = await source.scan([{
    subject: "org/project/repo/42", goalId: "g_pr", revision: first.observations[0].revision,
  }]);
  assert.equal(staleList.observations.length, 1);
  assert.deepEqual(staleList.absent, []);

  listedAsActive = false;
  const settled = await source.scan([{
    subject: "org/project/repo/42",
    goalId: "g_pr",
    revision: first.observations[0].revision,
  }]);
  assert.deepEqual(settled, { observations: [], absent: ["org/project/repo/42"] });
});

test("ADO pull request discovery fails when reading a full listed pull request fails", async () => {
  const source = adoPullRequestSource({
    repositories: ["org/project/repo"],
    authorization: "******",
    fetchImpl: async (url) => {
      const text = String(url);
      if (text.includes("/pullRequests?")) return response({ count: 1, value: [{
        pullRequestId: 42,
        description: "List descriptions are not authoritative.",
      }] });
      if (text.includes("/pullRequests/42?")) return response({}, false, 500);
      throw new Error(`unexpected URL ${url}`);
    },
  });

  await assert.rejects(source.scan(), /ADO pull request returned HTTP 500/);
});

test("ADO pull request discovery accepts a bounded full page and refreshes known pulls outside it", async () => {
  const listed = Array.from({ length: 100 }, (_, index) => ({ pullRequestId: index + 1 }));
  const listRequests = [];
  const source = adoPullRequestSource({
    repositories: ["org/project/repo", "org/project/repo"],
    authorization: "Bearer token",
    fetchImpl: async (url) => {
      const parsed = new URL(String(url));
      if (parsed.pathname.endsWith("/pullRequests")) {
        listRequests.push(parsed);
        return response({ count: listed.length, value: listed });
      }
      if (parsed.pathname.endsWith("/threads")) return response({ count: 0, value: [] });
      if (parsed.pathname.endsWith("/policy/evaluations")) return response({ count: 0, value: [] });
      const pullRequestId = Number(parsed.pathname.match(/pullRequests\/(\d+)$/)?.[1]);
      return response({
        pullRequestId,
        description: "## Supervision\n- Goal ID: g_known",
        status: "active",
        repository: { project: { id: "project-id" } },
      });
    },
  });

  const found = await source.scan([{
    subject: "org/project/repo/101",
    goalId: "g_known",
  }]);

  assert.equal(listRequests.length, 1);
  assert.equal(listRequests[0].searchParams.get("$top"), "100");
  assert.equal(listRequests[0].searchParams.has("$skip"), false);
  assert.ok(found.observations.some((item) => item.subject === "org/project/repo/101"));
  assert.deepEqual(found.absent, []);
  assert.equal(found.warnings.length, 1);
  assert.match(found.warnings[0].message, /additional active pulls may be undiscovered/);
});

test("ADO pull request discovery keeps repository scope bounded", () => {
  assert.throws(
    () => adoPullRequestSource({
      repositories: Array.from({ length: 11 }, (_, index) => `org/project/repo-${index}`),
      authorization: "Bearer token",
    }),
    /at most 10 repositories/,
  );
  assert.throws(
    () => adoPullRequestSource({
      repositories: ["org/project/repo"],
      creatorId: "Hao Yuan",
      authorization: "Bearer token",
    }),
    /creator ID must be an Azure DevOps identity UUID/,
  );
});

test("ADO pull request discovery refuses a partial policy revision", async () => {
  const source = adoPullRequestSource({
    repositories: ["org/project/repo"],
    authorization: "Bearer token",
    fetchImpl: async (url) => {
      const text = String(url);
      if (text.includes("/threads?")) return response({ count: 0, value: [] });
      if (text.includes("/policy/evaluations?")) return response({
        count: 100,
        value: Array.from({ length: 100 }, (_, index) => ({
          evaluationId: `evaluation-${index}`,
          configuration: { id: index },
          status: "approved",
        })),
      });
      if (text.includes("/pullRequests/42?")) return response({
        pullRequestId: 42,
        description: "## Supervision\n- Goal ID: g_pr",
        status: "active",
        repository: { project: { id: "project-id" } },
      });
      if (text.includes("/pullRequests?")) return response({ count: 1, value: [{
        pullRequestId: 42,
        description: "List descriptions are not authoritative.",
      }] });
      throw new Error(`unexpected URL ${url}`);
    },
  });

  await assert.rejects(source.scan(), /policies reached their 100-evaluation limit/);
});

test("ADO discovery keeps configured pipeline scope bounded", () => {
  assert.throws(
    () => adoBuildSource({
      definitions: Array.from({ length: 11 }, (_, index) => `org/project/${index + 1}`),
      authorization: "Bearer token",
    }),
    /at most 10 pipeline definitions/,
  );
});

test("ADO authorization preserves the configured CLI failure", async () => {
  await assert.rejects(ambientAdoAuthorization({
    pat: "",
    azureCli: "/opt/az",
    exec: async () => { throw new Error("spawn /opt/az ENOENT"); },
  }), /using \/opt\/az: spawn \/opt\/az ENOENT; renew az login, set AZURE_CLI/);
});

test("ADO authorization passes daemon shutdown to Azure CLI", async () => {
  const controller = new AbortController();
  let receivedSignal;
  const running = ambientAdoAuthorization({
    pat: "",
    signal: controller.signal,
    exec: async (_file, _arguments, options) => {
      receivedSignal = options.signal;
      await new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      });
    },
  });

  controller.abort();

  await assert.rejects(running, { name: "AbortError" });
  assert.equal(receivedSignal, controller.signal);
});

test("ADO discovery refreshes a remembered build outside the recent definition window", async () => {
  const urls = [];
  const source = adoBuildSource({
    definitions: ["org/project/77"],
    authorization: "Bearer token",
    fetchImpl: async (url) => {
      urls.push(String(url));
      if (String(url).includes("builds?")) return response({ value: [] });
      return response({
        id: 101,
        definition: { id: 77 },
        tags: ["herdr-goal=g_build"],
        sourceVersion: "abc",
        status: "completed",
        result: "succeeded",
      });
    },
  });
  const { observations: found } = await source.scan([{ subject: "org/project/101", goalId: "g_build" }]);
  assert.equal(found.length, 1);
  assert.equal(found[0].subject, "org/project/101");
  assert.ok(urls.some((url) => url.includes("/builds/101?")));

  const retargeted = await source.scan([{
    subject: "org/project/101", goalId: "g_old", revision: found[0].revision,
  }]);
  assert.equal(retargeted.observations[0].goalId, "g_build");
  assert.deepEqual(retargeted.absent, []);

  const settled = await source.scan([{
    subject: "org/project/101",
    goalId: "g_build",
    revision: found[0].revision,
  }]);
  assert.deepEqual(settled, { observations: [], absent: ["org/project/101"] });
});

test("ADO discovery keeps an undelivered terminal build", async () => {
  const source = adoBuildSource({
    definitions: ["org/project/77"],
    authorization: "Bearer token",
    fetchImpl: async (url) => {
      if (String(url).includes("builds?")) return response({ value: [] });
      return response({
        id: 101,
        definition: { id: 77 },
        tags: ["herdr-goal=g_build"],
        sourceVersion: "abc",
        status: "completed",
        result: "succeeded",
        finishTime: "2026-09-01T00:01:00Z",
      });
    },
  });
  const first = await source.scan([{ subject: "org/project/101", goalId: "g_build", revision: "old" }]);
  const pending = await source.scan([{
    subject: "org/project/101",
    goalId: "g_build",
    revision: first.observations[0].revision,
    pending: {
      goalId: "g_build",
      revision: first.observations[0].revision,
      payload: first.observations[0].payload,
    },
  }]);
  assert.equal(pending.observations.length, 1);
  assert.deepEqual(pending.absent, []);
});

test("ADO discovery forgets a retained build without hiding valid recent observations", async () => {
  const source = adoBuildSource({
    definitions: ["org/project/77"],
    authorization: "Bearer token",
    fetchImpl: async (url) => {
      if (String(url).includes("builds?")) return response({ value: [{
        id: 202,
        tags: ["herdr-goal=g_recent"],
        sourceVersion: "recent",
        status: "inProgress",
      }] });
      if (String(url).includes("/builds/101?")) return response({}, false, 404);
      throw new Error(`unexpected URL ${url}`);
    },
  });

  const found = await source.scan([{ subject: "org/project/101", goalId: "g_old" }]);

  assert.equal(found.observations.length, 1);
  assert.deepEqual(found.absent, ["org/project/101"]);
});

test("ADO discovery forgets builds outside the configured definition scope", async () => {
  const source = adoBuildSource({
    definitions: ["org/project/77"],
    authorization: "Bearer token",
    fetchImpl: async (url) => {
      if (String(url).includes("builds?")) return response({ value: [] });
      return response({
        id: 101,
        definition: { id: 88 },
        tags: ["herdr-goal=g_old"],
        sourceVersion: "old",
        status: "inProgress",
      });
    },
  });

  const found = await source.scan([{ subject: "org/project/101", goalId: "g_old" }]);

  assert.deepEqual(found, { observations: [], absent: ["org/project/101"] });
});

test("ADO discovery rotates across full definitions without dropping remembered builds", async () => {
  const definitions = Array.from({ length: 6 }, (_, index) => `org/project/${index + 1}`);
  const source = adoBuildSource({
    definitions,
    authorization: "Bearer token",
    fetchImpl: async (url) => {
      const text = String(url);
      if (text.includes("builds?")) {
        const definition = Number(new URL(text).searchParams.get("definitions"));
        return response({ value: Array.from({ length: 100 }, (_, index) => ({
          id: definition * 1_000 + index,
          tags: [`herdr-goal=g_recent_${definition}_${index}`],
          sourceVersion: `sha-${definition}-${index}`,
          status: "inProgress",
        })) });
      }
      if (text.includes("/builds/999?")) return response({
        id: 999,
        definition: { id: 1 },
        tags: ["herdr-goal=g_remembered"],
        sourceVersion: "remembered",
        status: "inProgress",
      });
      throw new Error(`unexpected URL ${url}`);
    },
  });

  const first = await source.scan([{ subject: "org/project/999", goalId: "g_remembered" }]);
  const second = await source.scan([{ subject: "org/project/999", goalId: "g_remembered" }]);

  assert.equal(first.observations.length, 500);
  assert.equal(second.observations.length, 500);
  assert.ok(first.observations.some((item) => item.subject === "org/project/999"));
  assert.ok(second.observations.some((item) => item.subject === "org/project/6000"));
});

test("Herdr delivery resolves a goal to its current exact native session", async (t) => {
  const root = await temporary(t, "event-watch-goals-");
  const session = { source: "herdr:codex", agent: "codex", kind: "id", value: "session-1" };
  await registerSupervisedGoal({ paneId: "w1:p1", terminalId: "terminal-1", agentSession: session }, {
    objective: "Finish the exact goal.",
    acceptance: ["Current evidence proves completion."],
  }, root, { goalId: "g_exact" });
  const calls = [];
  let resumed = false;
  const request = async (method, params) => {
    calls.push([method, params]);
    if (method === "session.snapshot") {
      return { snapshot: { agents: [{
        pane_id: "w1:p9",
        terminal_id: "terminal-9",
        agent_session: session,
        agent_status: resumed ? "working" : "done",
      }] } };
    }
    if (method === "agent.send_keys" && params.keys?.includes("enter")) resumed = true;
    if (method === "agent.get") {
      return { agent: { agent_status: resumed ? "working" : "done" } };
    }
    return {};
  };
  const deliver = herdrGoalDelivery({ goalsRoot: root, request });
  await deliver("g_exact", [{
    source: "ado-pr",
    subject: "org/project/repo/42",
    observedAt: "2026-09-03T00:00:00.000Z",
    revision: "revision-42",
    payload: {
      head: "abc123",
      mergeStatus: "conflicts",
      discussions: [{ id: 71, status: "active", commentCount: 1 }],
      policies: [{ id: "policy-1", status: "rejected" }],
    },
  }]);
  const prompts = calls.filter(([method]) => method === "agent.prompt").map(([, params]) => params);
  const keyCalls = calls.filter(([method]) => method === "agent.send_keys").map(([, params]) => params);
  assert.deepEqual(keyCalls, [{ target: "w1:p9", keys: ["ctrl+u", ..."/goal", "space", ..."resume"] }, {
    target: "w1:p9", keys: ["enter"],
  }]);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].target, "w1:p9");
  assert.match(prompts[0].text, /org\/project\/repo\/42/);
  assert.match(prompts[0].text, /Observed at: 2026-09-03T00:00:00.000Z/);
  assert.match(prompts[0].text, /Revision: revision-42/);
  assert.match(prompts[0].text, /"mergeStatus": "conflicts"/);
  assert.match(prompts[0].text, /"id": 71/);
  assert.match(prompts[0].text, /"id": "policy-1"/);
  assert.match(prompts[0].text, /Do not treat the notification itself as provider authority/);
});

test("Herdr delivery preserves uncertain native resume without resubmitting the event", async (t) => {
  const root = await temporary(t, "event-watch-uncertain-resume-");
  const session = { source: "herdr:codex", agent: "codex", kind: "id", value: "session-1" };
  await registerSupervisedGoal({ paneId: "w1:p1", terminalId: "terminal-1", agentSession: session }, {
    objective: "Finish the exact goal.",
    acceptance: ["Current evidence proves completion."],
  }, root, { goalId: "g_uncertain" });
  const calls = [];
  const deliver = herdrGoalDelivery({
    goalsRoot: root,
    request: async (method, params) => {
      calls.push([method, params]);
      if (method === "session.snapshot") return { snapshot: { agents: [{
        pane_id: "w1:p1",
        terminal_id: "terminal-1",
        agent_session: session,
        agent_status: "done",
      }] } };
      if (method === "agent.send_keys" && params.keys?.includes("enter")) {
        throw new Error("Enter response was lost");
      }
      return {};
    },
  });

  const result = await deliver("g_uncertain", [{ source: "github-pr", subject: "owner/repo#42" }]);

  assert.match(result.warning, /Enter response was lost/);
  assert.equal(calls.filter(([method]) => method === "agent.send_keys").length, 2);
  assert.equal(calls.some(([method]) => method === "agent.prompt"), false);
});

test("Herdr delivery preserves success when action-lock cleanup fails", async (t) => {
  const root = await temporary(t, "event-watch-lock-release-");
  const session = { source: "herdr:codex", agent: "codex", kind: "id", value: "session-1" };
  await registerSupervisedGoal({ paneId: "w1:p1", terminalId: "terminal-1", agentSession: session }, {
    objective: "Finish the exact goal.",
    acceptance: ["Current evidence proves completion."],
  }, root, { goalId: "g_release" });
  let prompts = 0;
  const deliver = herdrGoalDelivery({
    goalsRoot: root,
    request: async (method) => {
      if (method === "session.snapshot") return { snapshot: { agents: [{
        pane_id: "w1:p1",
        terminal_id: "terminal-1",
        agent_session: session,
        agent_status: "working",
      }] } };
      if (method === "agent.prompt") {
        prompts += 1;
        await unlink(join(root, ".action-locks", "g_release", "owner.json"));
      }
      return {};
    },
  });

  const result = await deliver("g_release", [{ source: "github-pr", subject: "owner/repo#42" }]);

  assert.equal(prompts, 1);
  assert.match(result.warning, /goal action lock release failed: goal action lock disappeared/);
});

test("Herdr delivery bounds oversized observed facts without hiding the resource", async (t) => {
  const root = await temporary(t, "event-watch-bounded-facts-");
  const session = { source: "herdr:codex", agent: "codex", kind: "id", value: "session-1" };
  await registerSupervisedGoal({ paneId: "w1:p1", terminalId: "terminal-1", agentSession: session }, {
    objective: "Respond to bounded provider changes.",
    acceptance: ["Provider changes reach the exact worker."],
  }, root, { goalId: "g_bounded" });
  const prompts = [];
  const deliver = herdrGoalDelivery({
    goalsRoot: root,
    request: async (method, params) => {
      if (method === "session.snapshot") return { snapshot: { agents: [{
        pane_id: "w1:p1",
        terminal_id: "terminal-1",
        agent_session: session,
        agent_status: "working",
      }] } };
      if (method === "agent.prompt") prompts.push(params);
      return {};
    },
  });

  await deliver("g_bounded", [{
    source: "ado-pr",
    subject: "org/project/repo/99",
    payload: { evidence: "x".repeat(9 * 1024) },
  }]);

  assert.equal(prompts.length, 1);
  assert.match(prompts[0].text, /org\/project\/repo\/99/);
  assert.match(prompts[0].text, /Omitted because they exceed 8192 bytes/);
  assert.doesNotMatch(prompts[0].text, /x{100}/);
});

test("goal acceptance and external delivery share one atomic action boundary", async (t) => {
  const root = await temporary(t, "event-watch-goal-action-");
  const session = { source: "herdr:codex", agent: "codex", kind: "id", value: "session-1" };
  const binding = await registerSupervisedGoal({
    paneId: "w1:p1",
    terminalId: "terminal-1",
    agentSession: session,
  }, {
    objective: "Finish without losing a concurrent provider update.",
    acceptance: ["Acceptance and notification cannot pass each other."],
  }, root, { goalId: "g_atomic" });
  let unlock;
  let locked;
  const entered = new Promise((resolve) => { locked = resolve; });
  const gate = new Promise((resolve) => { unlock = resolve; });
  const accepting = withGoalActionLock(root, binding.goalId, async () => {
    locked();
    await gate;
    return recordDecision(binding, "accept", {
      progress: "Verified before the provider delivery began.",
      action: "Accepted the verified goal.",
      evidence: ["Current evidence."],
      terminal: { state: "accepted", summary: "Complete." },
    }, root);
  });
  await entered;
  const calls = [];
  const deliver = herdrGoalDelivery({
    goalsRoot: root,
    request: async (method, params) => {
      calls.push([method, params]);
      return { snapshot: { agents: [] } };
    },
  });
  const delivery = deliver("g_atomic", [{ source: "github-pr", subject: "owner/repo#42" }]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls.length, 0, "delivery must wait behind the terminal decision");
  unlock();
  await accepting;
  assert.deepEqual(await delivery, { ignored: "goal completed" });
  assert.equal(calls.length, 0, "a completed goal must not be woken");
});

test("Herdr delivery fails closed when canonical goal ownership is missing", async (t) => {
  const root = await temporary(t, "event-watch-missing-goal-");
  const deliver = herdrGoalDelivery({ goalsRoot: root, request: async () => assert.fail("Herdr must not be called") });
  await assert.rejects(deliver("g_missing", [{ source: "github-pr", subject: "owner/repo#42" }]), /active canonical goal was not found/);
});

for (const { description, prefix, agents, expected } of [
  { description: "a stale", prefix: "stale", agents: [{
    pane_id: "w1:p1",
    terminal_id: "terminal-1",
    agent_session: { source: "herdr:codex", agent: "codex", kind: "id", value: "stale-session" },
    agent_status: "working",
  }], expected: /resolved to 0 live native sessions/ },
  { description: "an ambiguous", prefix: "ambiguous", agents: ["w1:p1", "w1:p2"].map((pane_id) => ({
    pane_id,
    terminal_id: `terminal-${pane_id}`,
    agent_session: { source: "herdr:codex", agent: "codex", kind: "id", value: "session-1" },
    agent_status: "working",
  })), expected: /resolved to 2 live native sessions/ },
]) {
  test(`Herdr delivery fails closed for ${description} exact-session match`, async (t) => {
    const root = await temporary(t, `event-watch-${prefix}-session-`);
    const session = { source: "herdr:codex", agent: "codex", kind: "id", value: "session-1" };
    await registerSupervisedGoal({ paneId: "w1:p1", terminalId: "terminal-1", agentSession: session }, {
      objective: "Finish the exact goal.",
      acceptance: ["Current evidence proves completion."],
    }, root, { goalId: "g_exact" });
    const calls = [];
    const deliver = herdrGoalDelivery({
      goalsRoot: root,
      request: async (method, params) => {
        calls.push([method, params]);
        if (method === "session.snapshot") return { snapshot: { agents } };
        return {};
      },
    });

    await assert.rejects(
      deliver("g_exact", [{ source: "github-pr", subject: "owner/repo#42" }]),
      expected,
    );
    assert.equal(calls.filter(([method]) => method === "agent.prompt").length, 0);
  });
}

test("watcher failures wake the one Pi supervisor with bounded evidence", async () => {
  const calls = [];
  const diagnose = herdrSupervisorDiagnostic({
    request: async (method, params) => {
      calls.push([method, params]);
      if (method === "session.snapshot") return { snapshot: { agents: [
        {
          agent: "pi",
          pane_id: "w1:p2",
          agent_session: { source: "herdr:pi", agent: "pi", kind: "path", value: "/session" },
        },
        {
          agent: "codex",
          pane_id: "w1:p3",
          agent_session: { source: "herdr:codex", agent: "codex", kind: "id", value: "worker" },
        },
      ] } };
      return {};
    },
  });

  await diagnose({
    kind: "source",
    source: "ado-build",
    affectedGoalIds: ["g_release"],
    observedAt: "2026-09-03T00:00:00.000Z",
    message: "ADO discovery failed",
    retry: "The watcher will retry this provider scope on its next bounded scan.",
  });

  const prompt = calls.find(([method]) => method === "agent.prompt")[1];
  assert.equal(prompt.target, "w1:p2");
  assert.match(prompt.text, /ADO discovery failed/);
  assert.match(prompt.text, /^\[event-watchd\/v1\]\nEvent: watcher-diagnostic\nRecipient role: supervisor/);
  assert.match(prompt.text, /Affected Goal IDs: g_release/);
  assert.match(prompt.text, /Observed at: 2026-09-03T00:00:00.000Z/);
  assert.match(prompt.text, /Built-in retry:.*next bounded scan/);
  assert.match(prompt.text, /Do not\s+claim a repair without current evidence/);
  assert.match(prompt.text, /do not create a goal merely because a\s+diagnostic arrived/);
  assert.doesNotMatch(prompt.text, /Inspect current service and provider evidence/);
});

test("watcher diagnostics fail closed when the supervisor is ambiguous", async () => {
  const diagnose = herdrSupervisorDiagnostic({
    request: async () => ({ snapshot: { agents: [
      { agent: "pi", pane_id: "w1:p1", agent_session: { source: "herdr:pi" } },
      { agent: "pi", pane_id: "w1:p2", agent_session: { source: "herdr:pi" } },
    ] } }),
  });

  await assert.rejects(
    diagnose({ message: "failure", observedAt: "2026-09-03T00:00:00.000Z" }),
    /expected one Pi supervisor, found 2/,
  );
});

test("GitHub discovery refreshes every remembered pull request within a few bounded scans", async () => {
  const known = Array.from({ length: 25 }, (_, index) => ({
    subject: `owner/repo#${index + 1}`,
    goalId: `g_remembered_${index + 1}`,
  }));
  const reads = [];
  const source = githubPullRequestSource({
    repositories: ["owner/repo"],
    token: "token",
    fetchImpl: async (url) => {
      const text = String(url);
      if (text.includes("/pulls?")) return response([]);
      const number = /\/pulls\/(\d+)$/.exec(text)?.[1];
      if (number) {
        reads.push(Number(number));
        return response({
          number: Number(number),
          body: `## Supervision\n- Goal ID: g_remembered_${number}`,
          head: { sha: `sha-${number}` },
          state: "open",
          draft: false,
          updated_at: "2026-09-01T00:00:00Z",
        });
      }
      if (text.includes("check-runs")) return response({ check_runs: [] });
      if (text.includes("/status?")) return response({ statuses: [] });
      throw new Error(`unexpected URL ${url}`);
    },
  });

  const scans = [];
  for (let scan = 0; scan < 3; scan += 1) {
    scans.push((await source.scan(known)).observations.length);
  }

  assert.deepEqual(scans, [10, 10, 10]);
  assert.deepEqual([...new Set(reads)].sort((left, right) => left - right), known.map((_, index) => index + 1));
});

test("ADO discovery bounds remembered rereads per scan and still covers them all", async () => {
  const known = Array.from({ length: 120 }, (_, index) => ({
    subject: `org/project/${index + 1}`,
    goalId: `g_remembered_${index + 1}`,
  }));
  const reads = [];
  const source = adoBuildSource({
    definitions: ["org/project/77"],
    authorization: "******",
    fetchImpl: async (url) => {
      const text = String(url);
      if (text.includes("builds?")) return response({ value: [] });
      const id = Number(/\/builds\/(\d+)\?/.exec(text)?.[1]);
      reads.push(id);
      return response({
        id,
        definition: { id: 77 },
        tags: [`herdr-goal=g_remembered_${id}`],
        sourceVersion: `sha-${id}`,
        status: "inProgress",
      });
    },
  });

  const scans = [];
  for (let scan = 0; scan < 3; scan += 1) {
    scans.push((await source.scan(known)).observations.length);
  }

  assert.deepEqual(scans, [50, 50, 50]);
  assert.deepEqual([...new Set(reads)].sort((left, right) => left - right), known.map((_, index) => index + 1));
});

function response(value, ok = true, status = 200) {
  return { ok, status, json: async () => value };
}

function discovery(observations = [], absent = []) {
  return { observations, absent };
}
