import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EventWatchService } from "../poc/event-watchd/core.mjs";

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
  assert.equal(Object.values(state.watches)[0].destination.target.name, "new");
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
