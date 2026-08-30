import net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function defaultSocketPath(env = process.env) {
  return env.HERDR_SOCKET_PATH || join(homedir(), ".config", "herdr", "herdr.sock");
}

function responseError(message) {
  const detail = message?.error?.message || message?.error?.code || "unknown Herdr error";
  return new Error(String(detail));
}

export class HerdrClient {
  socketPath: string;
  timeoutMs: number;
  nextId: number;

  constructor({ socketPath = defaultSocketPath(), timeoutMs = 3000 } = {}) {
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
    this.nextId = 0;
  }

  request(method, params = {}, timeoutMs = this.timeoutMs): Promise<any> {
    const id = `herdr-supervisor:${process.pid}:${++this.nextId}`;
    return new Promise((resolve, reject) => {
      let buffer = "";
      let settled = false;
      const socket = net.createConnection(this.socketPath);
      const finish = (error?, value?) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        error ? reject(error) : resolve(value);
      };
      const timer = setTimeout(() => finish(new Error(`Herdr ${method} timed out`)), timeoutMs);
      timer.unref?.();
      socket.on("error", (error) => finish(error));
      socket.on("close", () => finish(new Error(`Herdr ${method} connection closed`)));
      socket.on("connect", () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        for (;;) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) break;
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          let message;
          try { message = JSON.parse(line); } catch { continue; }
          if (message.id !== id) continue;
          if (message.error) finish(responseError(message));
          else finish(undefined, message.result);
        }
      });
    });
  }

  async snapshot() {
    const result = await this.request("session.snapshot", {});
    return result.snapshot;
  }

  async readAgent(paneId, lines = 80) {
    return this.request("agent.read", {
      target: paneId,
      source: "recent_unwrapped",
      format: "text",
      strip_ansi: true,
      lines,
    });
  }

  async promptAgent(paneId, text, wait?) {
    const timeoutMs = wait?.timeout_ms
      ? Math.max(this.timeoutMs, wait.timeout_ms + 1000)
      : this.timeoutMs;
    return this.request("agent.prompt", {
      target: paneId,
      text,
      ...(wait ? { wait } : {}),
    }, timeoutMs);
  }

  async splitPane({ paneId, direction = "right", cwd, focus = false }) {
    return this.request("pane.split", {
      target_pane_id: paneId,
      direction,
      cwd,
      focus,
    });
  }

  async createTab({ workspaceId, cwd, label, focus = false }) {
    return this.request("tab.create", {
      workspace_id: workspaceId,
      cwd,
      label,
      focus,
    });
  }

  async startAgent({ name, kind, paneId, args = [] }, timeoutMs = 31_000) {
    const serverTimeoutMs = Math.min(30_000, Math.max(1, timeoutMs - 100));
    return this.request("agent.start", {
      name,
      kind,
      pane_id: paneId,
      args,
      timeout_ms: serverTimeoutMs,
    }, timeoutMs);
  }

  async getAgent(paneId, timeoutMs = this.timeoutMs) {
    const result = await this.request("agent.get", { target: paneId }, timeoutMs);
    return result.agent;
  }

  async startAndWaitAgent(request, timeoutMs = 30_000, onStarted = () => {}) {
    const deadline = Date.now() + timeoutMs;
    await this.startAgent(request, timeoutMs);
    onStarted();
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Herdr agent ${request.paneId} did not become ready`);
      let agent;
      try {
        agent = await this.getAgent(request.paneId, remaining);
      } catch (error) {
        if (!/agent target .* not found/i.test(error?.message || "")) throw error;
      }
      if (agent?.interactive_ready) return agent;
      await wait(Math.min(200, Math.max(1, deadline - Date.now())));
    }
  }

  async waitForAgentSession(paneId, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Herdr agent ${paneId} did not report a native session`);
      let agent;
      try {
        agent = await this.getAgent(paneId, remaining);
      } catch (error) {
        if (!/agent target .* not found/i.test(error?.message || "")) throw error;
      }
      if (agent?.agent_session) return agent;
      await wait(Math.min(200, Math.max(1, deadline - Date.now())));
    }
  }

  subscribe(subscriptions, onEvent, onDisconnect: (error?) => void = () => {}, onReady = () => {}) {
    const id = `herdr-supervisor:subscribe:${process.pid}:${++this.nextId}`;
    let buffer = "";
    let stopped = false;
    let disconnected = false;
    let ready = false;
    const socket = net.createConnection(this.socketPath);
    const disconnect = (error) => {
      if (stopped || disconnected) return;
      disconnected = true;
      socket.destroy();
      onDisconnect(error);
    };
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id, method: "events.subscribe", params: { subscriptions } })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === id) {
          if (message.error) disconnect(responseError(message));
          else if (!ready) {
            ready = true;
            onReady();
          }
        } else if (message.event) {
          onEvent(message);
        }
      }
    });
    socket.on("error", disconnect);
    socket.on("close", () => disconnect(new Error("Herdr subscription closed")));
    return () => {
      stopped = true;
      socket.destroy();
    };
  }
}
