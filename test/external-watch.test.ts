import assert from "node:assert/strict";
import test from "node:test";
import {
  adoBuildSource,
  ExternalPollFence,
  githubPullRequestSource,
  observeExternalWatches,
} from "../src/external-watch.ts";

test("decision work waits only for its exact in-flight external poll", async () => {
  const fence = new ExternalPollFence();
  let release;
  let completed = false;
  const running = fence.run("github-pr:example/project#7", async () => {
    await new Promise((resolve) => { release = resolve; });
    completed = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  const releaseUnrelated = await fence.hold("github-pr:example/project#8");
  releaseUnrelated();
  assert.equal(completed, false, "an unrelated decision is not delayed");
  const waiting = fence.hold("github-pr:example/project#7");
  assert.equal(completed, false);
  release();
  const releaseDecision = await waiting;
  assert.equal(completed, true);
  releaseDecision();
  await running;
});

test("a decision hold prevents another exact poll until its commit boundary", async () => {
  const fence = new ExternalPollFence();
  const release = await fence.hold("github-pr:example/project#7");
  let polls = 0;
  const skipped = fence.run("github-pr:example/project#7", async () => { polls += 1; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(polls, 0);
  release();
  await skipped;
  assert.equal(polls, 0, "a timer that raced with the decision does not read stale state");
  await fence.run("github-pr:example/project#7", async () => { polls += 1; });
  assert.equal(polls, 1, "a later timer may poll after the decision releases the subject");
});

test("one provider read serves every goal watching the same subject", async () => {
  let reads = 0;
  const observations = await observeExternalWatches([
    { goalId: "g_one", source: "github-pr", subject: "example/project#7", revision: "old" },
    { goalId: "g_two", source: "github-pr", subject: "example/project#7" },
  ], {
    "github-pr": {
      async read() {
        reads += 1;
        return { revision: "current", summary: "PR checks changed" };
      },
    },
  });

  assert.equal(reads, 1);
  assert.deepEqual(observations.map(({ goalId, changed, observedRevision }) => ({
    goalId,
    changed,
    observedRevision,
  })), [
    { goalId: "g_one", changed: true, observedRevision: "current" },
    { goalId: "g_two", changed: false, observedRevision: "current" },
  ]);
});

test("one provider failure does not hide another observation", async () => {
  const observations = await observeExternalWatches([
    { goalId: "g_broken", source: "github-pr", subject: "example/project#7", revision: "old" },
    { goalId: "g_healthy", source: "ado-build", subject: "example/project/9", revision: "old" },
  ], {
    "github-pr": { async read() { throw new Error("temporary GitHub failure"); } },
    "ado-build": { async read() { return { revision: "new", summary: "build completed" }; } },
  });

  assert.equal(observations.find((item) => item.goalId === "g_broken")?.error, "temporary GitHub failure");
  assert.equal(observations.find((item) => item.goalId === "g_healthy")?.changed, true);
});

test("distinct subjects are read sequentially to bound provider concurrency", async () => {
  let active = 0;
  let maximum = 0;
  const source = {
    async read(subject) {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { revision: subject, summary: `${subject} observed` };
    },
  };
  await observeExternalWatches([
    { goalId: "g_one", source: "github-pr", subject: "example/project#1" },
    { goalId: "g_two", source: "github-pr", subject: "example/project#2" },
  ], { "github-pr": source });
  assert.equal(maximum, 1);
});

test("GitHub rate-limit responses carry their retry boundary", async () => {
  const source = githubPullRequestSource({
    token: "test-token",
    async fetchImpl() {
      return new Response(null, { status: 429, headers: { "Retry-After": "7" } });
    },
  });
  const [observation] = await observeExternalWatches([
    { goalId: "g_rate", source: "github-pr", subject: "example/project#7" },
  ], { "github-pr": source });
  assert.equal(observation.ok, false);
  assert.equal(observation.retryAfterMs, 7_000);
});

test("GitHub rate-limit reset is used when Retry-After is absent", async (t) => {
  t.mock.method(Date, "now", () => 1_000_000);
  const source = githubPullRequestSource({
    token: "test-token",
    async fetchImpl() {
      return new Response(null, { status: 429, headers: { "X-RateLimit-Reset": "1009" } });
    },
  });
  const [observation] = await observeExternalWatches([
    { goalId: "g_rate", source: "github-pr", subject: "example/project#7" },
  ], { "github-pr": source });
  assert.equal(observation.ok, false);
  assert.equal(observation.retryAfterMs, 9_000);
});

test("GitHub PR revisions are stable when check order changes", async () => {
  let reverse = false;
  const source = githubPullRequestSource({
    token: "test-token",
    async fetchImpl(url, init) {
      assert.equal(init?.headers.Authorization, "Bearer test-token");
      if (String(url).includes("/pulls/")) {
        return Response.json({
          head: { sha: "abc123" },
          state: "open",
          draft: false,
          mergeable: true,
        });
      }
      if (String(url).includes("/status?")) return Response.json({ statuses: [] });
      const checks = [
        { id: 2, name: "test", status: "completed", conclusion: "success" },
        { id: 1, name: "test", status: "in_progress", conclusion: null },
      ];
      return Response.json({ check_runs: reverse ? checks.reverse() : checks });
    },
  });

  const first = await source.read("hao1939/herdr-supervisor#18");
  reverse = true;
  const second = await source.read("hao1939/herdr-supervisor#18");
  assert.equal(first.revision, second.revision);
  assert.equal(first.summary, "GitHub PR hao1939/herdr-supervisor#18 is open; 1/2 checks completed");
  assert.equal(first.retryAfterMs, undefined, "authenticated reads use the supervisor interval");
});

test("GitHub PR revisions include paginated check runs and commit statuses", async () => {
  const pages = [];
  const source = githubPullRequestSource({
    token: "test-token",
    async fetchImpl(url) {
      const value = String(url);
      if (value.includes("/pulls/")) {
        return Response.json({ head: { sha: "abc123" }, state: "open", draft: false, mergeable: true });
      }
      const page = Number(new URL(value).searchParams.get("page"));
      pages.push({ source: value.includes("/status?") ? "status" : "checks", page });
      if (value.includes("/status?")) {
        return Response.json({ statuses: page === 1
          ? Array.from({ length: 100 }, (_, id) => ({ id, context: `status-${id}`, state: "success" }))
          : [{ id: 100, context: "status-100", state: "pending" }] });
      }
      return Response.json({ check_runs: page === 1
        ? Array.from({ length: 100 }, (_, id) => ({ id, name: `check-${id}`, status: "completed", conclusion: "success" }))
        : [{ id: 100, name: "check-100", status: "in_progress", conclusion: null }] });
    },
  });

  const result = await source.read("hao1939/herdr-supervisor#19");
  assert.equal(result.summary, "GitHub PR hao1939/herdr-supervisor#19 is open; 200/202 checks completed");
  assert.deepEqual(pages.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))), [
    { source: "checks", page: 1 },
    { source: "checks", page: 2 },
    { source: "status", page: 1 },
    { source: "status", page: 2 },
  ]);
});

test("ADO build revisions change only with compact authoritative state", async () => {
  let status = "inProgress";
  const source = adoBuildSource({
    authorization: "Bearer test-token",
    async fetchImpl(url, init) {
      assert.match(String(url), /msazure\/CloudNativeCompute\/_apis\/build\/builds\/42/);
      assert.equal(init?.headers.Authorization, "Bearer test-token");
      return Response.json({
        id: 42,
        status,
        result: status === "completed" ? "succeeded" : null,
        sourceVersion: "abc123",
        finishTime: status === "completed" ? "2026-08-30T00:00:00Z" : null,
        noisyProviderField: Math.random(),
      });
    },
  });

  const first = await source.read("msazure/CloudNativeCompute/42");
  const unchanged = await source.read("msazure/CloudNativeCompute/42");
  assert.equal(first.revision, unchanged.revision);
  status = "completed";
  const completed = await source.read("msazure/CloudNativeCompute/42");
  assert.notEqual(first.revision, completed.revision);
  assert.equal(completed.summary, "ADO build msazure/CloudNativeCompute/42 is completed (succeeded)");
});
