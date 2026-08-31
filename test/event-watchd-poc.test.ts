import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { adoBuildSource, ambientAdoAuthorization } from "../poc/event-watchd/ado-build.mjs";
import { eventWatchRequest } from "../poc/event-watchd/client.mjs";
import { EventWatchService } from "../poc/event-watchd/core.mjs";
import { githubPullRequestSource } from "../poc/event-watchd/github-pr.mjs";
import { herdrDelivery } from "../poc/event-watchd/herdr.mjs";
import { EventWatchServer } from "../poc/event-watchd/server.mjs";

function destination(name: string) {
  return { adapter: "test", target: { name } };
}

test("one-shot watches establish a quiet baseline and share later source reads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "event-watchd-test-"));
  let revision = "one";
  let reads = 0;
  const delivered: any[] = [];
  const service = new EventWatchService({
    statePath: join(directory, "state.json"),
    sources: {
      source: { read: async () => ({ revision, payload: { revision, reads: ++reads } }) },
    },
    deliveries: {
      test: { deliver: async (target: any, event: any) => delivered.push({ target, event }) },
    },
  });

  await service.watch({ source: "source", subject: "same", destination: destination("a"), intervalMs: 1_000 });
  await service.watch({ source: "source", subject: "same", destination: destination("b"), intervalMs: 1_000 });
  assert.equal(delivered.length, 0);
  assert.equal(reads, 2, "each registration establishes a current baseline");

  revision = "two";
  await service.pollNow();
  assert.equal(reads, 3, "both destinations share one later source read");
  assert.deepEqual(delivered.map((item) => item.target.name).sort(), ["a", "b"]);
  assert.equal(Object.keys((await service.status()).watches).length, 0, "successful delivery consumes each watch");
});

test("a worker can make a fresh authoritative read through the daemon adapter", async () => {
  const directory = await mkdtemp(join(tmpdir(), "event-watchd-read-"));
  let reads = 0;
  const service = new EventWatchService({
    statePath: join(directory, "state.json"),
    sources: { source: { read: async () => ({ revision: `revision-${++reads}`, payload: { reads } }) } },
    deliveries: {},
  });

  assert.deepEqual(await service.readCurrent({ source: "source", subject: "subject" }), {
    source: "source",
    subject: "subject",
    revision: "revision-1",
    payload: { reads: 1 },
  });
  assert.deepEqual(await service.readCurrent({ source: "source", subject: "subject" }), {
    source: "source",
    subject: "subject",
    revision: "revision-2",
    payload: { reads: 2 },
  });
});

test("an undelivered revision survives restart and a duplicate wake is bounded", async () => {
  const directory = await mkdtemp(join(tmpdir(), "event-watchd-restart-"));
  const statePath = join(directory, "state.json");
  let revision = "one";
  let fail = true;
  const deliveries: any[] = [];
  let deliveredAfterRestart!: () => void;
  const restartDelivery = new Promise<void>((resolve) => { deliveredAfterRestart = resolve; });
  const options = {
    statePath,
    sources: { source: { read: async () => ({ revision, payload: { revision } }) } },
    deliveries: {
      test: {
        deliver: async (_target: any, event: any) => {
          deliveries.push(event);
          if (fail) throw new Error("delivery unavailable");
          deliveredAfterRestart();
        },
      },
    },
  };
  const first = new EventWatchService(options);
  await first.watch({ source: "source", subject: "subject", destination: destination("worker"), intervalMs: 1_000 });
  revision = "two";
  await first.pollNow();
  assert.equal(Object.keys((await first.status()).watches).length, 1);

  fail = false;
  const restarted = new EventWatchService(options);
  await restarted.start();
  await Promise.race([
    restartDelivery,
    new Promise((_, reject) => setTimeout(() => reject(new Error("restart delivery timed out")), 1_000)),
  ]);
  restarted.stop();
  assert.equal(Object.keys((await restarted.status()).watches).length, 0);
  assert.equal(deliveries.length, 2, "the latest pending hint is retried once after restart");
  assert.doesNotMatch(await readFile(statePath, "utf8"), /delivery unavailable/);
});

