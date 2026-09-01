import assert from "node:assert/strict";
import net from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HerdrClient } from "../src/herdr-client.ts";

async function fakeHerdr(handler) {
  const directory = await mkdtemp(join(tmpdir(), "fake-herdr-"));
  const socketPath = join(directory, "herdr.sock");
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline >= 0) handler(JSON.parse(buffer.slice(0, newline)), socket);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return { socketPath, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("request correlates a newline-delimited Herdr response", async () => {
  const fake = await fakeHerdr((request, socket) => {
    socket.write(`${JSON.stringify({ id: "unrelated", result: {} })}\n`);
    socket.write(`${JSON.stringify({ id: request.id, result: { snapshot: { agents: [] } } })}\n`);
  });
  try {
    const client = new HerdrClient({ socketPath: fake.socketPath });
    assert.deepEqual(await client.snapshot(), { agents: [] });
  } finally { await fake.close(); }
});

test("request preserves Herdr's structured error code", async () => {
  const fake = await fakeHerdr((request, socket) => {
    socket.write(`${JSON.stringify({
      id: request.id,
      error: { code: "agent_not_found", message: "localized detail" },
    })}\n`);
  });
  try {
    const client = new HerdrClient({ socketPath: fake.socketPath });
    await assert.rejects(client.getAgent("w1:p2"), (error) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "localized detail");
      assert.equal(Reflect.get(error, "code"), "agent_not_found");
      return true;
    });
  } finally { await fake.close(); }
});

test("startAgent requests one exact agent session in an existing pane", async () => {
  let observed;
  const fake = await fakeHerdr((request, socket) => {
    observed = request;
    socket.write(`${JSON.stringify({ id: request.id, result: { type: "agent_started" } })}\n`);
  });
  try {
    const client = new HerdrClient({ socketPath: fake.socketPath });
    await client.startAgent({ name: "codex", kind: "codex", paneId: "w1:p2", args: ["resume", "session-1"] });
    assert.equal(observed.method, "agent.start");
    assert.deepEqual(observed.params, {
      name: "codex",
      kind: "codex",
      pane_id: "w1:p2",
      args: ["resume", "session-1"],
      timeout_ms: 30_000,
    });
  } finally {
    await fake.close();
  }
});

test("startAgent keeps the transport open for Herdr's start deadline", async (t) => {
  const client = new HerdrClient();
  let observed;
  t.mock.method(client, "request", async (method, params, timeoutMs) => {
    observed = { method, params, timeoutMs };
    return { type: "agent_started" };
  });
  await client.startAgent({ name: "codex", kind: "codex", paneId: "w1:p2" });
  assert.equal(observed.timeoutMs, 31_000);
  assert.equal(observed.params.timeout_ms, 30_000);
});

test("startAgent keeps a response margin inside a shorter caller deadline", async (t) => {
  const client = new HerdrClient();
  let observed;
  t.mock.method(client, "request", async (method, params, timeoutMs) => {
    observed = { method, params, timeoutMs };
    return { type: "agent_started" };
  });
  await client.startAgent({ name: "codex", kind: "codex", paneId: "w1:p2" }, 5_000);
  assert.equal(observed.timeoutMs, 5_000);
  assert.equal(observed.params.timeout_ms, 4_900);
});

test("promptAgent can atomically wait for the submitted prompt to start work", async () => {
  let observed;
  const fake = await fakeHerdr((request, socket) => {
    observed = request;
    socket.write(`${JSON.stringify({ id: request.id, result: { type: "agent_wait_matched" } })}\n`);
  });
  try {
    const client = new HerdrClient({ socketPath: fake.socketPath });
    await client.promptAgent("w1:p2", "/goal resume", {
      until: ["working"],
      timeout_ms: 5000,
    });
    assert.equal(observed.method, "agent.prompt");
    assert.deepEqual(observed.params, {
      target: "w1:p2",
      text: "/goal resume",
      wait: { until: ["working"], timeout_ms: 5000 },
    });
  } finally {
    await fake.close();
  }
});

test("promptAgent waits beyond the default transport timeout for an atomic wait", async () => {
  const fake = await fakeHerdr((request, socket) => {
    setTimeout(() => {
      socket.write(`${JSON.stringify({ id: request.id, result: { type: "agent_wait_matched" } })}\n`);
    }, 35);
  });
  try {
    const client = new HerdrClient({ socketPath: fake.socketPath, timeoutMs: 20 });
    // The 35 ms response exceeds the 20 ms transport timeout. A wait-aware
    // prompt must extend its own deadline instead of timing out.
    const result = await client.promptAgent("w1:p2", "/goal resume", {
      until: ["working"],
      timeout_ms: 30,
    });
    assert.equal(result.type, "agent_wait_matched");
  } finally {
    await fake.close();
  }
});

