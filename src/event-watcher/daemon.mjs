#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { adoBuildDiscovery } from "./ado-build.mjs";
import { MetadataEventWatcher } from "./core.mjs";
import { githubPullRequestDiscovery } from "./github-pr.mjs";
import { canonicalActiveGoals, herdrGoalDelivery, herdrSupervisorDiagnostic } from "./herdr.mjs";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

function list(name) {
  return String(process.env[name] || "").split(",").map((item) => item.trim()).filter(Boolean);
}

const githubRepositories = list("HERDR_WATCH_GITHUB_REPOSITORIES");
const adoDefinitions = list("HERDR_WATCH_ADO_DEFINITIONS");
const sources = {};
if (githubRepositories.length) sources["github-pr"] = githubPullRequestDiscovery({ repositories: githubRepositories });
if (adoDefinitions.length) sources["ado-build"] = adoBuildDiscovery({ definitions: adoDefinitions });
const hasSources = Object.keys(sources).length > 0;
if (!hasSources) {
  throw new Error("configure HERDR_WATCH_GITHUB_REPOSITORIES or HERDR_WATCH_ADO_DEFINITIONS");
}

const stateHome = process.env.HERDR_WATCH_STATE_HOME || join(homedir(), ".local", "state", "herdr-supervisor");
const intervalMs = Number(process.env.HERDR_WATCH_INTERVAL_MS || 60_000);
if (!Number.isFinite(intervalMs) || intervalMs < 10_000 || intervalMs > MAX_TIMER_DELAY_MS) {
  throw new Error(`HERDR_WATCH_INTERVAL_MS must be between 10000 and ${MAX_TIMER_DELAY_MS}`);
}
const watcher = new MetadataEventWatcher({
  statePath: join(stateHome, "external-events.json"),
  sources,
  deliver: herdrGoalDelivery(),
  activeGoals: canonicalActiveGoals,
  diagnose: herdrSupervisorDiagnostic(),
});

const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => controller.abort());
}

while (!controller.signal.aborted) {
  await watcher.runOnce();
  try {
    await delay(intervalMs, undefined, { signal: controller.signal });
  } catch (error) {
    if (error?.name !== "AbortError") throw error;
  }
}
