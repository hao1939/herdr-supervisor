import net from "node:net";
import { MAX_FRAME_BYTES } from "./protocol.mjs";
const DEFAULT_TIMEOUT_MS = 5_000;
const SOURCE_TIMEOUT_MS = 4 * 60 * 1_000;
const POLL_TIMEOUT_MS = 20 * 60 * 1_000;

export function eventWatchRequest(message, { socketPath, timeoutMs } = {}) {
  if (!socketPath) throw new Error("event watcher socket path is required");
  const requestTimeoutMs = timeoutMs ?? (
    message.action === "poll" ? POLL_TIMEOUT_MS
      : ["read", "watch"].includes(message.action) ? SOURCE_TIMEOUT_MS
        : DEFAULT_TIMEOUT_MS
  );
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const id = `${process.pid}:${Date.now()}:${Math.random()}`;
    let buffer = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error("event watcher request timed out")), requestTimeoutMs);
    socket.on("error", (error) => finish(error));
    socket.on("end", () => finish(new Error("event watcher connection ended without a response")));
    socket.on("close", () => finish(new Error("event watcher connection closed without a response")));
    socket.on("connect", () => socket.write(`${JSON.stringify({ id, ...message })}\n`));
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) {
        finish(new Error("event watcher response is too large"));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      let response;
      try {
        response = JSON.parse(buffer.slice(0, newline));
      } catch {
        finish(new Error("event watcher returned an invalid response"));
        return;
      }
      if (response.id !== id) {
        finish(new Error("event watcher returned a response with the wrong identity"));
      } else if (response.ok) {
        finish(undefined, response.result);
      } else {
        finish(new Error(response.error || "event watcher request failed"));
      }
    });
  });
}
