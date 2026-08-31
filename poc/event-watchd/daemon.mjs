#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { adoBuildSource } from "./ado-build.mjs";
import { EventWatchService } from "./core.mjs";
import { githubPullRequestSource } from "./github-pr.mjs";
import { herdrDelivery } from "./herdr.mjs";
import { EventWatchServer } from "./server.mjs";

const stateHome = process.env.EVENT_WATCH_HOME || join(homedir(), ".local", "state", "event-watchd");
const socketPath = process.env.EVENT_WATCH_SOCKET || join(stateHome, "event-watch.sock");
const service = new EventWatchService({
  statePath: join(stateHome, "state.json"),
  sources: {
    "github-pr": githubPullRequestSource(),
    "ado-build": adoBuildSource(),
  },
  deliveries: { herdr: herdrDelivery() },
});
const server = new EventWatchServer({ service, socketPath });

await server.start();
console.log(`event-watchd listening on ${socketPath}`);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => void server.stop().finally(() => process.exit(0)));
}