test("a retry observes the latest revision before delivering an older pending hint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "event-watchd-latest-"));
  let revision = "one";
  let fail = true;
  const attempted: string[] = [];
  const service = new EventWatchService({
    statePath: join(directory, "state.json"),
    sources: { source: { read: async () => ({ revision, payload: { revision } }) } },
    deliveries: {
      test: {
        deliver: async (_target: any, event: any) => {
          attempted.push(event.revision);
          if (fail) throw new Error("offline");
        },
      },
    },
  });
  await service.watch({ source: "source", subject: "subject", destination: destination("worker"), intervalMs: 1_000 });
  revision = "two";
  await service.pollNow();
  revision = "three";
  fail = false;
  await service.pollNow();

  assert.deepEqual(attempted, ["two", "three"]);
  assert.equal(Object.keys((await service.status()).watches).length, 0);
});

test("source retry guidance postpones both observation and pending delivery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "event-watchd-retry-after-"));
  let now = 10_000;
  let revision = "one";
  let sourceFails = false;
  const source = {
    read: async () => {
      if (sourceFails) {
        const error: Error & { retryAfterMs?: number } = new Error("rate limited");
        error.retryAfterMs = 9_000;
        throw error;
      }
      return { revision, payload: null };
    },
  };
  const service = new EventWatchService({
    statePath: join(directory, "state.json"),
    now: () => now,
    sources: { source },
    deliveries: { test: { deliver: async () => { throw new Error("offline"); } } },
  });
  await service.watch({ source: "source", subject: "subject", destination: destination("worker"), intervalMs: 1_000 });
  revision = "two";
  await service.pollNow();
  now += 1_000;
  sourceFails = true;
  await service.pollNow();

  const resource: any = Object.values((await service.status()).resources)[0];
  assert.equal(resource.nextPollAt, now + 9_000);
  assert.match(resource.lastError, /rate limited/);
  const watch: any = Object.values((await service.status()).watches)[0];
  assert.equal(watch.pending.retryAt, now + 9_000);
});

test("retrying the same registration preserves its unseen pending change", async () => {
  const directory = await mkdtemp(join(tmpdir(), "event-watchd-idempotent-"));
  let revision = "one";
  let reads = 0;
  const service = new EventWatchService({
    statePath: join(directory, "state.json"),
    sources: { source: { read: async () => ({ revision, payload: { reads: ++reads } }) } },
    deliveries: { test: { deliver: async () => { throw new Error("offline"); } } },
  });
  const input = { source: "source", subject: "same", destination: destination("worker"), intervalMs: 1_000 };
  const original = await service.watch(input);
  revision = "two";
  await service.pollNow();
  const retried = await service.watch(input);

  assert.equal(retried.watchId, original.watchId);
  assert.equal(retried.existing, true);
  assert.equal(reads, 2, "the idempotent retry does not replace the pending baseline");
  const watch: any = Object.values((await service.status()).watches)[0];
  assert.equal(watch.pending.revision, "two");
});

test("state written before per-watch intervals remains readable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "event-watchd-compat-"));
  const statePath = join(directory, "state.json");
  const options = {
    statePath,
    sources: { source: { read: async () => ({ revision: "one", payload: null }) } },
    deliveries: { test: { deliver: async () => {} } },
  };
  const original = new EventWatchService(options);
  await original.watch({
    source: "source",
    subject: "subject",
    destination: destination("worker"),
    intervalMs: 60_000,
  });
  const oldState = JSON.parse(await readFile(statePath, "utf8"));
  delete (Object.values(oldState.watches)[0] as any).intervalMs;
  await writeFile(statePath, `${JSON.stringify(oldState)}\n`);

  const restarted = new EventWatchService(options);
  const watch: any = Object.values((await restarted.status()).watches)[0];
  assert.equal(watch.intervalMs, 60_000);
});

test("a later registration cannot hide a change from an existing watch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "event-watchd-register-race-"));
  let revision = "one";
  const delivered: any[] = [];
  const service = new EventWatchService({
    statePath: join(directory, "state.json"),
    sources: { source: { read: async () => ({ revision, payload: { revision } }) } },
    deliveries: {
      test: { deliver: async (target: any, event: any) => delivered.push({ target, event }) },
    },
  });
  await service.watch({ source: "source", subject: "same", destination: destination("old"), intervalMs: 1_000 });
  revision = "two";
  await service.watch({ source: "source", subject: "same", destination: destination("new"), intervalMs: 1_000 });

  assert.deepEqual(delivered.map((item) => item.target.name), ["old"]);
  const state = await service.status();
  assert.equal(Object.keys(state.watches).length, 1);
  assert.equal((Object.values(state.watches)[0] as any).destination.target.name, "new");
});

