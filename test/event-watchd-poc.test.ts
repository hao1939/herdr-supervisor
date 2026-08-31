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
import { MAX_DATA_BYTES, MAX_RESULT_BYTES } from "../poc/event-watchd/protocol.mjs";
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
  const registered = await service.watch({ source: "source", subject: "same", destination: destination("b"), intervalMs: 1_000 });
  assert.equal(delivered.length, 0);
  assert.equal(reads, 2, "each registration establishes a current baseline");
  assert.deepEqual(registered.payload, { revision: "one", reads: 2 }, "registration exposes the state it actually baselined");

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

  const restarted = new EventWatchService({
    statePath: join(directory, "state.json"),
    now: () => now,
    sources: { source },
    deliveries: { test: { deliver: async () => { throw new Error("offline"); } } },
  });
  await restarted.start();
  restarted.stop();
  const restoredResource: any = Object.values((await restarted.status()).resources)[0];
  assert.equal(restoredResource.nextPollAt, now + 9_000, "restart preserves the provider retry boundary");
});

test("a failed source read cannot deliver an older pending revision", async () => {
  const directory = await mkdtemp(join(tmpdir(), "event-watchd-stale-retry-"));
  let now = 10_000;
  let revision = "one";
  let sourceFails = false;
  let deliveryFails = true;
  const attempts: string[] = [];
  const service = new EventWatchService({
    statePath: join(directory, "state.json"),
    now: () => now,
    sources: {
      source: {
        read: async () => {
          if (sourceFails) throw new Error("provider unavailable");
          return { revision, payload: null };
        },
      },
    },
    deliveries: {
      test: {
        deliver: async (_target: any, event: any) => {
          attempts.push(event.revision);
          if (deliveryFails) throw new Error("worker unavailable");
        },
      },
    },
  });
  await service.watch({ source: "source", subject: "subject", destination: destination("worker"), intervalMs: 1_000 });
  revision = "two";
  await service.pollNow();

  now += 1_000;
  deliveryFails = false;
  sourceFails = true;
  await service.pollNow();

  assert.deepEqual(attempts, ["two"], "the stale pending revision is not delivered after authority fails");
  const watch: any = Object.values((await service.status()).watches)[0];
  assert.equal(watch.pending.revision, "two");
  assert.equal(watch.pending.retryAt, now + 1_000);
});

