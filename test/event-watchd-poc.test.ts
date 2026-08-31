import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { adoBuildDiscovery, taggedGoal } from "../poc/event-watchd/ado-build.mjs";
import { DiscoveredEventWatcher } from "../poc/event-watchd/core.mjs";
import { githubPullRequestDiscovery, supervisionGoal } from "../poc/event-watchd/github-pr.mjs";
import { herdrGoalDelivery, herdrSupervisorDiagnostic } from "../poc/event-watchd/herdr.mjs";
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

test("a failed delivery survives restart and retries from the bounded revision checkpoint", async (t) => {
  const directory = await temporary(t, "event-watch-restart-");
  const statePath = join(directory, "state.json");
  const diagnostics = [];
  const source = { scan: async () => discovery([{ subject: "resource-1", goalId: "g_owner", revision: "one", payload: {} }]) };
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
    deliver: async (goalId, events) => delivered.push([goalId, events[0].revision]),
  });
  await recovered.runOnce();
  assert.deepEqual(delivered, [["g_owner", "one"]]);
  assert.equal((Object.values(JSON.parse(await readFile(statePath, "utf8")).resources)[0] as any).pending, undefined);
});

test("restart replaces a pending revision with current provider state before waking", async (t) => {
  const directory = await temporary(t, "event-watch-current-revision-");
  const statePath = join(directory, "state.json");
  let revision = "old";
  const source = { scan: async () => discovery([{ subject: "resource-1", goalId: "g_owner", revision, payload: {} }]) };
  const first = new DiscoveredEventWatcher({
    statePath,
    sources: { source },
    deliver: async () => { throw new Error("Herdr unavailable"); },
    diagnose: () => {},
  });
  await first.runOnce();

  revision = "current";
  const delivered = [];
  const recovered = new DiscoveredEventWatcher({
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
  const delivered = [];
  const watcher = new DiscoveredEventWatcher({
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
  });

  await watcher.runOnce();
  await watcher.runOnce();
  assert.deepEqual(delivered, ["old"]);

  await watcher.runOnce();
  assert.deepEqual(delivered, ["old", "current"]);
});

test("authoritative absence forgets a resource without delivering its stale pending revision", async (t) => {
  const directory = await temporary(t, "event-watch-absent-");
  const statePath = join(directory, "state.json");
  let present = true;
  let deliveries = 0;
  const watcher = new DiscoveredEventWatcher({
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
  const initial = new DiscoveredEventWatcher({
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

  const cleanup = new DiscoveredEventWatcher({
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
  const watcher = new DiscoveredEventWatcher({
    statePath,
    sources: { source: { scan: async () => discovery() } },
    deliver: async () => {},
  });
  await assert.rejects(watcher.runOnce(), /state is invalid or unsupported/);
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
        return discovery([{ subject: "resource-1", goalId: "g_owner", revision: "one", payload: {} }]);
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

test("a failed diagnostic delivery is retried without blocking observation", async (t) => {
  const directory = await temporary(t, "event-watch-diagnostic-retry-");
  let attempts = 0;
  const watcher = new DiscoveredEventWatcher({
    statePath: join(directory, "state.json"),
    sources: { source: { scan: async () => { throw new Error("provider unavailable"); } } },
    deliver: async () => {},
    diagnose: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("supervisor unavailable");
    },
  });

  await watcher.runOnce();
  await watcher.runOnce();
  await watcher.runOnce();

  assert.equal(attempts, 2);
});

test("the checkpoint stays bounded and prefers pending deliveries", async (t) => {
  const directory = await temporary(t, "event-watch-bound-");
  let observations = [
    { subject: "old", goalId: "g_old", revision: "one", payload: {} },
    { subject: "pending", goalId: "g_pending", revision: "one", payload: {} },
  ];
  const watcher = new DiscoveredEventWatcher({
    statePath: join(directory, "state.json"),
    sources: { source: { scan: async () => discovery(observations) } },
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

test("one scan coalesces several resource changes into one wake per goal", async (t) => {
  const directory = await temporary(t, "event-watch-coalesce-");
  const delivered = [];
  const watcher = new DiscoveredEventWatcher({
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
  const watcher = new DiscoveredEventWatcher({
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
  const source = githubPullRequestDiscovery({ repositories: ["owner/repo"], fetchImpl, token: "token" });
  const { observations: found } = await source.scan();
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
  const { observations: found } = await source.scan([{ subject: "owner/repo#42", goalId: "g_pr" }]);
  assert.equal(found.length, 1);
  assert.equal(found[0].goalId, "g_pr");
  assert.ok(urls.some((url) => url.endsWith("/pulls/42")));
});

test("GitHub discovery reports removed goal metadata as authoritative absence", async () => {
  const source = githubPullRequestDiscovery({
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
  const source = githubPullRequestDiscovery({
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

  assert.equal(found.length, 20);
  assert.ok(found.some((item) => item.subject === "owner/repo#42"));
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
  const { observations: found } = await source.scan();
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
});

test("ADO discovery forgets a retained build without hiding valid recent observations", async () => {
  const source = adoBuildDiscovery({
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
  const source = adoBuildDiscovery({
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

test("ADO discovery bounds output without dropping remembered builds", async () => {
  const definitions = Array.from({ length: 6 }, (_, index) => `org/project/${index + 1}`);
  const source = adoBuildDiscovery({
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

  const { observations: found } = await source.scan([{ subject: "org/project/999", goalId: "g_remembered" }]);

  assert.equal(found.length, 500);
  assert.ok(found.some((item) => item.subject === "org/project/999"));
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
  await deliver("g_exact", [{ source: "github-pr", subject: "owner/repo#42" }]);
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
  await assert.rejects(deliver("g_missing", [{ source: "github-pr", subject: "owner/repo#42" }]), /active canonical goal was not found/);
});

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

  await diagnose({ message: "ADO discovery failed" });

  const prompt = calls.find(([method]) => method === "agent.prompt")[1];
  assert.equal(prompt.target, "w1:p2");
  assert.match(prompt.text, /ADO discovery failed/);
  assert.match(prompt.text, /not a new goal/);
});

test("watcher diagnostics fail closed when the supervisor is ambiguous", async () => {
  const diagnose = herdrSupervisorDiagnostic({
    request: async () => ({ snapshot: { agents: [
      { agent: "pi", pane_id: "w1:p1", agent_session: { source: "herdr:pi" } },
      { agent: "pi", pane_id: "w1:p2", agent_session: { source: "herdr:pi" } },
    ] } }),
  });

  await assert.rejects(diagnose({ message: "failure" }), /expected one Pi supervisor, found 2/);
});

test("GitHub discovery refreshes every remembered pull request within a few bounded scans", async () => {
  const known = Array.from({ length: 25 }, (_, index) => ({
    subject: `owner/repo#${index + 1}`,
    goalId: `g_remembered_${index + 1}`,
  }));
  const reads = [];
  const source = githubPullRequestDiscovery({
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
  const source = adoBuildDiscovery({
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