test("a slower second watch cannot postpone an existing fast resource", async () => {
  const directory = await mkdtemp(join(tmpdir(), "event-watchd-interval-"));
  let now = 10_000;
  const service = new EventWatchService({
    statePath: join(directory, "state.json"),
    now: () => now,
    sources: { source: { read: async () => ({ revision: "same", payload: null }) } },
    deliveries: { test: { deliver: async () => {} } },
  });
  const fast = await service.watch({ source: "source", subject: "same", destination: destination("fast"), intervalMs: 1_000 });
  now += 100;
  await service.watch({ source: "source", subject: "same", destination: destination("slow"), intervalMs: 60_000 });

  const resource: any = Object.values((await service.status()).resources)[0];
  assert.equal(resource.intervalMs, 1_000);
  assert.equal(resource.nextPollAt, now + 1_000);

  await service.unwatch(fast.watchId);
  const remaining: any = Object.values((await service.status()).resources)[0];
  assert.equal(remaining.intervalMs, 60_000, "removing the fast watch restores the remaining interval");
});

test("a second daemon cannot steal a live socket", async () => {
  const directory = await mkdtemp(join(tmpdir(), "event-watchd-server-"));
  const socketPath = join(directory, "watch.sock");
  const makeService = (name: string) => new EventWatchService({
    statePath: join(directory, `${name}.json`),
    sources: {},
    deliveries: {},
  });
  const first = new EventWatchServer({ service: makeService("first"), socketPath });
  const second = new EventWatchServer({ service: makeService("second"), socketPath });
  await first.start();
  try {
    await assert.rejects(second.start(), /lock is already owned|already live/);
  } finally {
    await first.stop();
  }
});

test("a failed daemon startup releases its socket and process lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "event-watchd-startup-"));
  const socketPath = join(directory, "watch.sock");
  const failed = new EventWatchServer({
    socketPath,
    service: {
      start: async () => { throw new Error("state is unreadable"); },
      stop: () => {},
    },
  });
  await assert.rejects(failed.start(), /state is unreadable/);

  const replacement = new EventWatchServer({
    socketPath,
    service: new EventWatchService({
      statePath: join(directory, "replacement.json"),
      sources: {},
      deliveries: {},
    }),
  });
  await replacement.start();
  await replacement.stop();
});

function githubResponse(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function githubFixture({ checks, statuses }: { checks: any[]; statuses: any[] }) {
  return async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/pulls/42")) {
      return githubResponse({
        head: { sha: "abc123" },
        state: "open",
        draft: false,
        mergeable: true,
        mergeable_state: "clean",
      });
    }
    const page = Number(url.searchParams.get("page"));
    if (url.pathname.endsWith("/check-runs")) {
      return githubResponse({ check_runs: page === 1 ? checks : [] });
    }
    if (url.pathname.endsWith("/status")) {
      return githubResponse({ statuses: page === 1 ? statuses : [] });
    }
    return githubResponse({ message: "unexpected request" }, 404);
  };
}

test("GitHub observations include checks and statuses in canonical order", async () => {
  const checks = [
    { id: 20, name: "integration", status: "completed", conclusion: "success" },
    { id: 10, name: "unit", status: "in_progress", conclusion: null },
  ];
  const statuses = [
    { id: 40, context: "policy", state: "success" },
    { id: 30, context: "release", state: "pending" },
  ];
  const first = await githubPullRequestSource({ fetchImpl: githubFixture({ checks, statuses }), token: "test" }).read("owner/repo#42");
  const second = await githubPullRequestSource({
    fetchImpl: githubFixture({ checks: [...checks].reverse(), statuses: [...statuses].reverse() }),
    token: "test",
  }).read("owner/repo#42");

  assert.equal(first.revision, second.revision, "provider response order does not create a false change");
  assert.deepEqual(first.payload.checks.map((check: any) => check.id), [10, 20]);
  assert.deepEqual(first.payload.statuses.map((status: any) => status.id), [30, 40]);
  assert.equal(first.payload.mergeableState, "clean");
});

