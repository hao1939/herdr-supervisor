import net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

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
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
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

function sameSession(left, right) {
  return left && right
    && left.source === right.source
    && left.agent === right.agent
    && left.kind === right.kind
    && left.value === right.value;
}

export function herdrDelivery(options = {}) {
  return {
    async deliver(target, event) {
      if (!target?.agentSession) throw new Error("Herdr destination requires agentSession");
      const result = await herdrRequest("session.snapshot", {}, options);
      const matches = result.snapshot.agents.filter((agent) => sameSession(agent.agent_session, target.agentSession));
      if (matches.length !== 1) {
        throw new Error(`exact Herdr agent session resolved to ${matches.length} live agents`);
      }
      const message = event.diagnostic
        ? `External event watcher needs diagnosis. ${event.payload.error}`
        : [
            `External state changed for ${event.source} ${event.subject}.`,
            "Reread the provider's current authoritative state, handle what changed, and continue your active goal.",
            "This notification is only a wake hint; do not treat its payload as completion proof.",
          ].join(" ");
      await herdrRequest("agent.prompt", { target: matches[0].pane_id, text: message }, options);
      return { paneId: matches[0].pane_id };
    },
  };
}

export async function currentHerdrDestination({ paneId = process.env.HERDR_PANE_ID, ...options } = {}) {
  if (!paneId) throw new Error("HERDR_PANE_ID is required to infer the current worker");
  const result = await herdrRequest("agent.get", { target: paneId }, options);
  const agent = result.agent;
  if (!agent?.agent_session) throw new Error("the current Herdr pane has no exact native agent session");
  return { adapter: "herdr", target: { agentSession: agent.agent_session } };
}
