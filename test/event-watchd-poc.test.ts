import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { adoBuildDiscovery, taggedGoal } from "../poc/event-watchd/ado-build.mjs";
import { DiscoveredEventWatcher } from "../poc/event-watchd/core.mjs";
import { githubPullRequestDiscovery, supervisionGoal } from "../poc/event-watchd/github-pr.mjs";
import { herdrGoalDelivery } from "../poc/event-watchd/herdr.mjs";
import { registerSupervisedGoal } from "../src/goal-registry.ts";

async function temporary(t, label) {
  const directory = await mkdtemp(join(tmpdir(), label));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

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
  assert.equal(supervisionGoal("No metadata"), undefined);
  assert.equal(taggedGoal(["unrelated", "herdr-goal=g_exact-1"]), "g_exact-1");
  assert.equal(taggedGoal(["herdr-goal=g_one", "herdr-goal=g_two"]), undefined);
});

test("first discovery and every later revision wake the goal without renewal", async (t) => {
  const directory = await temporary(t, "event-watch-discovery-");
  let revision = "one";
  const delivered = [];
  const watcher = new DiscoveredEventWatcher({
    statePath: join(directory, "state.json"),
    sources: {
      source: { scan: async () => [{ subject: "resource-1", goalId: "g_owner", revision, payload: { revision } }] },
    },
    deliver: async (goalId, event) => delivered.push({ goalId, event }),
  });

  await watcher.runOnce();
  await watcher.runOnce();
  revision = "two";
  await watcher.runOnce();

  assert.deepEqual(delivered.map((item) => [item.goalId, item.event.revision]), [
    ["g_owner", "one"],
    ["g_owner", "two"],
  ]);
  const state = JSON.parse(await readFile(join(directory, "state.json"), "utf8"));
  assert.equal(Object.keys(state.resources).length, 1);
  assert.equal((Object.values(state.resources)[0] as any).revision, "two");
  assert.equal((Object.values(state.resources)[0] as any).pending, undefined);
});

test("a failed delivery survives restart and retries from the bounded revision checkpoint", async (t) => {
  const directory = await temporary(t, "event-watch-restart-");
  const statePath = join(directory, "state.json");
  const diagnostics = [];
  const source = { scan: async () => [{ subject: "resource-1", goalId: "g_owner", revision: "one", payload: {} }] };
  const failing = new DiscoveredEventWatcher({
    statePath,
    sources: { source },
    deliver: async () => { throw new Error("Herdr unavailable"); },
    diagnose: (item) => diagnostics.push(item),
  });
  await failing.runOnce();
  assert.equal(diagnostics.length, 1);
  assert.ok((Object.values(JSON.parse(await readFile(statePath, "utf8")).resources)[0] as any).pending);

  const delivered = [];
  const recovered = new DiscoveredEventWatcher({
    statePath,
    sources: { source },
    deliver: async (goalId, event) => delivered.push([goalId, event.revision]),
  });
  await recovered.runOnce();
  assert.deepEqual(delivered, [["g_owner", "one"]]);
  assert.equal((Object.values(JSON.parse(await readFile(statePath, "utf8")).resources)[0] as any).pending, undefined);
});

test("source and delivery diagnostics coalesce but recover naturally", async (t) => {
  const directory = await temporary(t, "event-watch-diagnostics-");
  let sourceFails = true;
  let deliveryFails = true;
  const diagnostics = [];
  const watcher = new DiscoveredEventWatcher({
    statePath: join(directory, "state.json"),
    sources: {
      source: { scan: async () => {
        if (sourceFails) throw new Error("provider unavailable");
        return [{ subject: "resource-1", goalId: "g_owner", revision: "one", payload: {} }];
      } },
    },
    deliver: async () => {
      if (deliveryFails) throw new Error("worker unavailable");
    },
    diagnose: (item) => diagnostics.push(item),
  });

  await watcher.runOnce();
  await watcher.runOnce();
  sourceFails = false;
  await watcher.runOnce();
  await watcher.runOnce();
  assert.deepEqual(diagnostics.map((item) => item.kind), ["source", "delivery"]);
  deliveryFails = false;
  await watcher.runOnce();
  sourceFails = true;
  await watcher.runOnce();
  assert.deepEqual(diagnostics.map((item) => item.kind), ["source", "delivery", "source"]);
});

