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