test("manual poll honors provider retry guidance instead of re-reading during backoff", async () => {
  const directory = await mkdtemp(join(tmpdir(), "event-watchd-manual-backoff-"));
  let now = 10_000;
  let revision = "one";
  let sourceFails = false;
  let reads = 0;
  const source = {
    read: async () => {
      reads += 1;
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
  assert.equal(reads, 1);

  now += 1_000;
  sourceFails = true;
  await service.pollNow();
  assert.equal(reads, 2, "the first failing poll consumes the read that installs the retry deadline");

  now += 1_000;
  await service.pollNow();
  assert.equal(reads, 2, "a second manual poll must not re-read a resource still inside its retry window");
  await assert.rejects(service.readCurrent({ source: "source", subject: "subject" }), (error: any) => {
    assert.match(error.message, /backed off/);
    assert.equal(error.retryAfterMs, 8_000);
    return true;
  });
  await assert.rejects(service.watch({
    source: "source",
    subject: "subject",
    destination: destination("second-worker"),
    intervalMs: 1_000,
  }), /backed off/);
  assert.equal(reads, 2, "manual reads and new registrations also preserve provider backoff");

  now += 9_000;
  await service.pollNow();
  assert.equal(reads, 3, "a manual poll after the retry window elapses reads again");
});

test("an initial source retry boundary covers every subject and read entry point", async () => {
  const directory = await mkdtemp(join(tmpdir(), "event-watchd-source-backoff-"));
  let now = 10_000;
  let reads = 0;
  const service = new EventWatchService({
    statePath: join(directory, "state.json"),
    now: () => now,
    sources: {
      source: {
        read: async (subject: string) => {
          reads += 1;
          if (reads === 1) {
            const error: Error & { retryAfterMs?: number } = new Error("rate limited");
            error.retryAfterMs = 9_000;
            throw error;
          }
          return { revision: subject, payload: null };
        },
      },
    },
    deliveries: { test: { deliver: async () => {} } },
  });
  await assert.rejects(service.watch({
    source: "source", subject: "one", destination: destination("one"), intervalMs: 1_000,
  }), /rate limited/);
  await assert.rejects(service.watch({
    source: "source", subject: "two", destination: destination("two"), intervalMs: 1_000,
  }), /source source is backed off/);
  await assert.rejects(service.readCurrent({ source: "source", subject: "three" }), /source source is backed off/);
  assert.equal(reads, 1);

  now += 9_000;
  const result = await service.readCurrent({ source: "source", subject: "three" });
  assert.equal(result.revision, "three");
  assert.equal(reads, 2);
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
  assert.deepEqual(retried.payload, { reads: 2 });
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

test("source capacity is atomic across concurrent subjects", async () => {
  const directory = await mkdtemp(join(tmpdir(), "event-watchd-capacity-"));
  let reads = 0;
  let release!: () => void;
  const bothReading = new Promise<void>((resolve) => { release = resolve; });
  const service = new EventWatchService({
    statePath: join(directory, "state.json"),
    sources: {
      source: {
        maxResources: 1,
        read: async (subject: string) => {
          reads += 1;
          if (reads === 2) release();
          await bothReading;
          return { revision: subject, payload: null };
        },
      },
    },
    deliveries: { test: { deliver: async () => {} } },
  });

  const results = await Promise.allSettled([
    service.watch({ source: "source", subject: "one", destination: destination("one"), intervalMs: 1_000 }),
    service.watch({ source: "source", subject: "two", destination: destination("two"), intervalMs: 1_000 }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal(Object.keys((await service.status()).resources).length, 1);
});

test("list returns bounded pages without opaque destination data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "event-watchd-list-"));
  const subject = "s".repeat(1_500);
  const service = new EventWatchService({
    statePath: join(directory, "state.json"),
    sources: { source: { read: async () => ({ revision: "one", payload: null }) } },
    deliveries: { test: { deliver: async () => {} } },
  });
  for (let index = 0; index < 25; index += 1) {
    await service.watch({
      source: "source",
      subject,
      destination: { adapter: "test", target: { name: `worker-${index}`, opaque: "x".repeat(10_000) } },
      intervalMs: 1_000,
    });
  }

  const first = await service.list();
  assert.equal(first.totalWatches, 25);
  assert.equal(first.watches.length, 20);
  assert.ok(first.nextCursor);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) < 64 * 1024);
  assert.equal(JSON.stringify(first).includes("opaque"), false);
  assert.equal(first.watches[0].subject.length, 500);
  assert.equal(first.watches[0].subjectTruncated, true);

  const second = await service.list({ cursor: first.nextCursor });
  assert.equal(second.watches.length, 5);
  assert.equal(second.nextCursor, null);
});

test("list keeps multibyte valid state inside the socket response budget", async () => {
  const directory = await mkdtemp(join(tmpdir(), "event-watchd-list-bytes-"));
  const sourceName = "源".repeat(2_000);
  const subject = "项".repeat(1_500);
  const service = new EventWatchService({
    statePath: join(directory, "state.json"),
    sources: { [sourceName]: { read: async () => ({ revision: "版".repeat(2_000), payload: null }) } },
    deliveries: { test: { deliver: async () => {} } },
  });
  for (let index = 0; index < 20; index += 1) {
    await service.watch({
      source: sourceName,
      subject,
      destination: destination(`worker-${index}`),
      intervalMs: 1_000,
    });
  }

  const first = await service.list();
  assert.ok(first.watches.length > 0 && first.watches.length < 20);
  assert.ok(first.nextCursor);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) <= MAX_RESULT_BYTES);
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
  assert.equal(remaining.nextPollAt, resource.nextPollAt, "removing a watch preserves the existing provider deadline");
});

test("removing a watch cannot erase a provider retry boundary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "event-watchd-unwatch-backoff-"));
  let now = 10_000;
  let fails = false;
  const service = new EventWatchService({
    statePath: join(directory, "state.json"),
    now: () => now,
    sources: {
      source: {
        read: async () => {
          if (fails) {
            const error: Error & { retryAfterMs?: number } = new Error("provider busy");
            error.retryAfterMs = 9_000;
            throw error;
          }
          return { revision: "same", payload: null };
        },
      },
    },
    deliveries: { test: { deliver: async () => {} } },
  });
  const fast = await service.watch({ source: "source", subject: "same", destination: destination("fast"), intervalMs: 1_000 });
  await service.watch({ source: "source", subject: "same", destination: destination("slow"), intervalMs: 60_000 });
  fails = true;
  await service.pollNow();
  const retryAt = (Object.values((await service.status()).resources)[0] as any).nextPollAt;

  now += 100;
  await service.unwatch(fast.watchId);
  const remaining: any = Object.values((await service.status()).resources)[0];
  assert.equal(remaining.intervalMs, 60_000);
  assert.equal(remaining.nextPollAt, retryAt);
});

test("cancellation and delivery have one serialized winner", async () => {
  const directory = await mkdtemp(join(tmpdir(), "event-watchd-cancel-delivery-"));
  let revision = "one";
  let deliveryStarted!: () => void;
  const started = new Promise<void>((resolve) => { deliveryStarted = resolve; });
  let releaseDelivery!: () => void;
  const release = new Promise<void>((resolve) => { releaseDelivery = resolve; });
  let deliveries = 0;
  const service = new EventWatchService({
    statePath: join(directory, "state.json"),
    sources: { source: { read: async () => ({ revision, payload: null }) } },
    deliveries: {
      test: {
        deliver: async () => {
          deliveries += 1;
          deliveryStarted();
          await release;
        },
      },
    },
  });
  const registered = await service.watch({
    source: "source",
    subject: "subject",
    destination: destination("worker"),
    intervalMs: 1_000,
  });
  revision = "two";
  const polling = service.pollNow();
  await started;

  let cancellationSettled = false;
  const cancellation = service.unwatch(registered.watchId).then((removed) => {
    cancellationSettled = true;
    return removed;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancellationSettled, false, "cancellation waits for in-flight delivery");

  releaseDelivery();
  await polling;
  assert.equal(await cancellation, false, "delivery consumed the watch before cancellation acquired the lock");
  assert.equal(deliveries, 1);

  const second = await service.watch({
    source: "source",
    subject: "subject",
    destination: destination("second-worker"),
    intervalMs: 1_000,
  });
  assert.equal(await service.unwatch(second.watchId), true);
  revision = "three";
  await service.pollNow();
  assert.equal(deliveries, 1, "delivery sees no watch after cancellation wins");
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

test("a daemon does not expose its socket before service initialization", async () => {
  const directory = await mkdtemp(join(tmpdir(), "event-watchd-startup-client-"));
  const socketPath = join(directory, "watch.sock");
  let initializationStarted!: () => void;
  const started = new Promise<void>((resolve) => { initializationStarted = resolve; });
  let failInitialization!: () => void;
  const fail = new Promise<void>((resolve) => { failInitialization = resolve; });
  const server = new EventWatchServer({
    socketPath,
    service: {
      start: async () => {
        initializationStarted();
        await fail;
        throw new Error("state is unreadable");
      },
      stop: () => {},
    },
  });
  const startup = server.start();
  await started;
  await assert.rejects(
    new Promise<void>((resolve, reject) => {
      const client = net.createConnection(socketPath);
      client.once("connect", () => {
        client.destroy();
        resolve();
      });
      client.once("error", reject);
    }),
    /ENOENT/,
  );
  failInitialization();

  await Promise.race([
    assert.rejects(startup, /state is unreadable/),
    new Promise((_, reject) => setTimeout(() => reject(new Error("failed startup cleanup timed out")), 1_000)),
  ]);
});

test("daemon shutdown closes an idle client before releasing ownership", async () => {
  const directory = await mkdtemp(join(tmpdir(), "event-watchd-shutdown-"));
  const socketPath = join(directory, "watch.sock");
  const server = new EventWatchServer({
    socketPath,
    service: new EventWatchService({ statePath: join(directory, "state.json"), sources: {}, deliveries: {} }),
  });
  await server.start();
  const idle = net.createConnection(socketPath);
  await new Promise<void>((resolve, reject) => {
    idle.once("connect", resolve);
    idle.once("error", reject);
  });
  await Promise.race([
    server.stop(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("daemon shutdown timed out")), 1_000)),
  ]);
  assert.equal(idle.destroyed, true);

  const replacement = new EventWatchServer({
    socketPath,
    service: new EventWatchService({ statePath: join(directory, "replacement.json"), sources: {}, deliveries: {} }),
  });
  await replacement.start();
  await replacement.stop();
});

test("daemon shutdown keeps ownership until an active request drains", async () => {
  const directory = await mkdtemp(join(tmpdir(), "event-watchd-drain-"));
  const socketPath = join(directory, "watch.sock");
  let requestStarted!: () => void;
  const started = new Promise<void>((resolve) => { requestStarted = resolve; });
  let releaseRequest!: () => void;
  const release = new Promise<void>((resolve) => { releaseRequest = resolve; });
  const server = new EventWatchServer({
    socketPath,
    service: {
      start: async () => {},
      stop: async () => {},
      pollNow: async () => {
        requestStarted();
        await release;
      },
    },
  });
  await server.start();
  const request = eventWatchRequest({ action: "poll" }, { socketPath, timeoutMs: 1_000 });
  const requestFailure = assert.rejects(request, /(ended|closed) without a response/);
  await started;
  let stopped = false;
  const stopping = server.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(stopped, false, "the old daemon retains ownership while its request can still mutate state");
  releaseRequest();
  await requestFailure;
  await stopping;

  const replacement = new EventWatchServer({
    socketPath,
    service: new EventWatchService({ statePath: join(directory, "replacement.json"), sources: {}, deliveries: {} }),
  });
  await replacement.start();
  await replacement.stop();
});

test("one daemon connection executes at most one request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "event-watchd-one-request-"));
  const socketPath = join(directory, "watch.sock");
  let polls = 0;
  let requestStarted!: () => void;
  const started = new Promise<void>((resolve) => { requestStarted = resolve; });
  let releaseRequest!: () => void;
  const release = new Promise<void>((resolve) => { releaseRequest = resolve; });
  const server = new EventWatchServer({
    socketPath,
    service: {
      start: async () => {},
      stop: async () => {},
      pollNow: async () => {
        polls += 1;
        requestStarted();
        await release;
      },
    },
  });
  await server.start();
  const client = net.createConnection(socketPath);
  await new Promise<void>((resolve, reject) => {
    client.once("connect", resolve);
    client.once("error", reject);
  });
  const response = new Promise<void>((resolve, reject) => {
    client.once("data", () => resolve());
    client.once("error", reject);
  });
  client.write(`${JSON.stringify({ id: "one", action: "poll" })}\n`);
  await started;
  client.write(`${JSON.stringify({ id: "two", action: "poll" })}\n`);
  client.write(`${JSON.stringify({ id: "three", action: "poll" })}\n`);
  releaseRequest();
  await response;
  client.destroy();
  assert.equal(polls, 1, "later frames cannot become queued requests");
  await server.stop();
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

test("GitHub observation payload stays inside the shared data budget", async () => {
  const label = "测".repeat(200);
  const checks = Array.from({ length: 50 }, (_, id) => ({
    id, name: label, status: "completed", conclusion: "success",
  }));
  const statuses = Array.from({ length: 50 }, (_, id) => ({ id, context: label, state: "success" }));
  const result = await githubPullRequestSource({ fetchImpl: githubFixture({ checks, statuses }), token: "test" })
    .read("owner/repo#42");

  assert.ok(Buffer.byteLength(JSON.stringify(result.payload)) <= MAX_DATA_BYTES);
  assert.equal(result.payload.truncated, true);
  assert.ok(result.payload.checks.length + result.payload.statuses.length < 50);
});

test("GitHub pagination fails visibly inside its authenticated request budget", async () => {
  const calls: string[] = [];
  const source = githubPullRequestSource({
    token: "test",
    fetchImpl: async (input: string | URL | Request) => {
      const url = new URL(String(input));
      calls.push(url.toString());
      if (url.pathname.endsWith("/pulls/42")) {
        return githubResponse({
          head: { sha: "abc123" }, state: "open", draft: false, mergeable: true, mergeable_state: "clean",
        });
      }
      if (url.pathname.endsWith("/check-runs")) {
        return githubResponse({ check_runs: Array.from({ length: 100 }, (_, id) => ({ id, name: `check-${id}`, status: "completed", conclusion: "success" })) });
      }
      if (url.pathname.endsWith("/status")) {
        return githubResponse({ statuses: Array.from({ length: 100 }, (_, id) => ({ id, context: `status-${id}`, state: "success" })) });
      }
      return githubResponse({}, 404);
    },
  });

  await assert.rejects(source.read("owner/repo#42"), (error: any) => {
    assert.match(error.message, /bounded 500-item limit/);
    assert.equal(error.retryAfterMs, 60 * 60 * 1_000);
    return true;
  });
  assert.equal(calls.filter((url) => url.includes("/check-runs")).length, 5);
  assert.equal(calls.filter((url) => url.includes("/status")).length, 5);
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

test("ordinary GitHub errors do not install provider-wide rate-limit backoff", async () => {
  const source = githubPullRequestSource({
    fetchImpl: async () => new Response("missing", {
      status: 404,
      headers: { "x-ratelimit-reset": String(Math.ceil(Date.now() / 1_000) + 3_600) },
    }),
    token: "test",
  });
  await assert.rejects(source.read("owner/repo#42"), (error: any) => {
    assert.equal(error.retryAfterMs, undefined);
    return true;
  });
});

test("GitHub source bounds actual requests across reads", async () => {
  let requests = 0;
  const source = githubPullRequestSource({
    token: "test",
    requestLimit: 2,
    now: () => 10_000,
    fetchImpl: async (input: string | URL | Request) => {
      requests += 1;
      const url = new URL(String(input));
      if (url.pathname.endsWith("/pulls/42")) {
        return githubResponse({
          head: { sha: "abc123" }, state: "open", draft: false, mergeable: true, mergeable_state: "clean",
        });
      }
      return url.pathname.endsWith("/check-runs")
        ? githubResponse({ check_runs: [] })
        : githubResponse({ statuses: [] });
    },
  });

  await assert.rejects(source.read("owner/repo#42"), (error: any) => {
    assert.match(error.message, /2-request hourly budget/);
    assert.equal(error.retryAfterMs, 60 * 60 * 1_000);
    return true;
  });
  assert.equal(requests, 2);
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

test("concurrent ADO reads share one ambient token acquisition", async () => {
  let authorizations = 0;
  let releaseAuthorization!: () => void;
  const release = new Promise<void>((resolve) => { releaseAuthorization = resolve; });
  const seen: string[] = [];
  const source = adoBuildSource({
    getAuthorization: async () => {
      authorizations += 1;
      await release;
      return "Bearer shared-token";
    },
    fetchImpl: async (_input: string | URL | Request, init?: RequestInit) => {
      seen.push(String((init?.headers as Record<string, string>).Authorization));
      return new Response(JSON.stringify({
        id: 42, status: "inProgress", result: null, sourceVersion: "abc123", finishTime: null,
      }), { status: 200 });
    },
  });

  const reads = Promise.all([
    source.read("msazure/CloudNativeCompute/42"),
    source.read("msazure/CloudNativeCompute/43"),
  ]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(authorizations, 1);
  releaseAuthorization();
  await reads;
  assert.deepEqual(seen, ["Bearer shared-token", "Bearer shared-token"]);
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

test("ADO accepts current Entra token sizes without exposing the token", async () => {
  const realisticToken = "x".repeat(3_000);
  const authorization = await ambientAdoAuthorization({
    exec: async () => ({ stdout: `${realisticToken}\n` }),
  });
  assert.equal(authorization, `Bearer ${realisticToken}`);
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

test("ADO bounds actual provider requests across manual reads", async () => {
  let requests = 0;
  const source = adoBuildSource({
    authorization: "Bearer test-token",
    requestLimit: 1,
    now: () => 10_000,
    fetchImpl: async () => {
      requests += 1;
      return new Response(JSON.stringify({
        id: 42, status: "inProgress", result: null, sourceVersion: "abc123", finishTime: null,
      }), { status: 200 });
    },
  });

  await source.read("msazure/CloudNativeCompute/42");
  await assert.rejects(source.read("msazure/CloudNativeCompute/42"), (error: any) => {
    assert.match(error.message, /1-request hourly budget/);
    assert.equal(error.retryAfterMs, 60 * 60 * 1_000);
    return true;
  });
  assert.equal(requests, 1);
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

test("restart reapplies current source intervals and capacities", async () => {
  const directory = await mkdtemp(join(tmpdir(), "event-watchd-restart-policy-"));
  const statePath = join(directory, "state.json");
  const delivery = { test: { deliver: async () => {} } };
  const original = new EventWatchService({
    statePath,
    sources: { source: { minimumIntervalMs: 1_000, maxResources: 2, read: async (subject: string) => ({ revision: subject, payload: null }) } },
    deliveries: delivery,
  });
  await original.watch({ source: "source", subject: "one", destination: destination("one"), intervalMs: 1_000 });
  await original.watch({ source: "source", subject: "two", destination: destination("two"), intervalMs: 1_000 });

  const reduced = new EventWatchService({
    statePath,
    sources: { source: { minimumIntervalMs: 5_000, maxResources: 1, read: async (subject: string) => ({ revision: subject, payload: null }) } },
    deliveries: delivery,
  });
  await assert.rejects(reduced.start(), /2 resources but current capacity is 1/);

  const compatible = new EventWatchService({
    statePath,
    sources: { source: { minimumIntervalMs: 5_000, maxResources: 2, read: async (subject: string) => ({ revision: subject, payload: null }) } },
    deliveries: delivery,
  });
  await compatible.start();
  compatible.stop();
  const state = await compatible.status();
  assert.deepEqual(Object.values(state.watches).map((watch: any) => watch.intervalMs), [5_000, 5_000]);
  assert.deepEqual(Object.values(state.resources).map((resource: any) => resource.intervalMs), [5_000, 5_000]);
});

test("a queued scheduler pass rechecks the resource deadline after its lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "event-watchd-tick-lock-"));
  let now = 10_000;
  let reads = 0;
  let releaseRead!: () => void;
  let reading!: () => void;
  const entered = new Promise<void>((resolve) => { reading = resolve; });
  const release = new Promise<void>((resolve) => { releaseRead = resolve; });
  const service = new EventWatchService({
    statePath: join(directory, "state.json"),
    now: () => now,
    sources: {
      source: {
        read: async () => {
          reads += 1;
          if (reads === 2) {
            reading();
            await release;
          }
          return { revision: "same", payload: null };
        },
      },
    },
    deliveries: { test: { deliver: async () => {} } },
  });
  await service.watch({ source: "source", subject: "same", destination: destination("worker"), intervalMs: 1_000 });
  now += 1_000;
  (service as any).running = true;
  const first = service.tick();
  await entered;
  const second = service.tick();
  releaseRead();
  await Promise.all([first, second]);
  service.stop();

  assert.equal(reads, 2, "the queued pass skips the resource after the first pass moves its deadline");
});

test("a failed concurrent scheduler read drains its started siblings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "event-watchd-concurrent-drain-"));
  let now = 10_000;
  let polling = false;
  let secondStarted!: () => void;
  const started = new Promise<void>((resolve) => { secondStarted = resolve; });
  let releaseSecond!: () => void;
  const release = new Promise<void>((resolve) => { releaseSecond = resolve; });
  const service = new EventWatchService({
    statePath: join(directory, "state.json"),
    now: () => now,
    sources: {
      source: {
        read: async (subject: string) => {
          if (!polling) return { revision: subject, payload: null };
          if (subject === "one") return { revision: "one-changed", payload: null };
          secondStarted();
          await release;
          return { revision: subject, payload: null };
        },
      },
    },
    deliveries: { test: { deliver: async () => {} } },
  });
  await service.watch({ source: "source", subject: "one", destination: destination("one"), intervalMs: 1_000 });
  await service.watch({ source: "source", subject: "two", destination: destination("two"), intervalMs: 1_000 });
  const mutate = (service as any).mutate.bind(service);
  let failNextMutation = true;
  (service as any).mutate = async (change: unknown) => {
    if (failNextMutation) {
      failNextMutation = false;
      throw new Error("first state save failed");
    }
    return mutate(change);
  };
  polling = true;
  now += 1_000;
  (service as any).running = true;
  let settled = false;
  const tick = service.tick().finally(() => { settled = true; });
  await started;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(settled, false, "the scheduler keeps ownership while a sibling read can still mutate state");
  (service as any).running = false;
  releaseSecond();
  await assert.rejects(tick, /first state save failed/);
  await service.stop();
});

test("service shutdown drains a scheduler tick before it acquires a resource lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "event-watchd-tick-drain-"));
  let now = 10_000;
  const service = new EventWatchService({
    statePath: join(directory, "state.json"),
    now: () => now,
    sources: { source: { read: async () => ({ revision: "same", payload: null }) } },
    deliveries: { test: { deliver: async () => {} } },
  });
  await service.watch({ source: "source", subject: "same", destination: destination("worker"), intervalMs: 1_000 });
  now += 1_000;
  let releaseMutation!: () => void;
  const mutation = new Promise<void>((resolve) => { releaseMutation = resolve; });
  (service as any).mutations = mutation;
  (service as any).running = true;
  service.runTick();
  await new Promise((resolve) => setImmediate(resolve));

  let stopped = false;
  const stopping = service.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(stopped, false);
  releaseMutation();
  await stopping;
  assert.equal((service as any).activeTicks.size, 0);
});

test("service shutdown waits for ticks that become active while draining", async () => {
  const directory = await mkdtemp(join(tmpdir(), "event-watchd-stop-active-ticks-"));
  let releaseMutation!: () => void;
  const mutation = new Promise<void>((resolve) => { releaseMutation = resolve; });
  let releaseTick!: () => void;
  const activeTick = new Promise<void>((resolve) => { releaseTick = resolve; });
  const service = new EventWatchService({
    statePath: join(directory, "state.json"),
    sources: { source: { read: async () => ({ revision: "same", payload: null }) } },
    deliveries: { test: { deliver: async () => {} } },
  });
  (service as any).mutations = mutation;
  let stopped = false;
  const stopping = service.stop().then(() => { stopped = true; });
  const trackedTick = activeTick.finally(() => (service as any).activeTicks.delete(trackedTick));
  (service as any).activeTicks.add(trackedTick);
  releaseMutation();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(stopped, false);
  releaseTick();
  await stopping;
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

test("Herdr delivery rechecks exact identity after native Goal resume", async () => {
  const agentSession = { source: "herdr:codex", agent: "codex", kind: "id", value: "session" };
  const replacementSession = { ...agentSession, value: "replacement" };
  const afterResumeCases = [
    { name: "missing", agents: [], matches: 0 },
    {
      name: "ambiguous",
      agents: ["w1:p3", "w1:p4"].map((pane_id) => ({ pane_id, agent_status: "working", agent_session: agentSession })),
      matches: 2,
    },
    {
      name: "replaced",
      agents: [{ pane_id: "w1:p3", agent_status: "working", agent_session: replacementSession }],
      matches: 0,
    },
  ];

  for (const scenario of afterResumeCases) {
    const calls: any[] = [];
    let snapshots = 0;
    const request = async (method: string, params: any) => {
      calls.push({ method, params });
      if (method !== "session.snapshot") return {};
      snapshots += 1;
      return {
        snapshot: {
          agents: snapshots === 1
            ? [{ pane_id: "w1:p2", agent_status: "done", agent_session: agentSession }]
            : scenario.agents,
        },
      };
    };

    await assert.rejects(herdrDelivery({ request }).deliver({ agentSession }, {
      source: "github-pr",
      subject: "owner/repo#1",
      revision: "two",
      payload: null,
    }), new RegExp(`resolved to ${scenario.matches} live agents`), scenario.name);
    const prompts = calls.filter((call) => call.method === "agent.prompt");
    assert.equal(prompts.length, 1, `${scenario.name}: only native Goal resume may be sent`);
    assert.equal(prompts[0].params.text, "/goal resume");
  }
});

test("Herdr delivery sends no prompt for a missing or ambiguous native session", async () => {
  const agentSession = { source: "herdr:codex", agent: "codex", kind: "id", value: "session" };
  for (const matches of [0, 2]) {
    const calls: any[] = [];
    const request = async (method: string, params: any) => {
      calls.push({ method, params });
      return {
        snapshot: {
          agents: Array.from({ length: matches }, (_, index) => ({
            pane_id: `w1:p${index + 1}`,
            agent_status: "working",
            agent_session: agentSession,
          })),
        },
      };
    };
    await assert.rejects(herdrDelivery({ request }).deliver({ agentSession }, {
      source: "github-pr",
      subject: "owner/repo#1",
      revision: "two",
      payload: null,
    }), new RegExp(`resolved to ${matches} live agents`));
    assert.equal(calls.filter((call) => call.method === "agent.prompt").length, 0);
  }
});

test("Herdr delivery prompts a blocked session directly without resuming its Goal", async () => {
  const calls: any[] = [];
  const agentSession = { source: "herdr:codex", agent: "codex", kind: "id", value: "session" };
  const request = async (method: string, params: any) => {
    calls.push({ method, params });
    return {
      snapshot: {
        agents: [{ pane_id: "w1:p2", agent_status: "blocked", agent_session: agentSession }],
      },
    };
  };
  await herdrDelivery({ request }).deliver({ agentSession }, {
    source: "github-pr",
    subject: "owner/repo#1",
    revision: "two",
    payload: null,
  });

  const prompts = calls.filter((call) => call.method === "agent.prompt");
  assert.equal(prompts.length, 1);
  assert.doesNotMatch(prompts[0].params.text, /goal resume/);
  assert.match(prompts[0].params.text, /External state changed/);
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

test("changing the diagnostic destination makes an ongoing failure visible again", async () => {
  const directory = await mkdtemp(join(tmpdir(), "event-watchd-diagnostic-change-"));
  let revision = "one";
  const diagnostics: string[] = [];
  const service = new EventWatchService({
    statePath: join(directory, "state.json"),
    sources: { source: { read: async () => ({ revision, payload: null }) } },
    deliveries: {
      test: {
        deliver: async (target: any) => {
          if (target.name === "worker") throw new Error("worker unavailable");
          diagnostics.push(target.name);
        },
      },
    },
  });
  await service.setDiagnostics(destination("supervisor-one"));
  await service.watch({ source: "source", subject: "subject", destination: destination("worker"), intervalMs: 1_000 });
  revision = "two";
  await service.pollNow();
  await service.setDiagnostics(destination("supervisor-two"));
  await service.pollNow();

  assert.deepEqual(diagnostics, ["supervisor-one", "supervisor-two"]);
});
