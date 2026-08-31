import net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadSupervisorGoals } from "../../src/goal-registry.ts";
import { identityMismatch } from "../../src/supervision.ts";

export function defaultHerdrSocket(env = process.env) {
  return env.HERDR_SOCKET_PATH || join(homedir(), ".config", "herdr", "herdr.sock");
}

export function herdrRequest(method, params = {}, {
  socketPath = defaultHerdrSocket(),
  timeoutMs = 5_000,
} = {}) {
  return new Promise((resolve, reject) => {
    const id = `event-watchd:${process.pid}:${Date.now()}:${Math.random()}`;
    const socket = net.createConnection(socketPath);
    let buffer = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`Herdr ${method} timed out`)), timeoutMs);
    socket.on("error", (error) => finish(error));
    socket.on("close", () => finish(new Error(`Herdr ${method} connection closed`)));
    socket.on("connect", () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id !== id) continue;
        if (message.error) finish(new Error(message.error.message || message.error.code || "Herdr request failed"));
        else finish(undefined, message.result);
      }
    });
  });
}

export function herdrGoalDelivery({
  goalsRoot,
  request = herdrRequest,
  ...options
} = {}) {
  return async (goalId, events) => {
    if (!Array.isArray(events) || !events.length) throw new Error("event delivery requires at least one resource change");
    const goals = await loadSupervisorGoals(goalsRoot);
    const binding = goals.active.find((goal) => goal.goalId === goalId);
    if (!binding) {
      if (goals.completed.some((goal) => goal.goalId === goalId)) return { ignored: "goal completed" };
      if (goals.errors.some((goal) => goal.goalId === goalId)) throw new Error("canonical goal state is unreadable");
      throw new Error("active canonical goal was not found");
    }
    const findExact = async () => {
      const result = await request("session.snapshot", {}, options);
      const matches = result.snapshot.agents.filter((agent) => !identityMismatch(binding, agent));
      if (matches.length !== 1) {
        throw new Error(`canonical goal worker resolved to ${matches.length} live native sessions`);
      }
      return matches[0];
    };
    let agent = await findExact();
    if (binding.agentSession.agent === "codex" && ["idle", "done"].includes(agent.agent_status)) {
      await request("agent.prompt", {
        target: agent.pane_id,
        text: "/goal resume",
        wait: { until: ["working"], timeout_ms: 10_000 },
      }, { ...options, timeoutMs: 12_000 });
      agent = await findExact();
      if (agent.agent_status !== "working") {
        throw new Error("exact worker settled again before event delivery");
      }
    }
    await request("agent.prompt", {
      target: agent.pane_id,
      text: [
        `External resources changed for goal ${goalId}:`,
        ...events.map((event) => `- ${event.source} ${event.subject}`),
        "Reread current provider authority, decide what the change means, and continue useful work toward the goal.",
        "This is only a wake hint, not completion proof.",
      ].join("\n"),
    }, options);
    return { paneId: agent.pane_id };
  };
}