test("GitHub observations page through checks with a hard upper bound", async () => {
  const calls: string[] = [];
  const fetchImpl = async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url.toString());
    if (url.pathname.endsWith("/pulls/42")) {
      return githubResponse({
        head: { sha: "abc123" }, state: "open", draft: false, mergeable: null, mergeable_state: "unknown",
      });
    }
    if (url.pathname.endsWith("/status")) return githubResponse({ statuses: [] });
    if (url.pathname.endsWith("/check-runs")) {
      const page = Number(url.searchParams.get("page"));
      const count = page === 1 ? 100 : 1;
      return githubResponse({
        check_runs: Array.from({ length: count }, (_, index) => ({
          id: (page - 1) * 100 + index + 1,
          name: `check-${(page - 1) * 100 + index + 1}`,
          status: "completed",
          conclusion: "success",
        })),
      });
    }
    return githubResponse({ message: "unexpected request" }, 404);
  };

  const result = await githubPullRequestSource({ fetchImpl, token: "test" }).read("owner/repo#42");
  assert.equal(result.payload.totalChecks, 101);
  assert.equal(result.payload.checks.length, 25);
  assert.equal(result.payload.truncated, true);
  assert.equal(calls.filter((url) => url.includes("/check-runs")).length, 2);
});

test("GitHub rate-limit guidance is exposed to the shared scheduler", async () => {
  const source = githubPullRequestSource({
    fetchImpl: async () => new Response("rate limited", {
      status: 429,
      headers: { "retry-after": "7" },
    }),
    token: "test",
  });
  await assert.rejects(source.read("owner/repo#42"), (error: any) => {
    assert.equal(error.retryAfterMs, 7_000);
    return true;
  });
});

test("ADO observations change only with compact authoritative build state", async () => {
  let build = {
    id: 42,
    status: "inProgress",
    result: null,
    sourceVersion: "abc123",
    finishTime: null,
    unrelatedProviderField: "first",
  };
  const requests: Array<{ url: string; authorization: string }> = [];
  const source = adoBuildSource({
    authorization: "Bearer test-token",
    fetchImpl: async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        authorization: String((init?.headers as Record<string, string>).Authorization),
      });
      return new Response(JSON.stringify(build), { status: 200 });
    },
  });

  const first = await source.read("msazure/CloudNativeCompute/42");
  build = { ...build, unrelatedProviderField: "second" };
  const unchanged = await source.read("msazure/CloudNativeCompute/42");
  build = { ...build, status: "completed", result: "succeeded", finishTime: "2026-08-31T12:00:00Z" };
  const completed = await source.read("msazure/CloudNativeCompute/42");

  assert.equal(first.revision, unchanged.revision);
  assert.notEqual(first.revision, completed.revision);
  assert.deepEqual(completed.payload, {
    id: 42,
    status: "completed",
    result: "succeeded",
    sourceVersion: "abc123",
    finishTime: "2026-08-31T12:00:00Z",
  });
  assert.match(requests[0].url, /msazure\/CloudNativeCompute\/_apis\/build\/builds\/42\?api-version=7\.1/);
  assert.equal(requests[0].authorization, "Bearer test-token");
});

test("ADO obtains a fresh ambient token for each read", async () => {
  let authorizations = 0;
  const seen: string[] = [];
  const source = adoBuildSource({
    getAuthorization: async () => `Bearer token-${++authorizations}`,
    fetchImpl: async (_input: string | URL | Request, init?: RequestInit) => {
      seen.push(String((init?.headers as Record<string, string>).Authorization));
      return new Response(JSON.stringify({
        id: 42, status: "inProgress", result: null, sourceVersion: "abc123", finishTime: null,
      }), { status: 200 });
    },
  });

  await source.read("msazure/CloudNativeCompute/42");
  await source.read("msazure/CloudNativeCompute/42");
  assert.deepEqual(seen, ["Bearer token-1", "Bearer token-2"]);
});

test("ADO supports PAT and bounded provider retry guidance", async () => {
  const authorization = await ambientAdoAuthorization({ pat: "test-pat" });
  assert.equal(authorization, `Basic ${Buffer.from(":test-pat").toString("base64")}`);

  const source = adoBuildSource({
    authorization,
    fetchImpl: async () => new Response("busy", { status: 429, headers: { "retry-after": "9" } }),
  });
  await assert.rejects(source.read("msazure/CloudNativeCompute/42"), (error: any) => {
    assert.equal(error.retryAfterMs, 9_000);
    assert.doesNotMatch(error.message, /busy/);
    return true;
  });
});

