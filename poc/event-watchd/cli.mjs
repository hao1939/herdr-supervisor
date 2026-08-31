#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { eventWatchRequest } from "./client.mjs";
import { currentHerdrDestination } from "./herdr.mjs";

const socketPath = process.env.EVENT_WATCH_SOCKET
  || join(process.env.EVENT_WATCH_HOME || join(homedir(), ".local", "state", "event-watchd"), "event-watch.sock");

function request(message) {
  return eventWatchRequest(message, { socketPath });
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
  result = await request({
    action: "list",
    cursor: args[0] || undefined,
    limit: args[1] ? Number(args[1]) : undefined,
  });
} else if (command === "poll") {
  result = await request({ action: "poll" });
} else {
  throw new Error("usage: event-watch <watch|read|diagnostics|unwatch|list|poll> ...");
}
console.log(JSON.stringify(result, null, 2));
