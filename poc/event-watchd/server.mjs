import net from "node:net";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";

const MAX_FRAME = 64 * 1024;

function reply(socket, value) {
  if (socket.writable) socket.write(`${JSON.stringify(value)}\n`);
}

export class EventWatchServer {
  constructor({ service, socketPath }) {
    this.service = service;
    this.socketPath = socketPath;
  }

  async start() {
    await mkdir(dirname(this.socketPath), { recursive: true });
    try {
      const current = await lstat(this.socketPath);
      if (!current.isSocket()) throw new Error(`refusing to replace non-socket ${this.socketPath}`);
      await unlink(this.socketPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    this.server = net.createServer((socket) => this.accept(socket));
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.socketPath, resolve);
    });
    await chmod(this.socketPath, 0o600);
    await this.service.start();
  }

  accept(socket) {
    let buffer = "";
    let requests = Promise.resolve();
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        if (Buffer.byteLength(line) > MAX_FRAME) return socket.destroy(new Error("frame too large"));
        requests = requests.then(() => this.handle(socket, line));
      }
      if (Buffer.byteLength(buffer) > MAX_FRAME) socket.destroy(new Error("frame too large"));
    });
  }

  async handle(socket, line) {
    let request;
    try {
      request = JSON.parse(line);
      let result;
      if (request.action === "watch") result = await this.service.watch(request);
      else if (request.action === "unwatch") result = await this.service.unwatch(request.watchId);
      else if (request.action === "list") result = await this.service.status();
      else if (request.action === "poll") result = await this.service.pollNow();
      else if (request.action === "diagnostics") result = await this.service.setDiagnostics(request.destination);
      else throw new Error(`unsupported action ${request.action}`);
      reply(socket, { id: request.id, ok: true, result: result ?? null });
    } catch (error) {
      reply(socket, { id: request?.id, ok: false, error: String(error instanceof Error ? error.message : error) });
    }
  }

  async stop() {
    this.service.stop();
    if (this.server) await new Promise((resolve) => this.server.close(resolve));
    await unlink(this.socketPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}