test("splitPane creates an unfocused sibling from an exact supervisor pane", async () => {
  let observed;
  const fake = await fakeHerdr((request, socket) => {
    observed = request;
    socket.write(`${JSON.stringify({
      id: request.id,
      result: { type: "pane_info", pane: { pane_id: "w1:p3" } },
    })}\n`);
  });
  try {
    const client = new HerdrClient({ socketPath: fake.socketPath });
    const result = await client.splitPane({
      paneId: "w1:p1",
      direction: "down",
      cwd: "/app/projects/example",
      focus: false,
    });
    assert.equal(result.pane.pane_id, "w1:p3");
    assert.equal(observed.method, "pane.split");
    assert.deepEqual(observed.params, {
      target_pane_id: "w1:p1",
      direction: "down",
      cwd: "/app/projects/example",
      focus: false,
    });
  } finally {
    await fake.close();
  }
});

test("createTab creates an unfocused related-work tab in one exact workspace", async () => {
  let observed;
  const fake = await fakeHerdr((request, socket) => {
    observed = request;
    socket.write(`${JSON.stringify({
      id: request.id,
      result: {
        type: "tab_created",
        tab: { tab_id: "w1:t2" },
        root_pane: { pane_id: "w1:p3", tab_id: "w1:t2" },
      },
    })}\n`);
  });
  try {
    const client = new HerdrClient({ socketPath: fake.socketPath });
    const result = await client.createTab({
      workspaceId: "w1",
      cwd: "/app/projects/example",
      label: "work: example",
      focus: false,
    });
    assert.equal(result.root_pane.pane_id, "w1:p3");
    assert.equal(observed.method, "tab.create");
    assert.deepEqual(observed.params, {
      workspace_id: "w1",
      cwd: "/app/projects/example",
      label: "work: example",
      focus: false,
    });
  } finally {
    await fake.close();
  }
});

test("pane display names keep their exact pane target", async (t) => {
  const client = new HerdrClient();
  const requests = [];
  t.mock.method(client, "request", async (method, params) => {
    requests.push({ method, params });
    return { type: "pane_info" };
  });

  await client.renamePane("w1:p2", "Validate Kubernetes versions");

  assert.deepEqual(requests, [
    {
      method: "pane.rename",
      params: { pane_id: "w1:p2", label: "Validate Kubernetes versions" },
    },
  ]);
});

test("closePane requests closure of one exact pane", async (t) => {
  const client = new HerdrClient();
  let observed;
  t.mock.method(client, "request", async (method, params) => {
    observed = { method, params };
    return { type: "pane_closed" };
  });

  await client.closePane("w1:p2");

  assert.deepEqual(observed, {
    method: "pane.close",
    params: { pane_id: "w1:p2" },
  });
});

test("startAndWaitAgent follows Herdr's bounded readiness handshake", async () => {
  let launched = false;
  let checks = 0;
  const fake = await fakeHerdr((request, socket) => {
    if (request.method === "agent.start") {
      launched = true;
      socket.write(`${JSON.stringify({ id: request.id, result: { type: "agent_started" } })}\n`);
    } else if (request.method === "agent.get") {
      checks += 1;
      socket.write(`${JSON.stringify({
        id: request.id,
        result: { agent: { pane_id: "w1:p2", interactive_ready: checks > 1 } },
      })}\n`);
    }
  });
  try {
    const client = new HerdrClient({ socketPath: fake.socketPath });
    let started = false;
    const agent = await client.startAndWaitAgent({
      name: "codex",
      kind: "codex",
      paneId: "w1:p2",
      args: ["resume", "session-1"],
    }, 30_000, () => { started = true; });
    assert.equal(agent.pane_id, "w1:p2");
    assert.equal(started, true);
    assert.equal(launched, true);
    assert.equal(checks, 2);
  } finally {
    await fake.close();
  }
});

test("startAndWaitAgent preserves Herdr's full launch allowance by default", async (t) => {
  const client = new HerdrClient();
  let launchTimeout;
  t.mock.method(client, "startAgent", async (_request, timeoutMs) => {
    launchTimeout = timeoutMs;
    return { type: "agent_started" };
  });
  t.mock.method(client, "getAgent", async () => ({ interactive_ready: true }));

  await client.startAndWaitAgent({ paneId: "w1:p2" });
  assert.equal(launchTimeout, 31_000);
});

test("startAndWaitAgent tolerates a brief missing-agent transition", async (t) => {
  const client = new HerdrClient();
  let reads = 0;
  t.mock.method(client, "startAgent", async () => ({ type: "agent_started" }));
  t.mock.method(client, "getAgent", async () => {
    reads += 1;
    if (reads === 1) {
      throw Object.assign(new Error("localized detail"), { code: "agent_not_found" });
    }
    return { pane_id: "w1:p2", interactive_ready: true };
  });
  const agent = await client.startAndWaitAgent({ paneId: "w1:p2" }, 1_000);
  assert.equal(agent.pane_id, "w1:p2");
  assert.equal(reads, 2);
});

