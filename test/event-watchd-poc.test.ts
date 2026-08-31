import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EventWatchService } from "../poc/event-watchd/core.mjs";
import { herdrDelivery } from "../poc/event-watchd/herdr.mjs";

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

test("an undelivered revision survives restart and a duplicate wake is bounded", async () => {
  const directory = await mkdtemp(join(tmpdir(), "event-watchd-restart-"));
  const statePath = join(directory, "state.json");
  let revision = "one";
  let fail = true;
  const deliveries: any[] = [];
  const options = {
    statePath,
    sources: { source: { read: async () => ({ revision, payload: { revision } }) } },
    deliveries: {
      test: {
        deliver: async (_target: any, event: any) => {
          deliveries.push(event);
          if (fail) throw new Error("delivery unavailable");
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
  await restarted.pollNow();
  assert.equal(Object.keys((await restarted.status()).watches).length, 0);
  assert.equal(deliveries.length, 2, "the latest pending hint is retried once after restart");
  assert.doesNotMatch(await readFile(statePath, "utf8"), /delivery unavailable/);
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
  await service.watch({ source: "source", subject: "same", destination: destination("fast"), intervalMs: 1_000 });
  now += 100;
  await service.watch({ source: "source", subject: "same", destination: destination("slow"), intervalMs: 60_000 });

  const resource: any = Object.values((await service.status()).resources)[0];
  assert.equal(resource.intervalMs, 1_000);
  assert.equal(resource.nextPollAt, now + 1_000);
});

test("Herdr delivery resumes a settled native Goal before sending the wake hint", async () => {
  const calls: any[] = [];
  const agentSession = { source: "herdr:codex", agent: "codex", kind: "id", value: "session" };
  const request = async (method: string, params: any) => {
    calls.push({ method, params });
    if (method === "session.snapshot") {
      return { snapshot: { agents: [{ pane_id: "w1:p2", agent_status: "done", agent_session: agentSession }] } };
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
  assert.match(prompts[1], /Reread the provider's current authoritative state/);
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