test("the checkpoint stays bounded and prefers pending deliveries", async (t) => {
  const directory = await temporary(t, "event-watch-bound-");
  let observations = [
    { subject: "old", goalId: "g_old", revision: "one", payload: {} },
    { subject: "pending", goalId: "g_pending", revision: "one", payload: {} },
  ];
  const watcher = new DiscoveredEventWatcher({
    statePath: join(directory, "state.json"),
    sources: { source: { scan: async () => observations } },
    deliver: async (goalId) => {
      if (goalId === "g_pending") throw new Error("keep pending");
    },
    diagnose: () => {},
    maxResources: 2,
  });
  await watcher.runOnce();
  observations = [{ subject: "new", goalId: "g_new", revision: "one", payload: {} }];
  await watcher.runOnce();
  const resources = Object.values(JSON.parse(await readFile(join(directory, "state.json"), "utf8")).resources) as any[];
  assert.equal(resources.length, 2);
  assert.deepEqual(resources.map((resource) => resource.subject).sort(), ["new", "pending"]);
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
  const source = githubPullRequestDiscovery({ repositories: ["owner/repo"], fetchImpl, token: "token" });
  const found = await source.scan();
  assert.equal(found.length, 1);
  assert.equal(found[0].subject, "owner/repo#42");
  assert.equal(found[0].goalId, "g_pr");
  assert.equal(urls.some((url) => url.includes("/commits/def/")), false);
});

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
  const source = githubPullRequestDiscovery({
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
  const found = await source.scan([{ subject: "owner/repo#42", goalId: "g_pr" }]);
  assert.equal(found.length, 1);
  assert.equal(found[0].goalId, "g_pr");
  assert.ok(urls.some((url) => url.endsWith("/pulls/42")));
});

test("ADO discovery uses the durable build tag and current build revision", async () => {
  const source = adoBuildDiscovery({
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
        lastChangedDate: "2026-09-01T00:00:00Z",
      },
      { id: 102, tags: [], sourceVersion: "def", status: "completed", result: "succeeded" },
    ] }),
  });
  const found = await source.scan();
  assert.equal(found.length, 1);
  assert.equal(found[0].subject, "org/project/101");
  assert.equal(found[0].goalId, "g_build");
});

test("ADO discovery refreshes a remembered build outside the recent definition window", async () => {
  const urls = [];
  const source = adoBuildDiscovery({
    definitions: ["org/project/77"],
    authorization: "Bearer token",
    fetchImpl: async (url) => {
      urls.push(String(url));
      if (String(url).includes("builds?")) return response({ value: [] });
      return response({
        id: 101,
        tags: ["herdr-goal=g_build"],
        sourceVersion: "abc",
        status: "completed",
        result: "succeeded",
      });
    },
  });
  const found = await source.scan([{ subject: "org/project/101", goalId: "g_build" }]);
  assert.equal(found.length, 1);
  assert.equal(found[0].subject, "org/project/101");
  assert.ok(urls.some((url) => url.includes("/builds/101?")));
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
    if (params.text === "/goal resume") resumed = true;
    return {};
  };
  const deliver = herdrGoalDelivery({ goalsRoot: root, request });
  await deliver("g_exact", { source: "github-pr", subject: "owner/repo#42" });
  const prompts = calls.filter(([method]) => method === "agent.prompt").map(([, params]) => params);
  assert.equal(prompts.length, 2);
  assert.equal(prompts[0].target, "w1:p9");
  assert.equal(prompts[0].text, "/goal resume");
  assert.equal(prompts[1].target, "w1:p9");
  assert.match(prompts[1].text, /owner\/repo#42/);
  assert.match(prompts[1].text, /wake hint, not completion proof/);
});

test("Herdr delivery fails closed when canonical goal ownership is missing", async (t) => {
  const root = await temporary(t, "event-watch-missing-goal-");
  const deliver = herdrGoalDelivery({ goalsRoot: root, request: async () => assert.fail("Herdr must not be called") });
  await assert.rejects(deliver("g_missing", { source: "github-pr", subject: "owner/repo#42" }), /active canonical goal was not found/);
});

function response(value, ok = true, status = 200) {
  return { ok, status, json: async () => value };
}