test("startAndWaitAgent immediately rejects unrelated agent lookup errors", async (t) => {
  const client = new HerdrClient();
  const error = new Error("Herdr agent.get connection closed");
  t.mock.method(client, "startAgent", async () => ({ type: "agent_started" }));
  t.mock.method(client, "getAgent", async () => { throw error; });

  await assert.rejects(client.startAndWaitAgent({ paneId: "w1:p2" }), error);
});

test("startAndWaitAgent shares one deterministic launch and readiness deadline", async (t) => {
  const client = new HerdrClient();
  let now = 1_000;
  let readinessTimeout;
  t.mock.method(Date, "now", () => now);
  t.mock.method(client, "startAgent", async (_request, timeoutMs) => {
    assert.equal(timeoutMs, 1_000);
    now += 400;
    return { type: "agent_started" };
  });
  t.mock.method(client, "getAgent", async (_paneId, timeoutMs) => {
    readinessTimeout = timeoutMs;
    now += timeoutMs;
    throw Object.assign(new Error("localized detail"), { code: "agent_not_found" });
  });

  await assert.rejects(
    client.startAndWaitAgent({ paneId: "w1:p2" }, 1_000),
    /did not become ready/,
  );
  assert.equal(readinessTimeout, 600);
  assert.equal(now, 2_000);
});

test("native session discovery tolerates a brief missing-agent transition", async (t) => {
  const client = new HerdrClient();
  let reads = 0;
  t.mock.method(client, "getAgent", async () => {
    reads += 1;
    if (reads === 1) {
      throw Object.assign(new Error("localized detail"), { code: "agent_not_found" });
    }
    return { pane_id: "w1:p2", agent_session: { value: "session-1" } };
  });
  const agent = await client.waitForAgentSession("w1:p2", 1_000);
  assert.equal(agent.agent_session.value, "session-1");
  assert.equal(reads, 2);
});

test("native session discovery stops at its original deadline", async (t) => {
  const client = new HerdrClient();
  let now = 1_000;
  let lookupTimeout;
  t.mock.method(Date, "now", () => now);
  t.mock.method(client, "getAgent", async (_paneId, timeoutMs) => {
    lookupTimeout = timeoutMs;
    now += timeoutMs;
    throw Object.assign(new Error("localized detail"), { code: "agent_not_found" });
  });

  await assert.rejects(
    client.waitForAgentSession("w1:p2", 1_000),
    /did not report a native session/,
  );
  assert.equal(lookupTimeout, 1_000);
  assert.equal(now, 2_000);
});

test("native session discovery immediately rejects unrelated agent lookup errors", async (t) => {
  const client = new HerdrClient();
  const error = new Error("Herdr agent.get connection closed");
  t.mock.method(client, "getAgent", async () => { throw error; });

  await assert.rejects(client.waitForAgentSession("w1:p2"), error);
});

test("subscription returns immediately and forwards events", async () => {
  let eventResolve;
  const received = new Promise((resolve) => { eventResolve = resolve; });
  let readyResolve;
  const ready = new Promise((resolve) => { readyResolve = resolve; });
  let readyCount = 0;
  const fake = await fakeHerdr((request, socket) => {
    socket.write(`${JSON.stringify({ id: request.id, result: { type: "subscription_started" } })}\n`);
    socket.write(`${JSON.stringify({ event: "pane.agent_status_changed", data: { pane_id: "w1:p2", agent_status: "idle" } })}\n`);
  });
  const client = new HerdrClient({ socketPath: fake.socketPath });
  const stop = client.subscribe(
    [{ type: "pane.agent_status_changed", pane_id: "w1:p2" }],
    eventResolve,
    undefined,
    () => {
      readyCount += 1;
      readyResolve();
    },
  );
  try {
    await ready;
    assert.equal(readyCount, 1);
    assert.equal((await received as any).data.agent_status, "idle");
  } finally {
    stop();
    await fake.close();
  }
});

test("subscription reports one disconnect after it was ready", async () => {
  let disconnectResolve;
  const disconnected = new Promise((resolve) => { disconnectResolve = resolve; });
  const fake = await fakeHerdr((request, socket) => {
    socket.write(`${JSON.stringify({ id: request.id, result: { type: "subscription_started" } })}\n`);
    socket.end();
  });
  const client = new HerdrClient({ socketPath: fake.socketPath });
  let disconnectCount = 0;
  const stop = client.subscribe([], () => {}, () => {
    disconnectCount += 1;
    disconnectResolve();
  });
  try {
    await disconnected;
    assert.equal(disconnectCount, 1);
  } finally {
    stop();
    await fake.close();
  }
});
