import net from "node:net";
import { chmod, lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";

const MAX_FRAME = 64 * 1024;

function reply(socket, value) {
  if (socket.writable) socket.write(`${JSON.stringify(value)}\n`);
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
      this.server = net.createServer((socket) => this.accept(socket));
      await new Promise((resolve, reject) => {
        this.server.once("error", reject);
        this.server.listen(this.socketPath, resolve);
      });
      await chmod(this.socketPath, 0o600);
      await this.service.start();
    } catch (error) {
      if (this.server?.listening) {
        await new Promise((resolve) => this.server.close(resolve));
      }
      this.server = undefined;
      await unlink(this.socketPath).catch((unlinkError) => {
        if (unlinkError?.code !== "ENOENT") throw unlinkError;
      });
      await this.releaseLock();
      throw error;
    }
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
      else if (request.action === "read") result = await this.service.readCurrent(request);
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
    if (this.server?.listening) await new Promise((resolve) => this.server.close(resolve));
    this.server = undefined;
    await unlink(this.socketPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    await this.releaseLock();
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
