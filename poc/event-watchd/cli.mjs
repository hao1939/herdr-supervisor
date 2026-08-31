#!/usr/bin/env node
import net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { currentHerdrDestination } from "./herdr.mjs";

const socketPath = process.env.EVENT_WATCH_SOCKET
  || join(process.env.EVENT_WATCH_HOME || join(homedir(), ".local", "state", "event-watchd"), "event-watch.sock");

function request(message) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const id = `${process.pid}:${Date.now()}`;
    let buffer = "";
    socket.on("error", reject);
    socket.on("connect", () => socket.write(`${JSON.stringify({ id, ...message })}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const response = JSON.parse(buffer.slice(0, newline));
      socket.destroy();
      response.ok ? resolve(response.result) : reject(new Error(response.error));
    });
  });
}

const [command, ...args] = process.argv.slice(2);
let result;
if (command === "watch") {
  const [source, subject] = args;
  if (!source || !subject) throw new Error("usage: event-watch watch <source> <subject> [interval-ms]");
  result = await request({
    action: "watch",
    source,
    subject,
    intervalMs: args[2] ? Number(args[2]) : undefined,
    destination: await currentHerdrDestination(),
  });
} else if (command === "read") {
  const [source, subject] = args;
  if (!source || !subject) throw new Error("usage: event-watch read <source> <subject>");
  result = await request({ action: "read", source, subject });
} else if (command === "diagnostics") {
  result = await request({ action: "diagnostics", destination: await currentHerdrDestination() });
} else if (command === "unwatch") {
  result = await request({ action: "unwatch", watchId: args[0] });
} else if (command === "list") {
  result = await request({ action: "list" });
} else if (command === "poll") {
  result = await request({ action: "poll" });
} else {
  throw new Error("usage: event-watch <watch|read|diagnostics|unwatch|list|poll> ...");
}
console.log(JSON.stringify(result, null, 2));
