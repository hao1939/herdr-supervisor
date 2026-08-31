import net from "node:net";

const MAX_FRAME = 64 * 1024;

export function eventWatchRequest(message, { socketPath, timeoutMs = 5_000 } = {}) {
  if (!socketPath) throw new Error("event watcher socket path is required");
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
    const timer = setTimeout(() => finish(new Error("event watcher request timed out")), timeoutMs);
    socket.on("error", (error) => finish(error));
    socket.on("end", () => finish(new Error("event watcher connection ended without a response")));
    socket.on("close", () => finish(new Error("event watcher connection closed without a response")));
    socket.on("connect", () => socket.write(`${JSON.stringify({ id, ...message })}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer) > MAX_FRAME) {
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