test("ADO source enforces a provider-safe polling interval", async () => {
  const directory = await mkdtemp(join(tmpdir(), "event-watchd-ado-rate-"));
  const source = adoBuildSource({
    authorization: "Bearer test-token",
    fetchImpl: async () => new Response(JSON.stringify({
      id: 42, status: "inProgress", result: null, sourceVersion: "abc123", finishTime: null,
    }), { status: 200 }),
  });
  const service = new EventWatchService({
    statePath: join(directory, "state.json"),
    sources: { "ado-build": source },
    deliveries: { test: { deliver: async () => {} } },
  });
  const result = await service.watch({
    source: "ado-build",
    subject: "msazure/CloudNativeCompute/42",
    destination: destination("worker"),
    intervalMs: 1_000,
  });
  assert.equal(result.intervalMs, 60_000);
});

test("unauthenticated GitHub watches use a rate-limit-safe interval", async () => {
  const directory = await mkdtemp(join(tmpdir(), "event-watchd-rate-"));
  const source = githubPullRequestSource({
    fetchImpl: githubFixture({ checks: [], statuses: [] }),
    token: "",
  });
  const service = new EventWatchService({
    statePath: join(directory, "state.json"),
    sources: { "github-pr": source },
    deliveries: { test: { deliver: async () => {} } },
  });
  const result = await service.watch({
    source: "github-pr",
    subject: "owner/repo#42",
    destination: destination("worker"),
    intervalMs: 1_000,
  });

  assert.equal(result.intervalMs, 5 * 60 * 1_000);
  await assert.rejects(service.watch({
    source: "github-pr",
    subject: "owner/other#43",
    destination: destination("other-worker"),
    intervalMs: 5 * 60 * 1_000,
  }), /1-resource capacity/);
});

test("a closed daemon connection cannot leave a CLI request pending", async () => {
  const directory = await mkdtemp(join(tmpdir(), "event-watchd-client-"));
  const socketPath = join(directory, "watch.sock");
  const server = net.createServer((socket) => socket.end("partial response"));
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  await assert.rejects(
    eventWatchRequest({ action: "list" }, { socketPath, timeoutMs: 1_000 }),
    /(ended|closed) without a response/,
  );
  server.close();
});

test("Herdr delivery resumes a settled native Goal before sending the wake hint", async () => {
  const calls: any[] = [];
  const agentSession = { source: "herdr:codex", agent: "codex", kind: "id", value: "session" };
  let snapshots = 0;
  const request = async (method: string, params: any) => {
    calls.push({ method, params });
    if (method === "session.snapshot") {
      snapshots += 1;
      return {
        snapshot: {
          agents: [{ pane_id: snapshots === 1 ? "w1:p2" : "w1:p3", agent_status: snapshots === 1 ? "done" : "working", agent_session: agentSession }],
        },
      };
    }
    return {};
  };
  await herdrDelivery({ request }).deliver({ agentSession }, {
    source: "github-pr",
    subject: "owner/repo#1",
    revision: "two",
    payload: null,
  });

  const prompts = calls.map((call) => call.params.text).filter(Boolean);
  assert.equal(prompts[0], "/goal resume");
  assert.match(prompts[1], /event-watch read github-pr owner\/repo#1/);
  assert.deepEqual(calls[1].params.wait, { until: ["working"], timeout_ms: 10_000 });
  assert.equal(calls.at(-1).params.target, "w1:p3", "the hint follows the exact session after resume");
});

test("delivery failure stays pending and emits one coalesced supervisor diagnostic", async () => {
  const directory = await mkdtemp(join(tmpdir(), "event-watchd-diagnostic-"));
  let revision = "one";
  const diagnostics: any[] = [];
  const service = new EventWatchService({
    statePath: join(directory, "state.json"),
    sources: { source: { read: async () => ({ revision, payload: null }) } },
    deliveries: {
      test: {
        deliver: async (target: any, event: any) => {
          if (target.name === "missing-worker") throw new Error("exact session is not live");
          diagnostics.push(event);
        },
      },
    },
  });
  await service.setDiagnostics(destination("supervisor"));
  await service.watch({
    source: "source",
    subject: "subject",
    destination: destination("missing-worker"),
    intervalMs: 1_000,
  });
  revision = "two";
  await service.pollNow();
  await service.pollNow();

  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].diagnostic, true);
  assert.match(diagnostics[0].payload.error, /exact session is not live/);
  assert.equal(Object.keys((await service.status()).watches).length, 1);
});
