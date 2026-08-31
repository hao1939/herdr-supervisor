import net from "node:net";
import { chmod, lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { MAX_FRAME_BYTES } from "./protocol.mjs";

function reply(socket, value) {
  if (socket.writable) socket.end(`${JSON.stringify(value)}\n`);
}

async function acquireLock(path) {
  let file;
  try {
    file = await open(path, "wx", 0o600);
    await file.writeFile(`${process.pid}\n`);
    await file.sync();
    return file;
  } catch (error) {
    if (file) {
      await file.close().catch(() => {});
      await unlink(path).catch(() => {});
    }
    if (error?.code !== "EEXIST") throw error;
    const owner = (await readFile(path, "utf8").catch(() => "unknown")).trim() || "unknown";
    throw new Error(`event-watchd lock is already owned by process ${owner}; the service manager must remove a stale lock`);
  }
}

function socketIsLive(path) {
  return new Promise((resolve) => {
    const socket = net.createConnection(path);
    const finish = (live) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(live);
    };
    const timer = setTimeout(() => finish(false), 500);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

export class EventWatchServer {
  constructor({ service, socketPath }) {
    this.service = service;
    this.socketPath = socketPath;
    this.sockets = new Set();
    this.requests = new Set();
    this.ownsSocket = false;
  }

  async start() {
    await mkdir(dirname(this.socketPath), { recursive: true });
    this.lockPath = `${this.socketPath}.lock`;
    this.lock = await acquireLock(this.lockPath);
    try {
      try {
        const current = await lstat(this.socketPath);
        if (!current.isSocket()) throw new Error(`refusing to replace non-socket ${this.socketPath}`);
        if (await socketIsLive(this.socketPath)) throw new Error("event-watchd socket is already live");
        await unlink(this.socketPath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      await this.service.start();
      this.serviceStarted = true;
      this.server = net.createServer((socket) => this.accept(socket));
      const previousMask = process.umask();
      process.umask(previousMask | 0o077);
      try {
        await new Promise((resolve, reject) => {
          const cleanup = () => {
            this.server.off("error", failed);
            this.server.off("listening", listening);
          };
          const failed = (error) => {
            cleanup();
            reject(error);
          };
          const listening = () => {
            cleanup();
            this.ownsSocket = true;
            resolve();
          };
          this.server.once("error", failed);
          this.server.once("listening", listening);
          this.server.listen(this.socketPath);
        });
      } finally {
        process.umask(previousMask);
      }
      await chmod(this.socketPath, 0o600);
    } catch (error) {
      if (this.server?.listening) {
        const closed = new Promise((resolve) => this.server.close(resolve));
        for (const socket of this.sockets) socket.destroy();
        await closed;
      }
      this.server = undefined;
      if (this.serviceStarted) {
        await this.service.stop().catch(() => {});
        this.serviceStarted = false;
      }
      if (this.ownsSocket) {
        await unlink(this.socketPath).catch((unlinkError) => {
          if (unlinkError?.code !== "ENOENT") throw unlinkError;
        });
        this.ownsSocket = false;
      }
      await this.releaseLock();
      throw error;
    }
  }

  accept(socket) {
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
    let buffer = "";
    let accepted = false;
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      if (accepted) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) return socket.destroy(new Error("frame too large"));
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      const remainder = buffer.slice(newline + 1);
      if (!line.trim() || remainder.trim()) return socket.destroy(new Error("one request is allowed per connection"));
      accepted = true;
      socket.pause();
      const request = this.handle(socket, line);
      this.requests.add(request);
      void request.then(
        () => this.requests.delete(request),
        () => this.requests.delete(request),
      );
    });
  }

  async handle(socket, line) {
    let request;
    try {
      request = JSON.parse(line);
      let result;
      if (request.action === "watch") result = await this.service.watch(request);
      else if (request.action === "read") result = await this.service.readCurrent(request);
      else if (request.action === "unwatch") result = await this.service.unwatch(request.watchId);
      else if (request.action === "list") result = await this.service.list(request);
      else if (request.action === "poll") result = await this.service.pollNow();
      else if (request.action === "diagnostics") result = await this.service.setDiagnostics(request.destination);
      else throw new Error(`unsupported action ${request.action}`);
      reply(socket, { id: request.id, ok: true, result: result ?? null });
    } catch (error) {
      reply(socket, { id: request?.id, ok: false, error: String(error instanceof Error ? error.message : error) });
    }
  }

  async stop() {
    const firstDrain = Promise.allSettled([Promise.resolve().then(() => this.service.stop())]);
    if (this.server?.listening) {
      const closed = new Promise((resolve) => this.server.close(resolve));
      for (const socket of this.sockets) socket.destroy();
      await closed;
    }
    await Promise.allSettled(this.requests);
    const drains = [
      ...await firstDrain,
      ...await Promise.allSettled([Promise.resolve().then(() => this.service.stop())]),
    ];
    this.server = undefined;
    if (this.ownsSocket) {
      await unlink(this.socketPath).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
      this.ownsSocket = false;
    }
    await this.releaseLock();
    this.serviceStarted = false;
    const failed = drains.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
  }

  async releaseLock() {
    await this.lock?.close().catch(() => {});
    this.lock = undefined;
    if (this.lockPath) {
      await unlink(this.lockPath).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    }
  }
}
