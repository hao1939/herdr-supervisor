#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { adoBuildSource } from "./ado-build.mjs";
import { adoPullRequestSource } from "./ado-pr.mjs";
import { ExternalEventWatcher } from "./core.mjs";
import { githubPullRequestSource } from "./github-pr.mjs";
import { canonicalActiveGoals, herdrGoalDelivery, herdrSupervisorDiagnostic } from "./herdr.mjs";
import { acquireWatcherLock } from "./process-lock.mjs";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

function list(name) {
  return String(process.env[name] || "").split(",").map((item) => item.trim()).filter(Boolean);
}

const githubRepositories = list("HERDR_WATCH_GITHUB_REPOSITORIES");
const adoDefinitions = list("HERDR_WATCH_ADO_DEFINITIONS");
const adoRepositories = list("HERDR_WATCH_ADO_REPOSITORIES");
const sources = {};
if (githubRepositories.length) sources["github-pr"] = githubPullRequestSource({ repositories: githubRepositories });
if (adoDefinitions.length) sources["ado-build"] = adoBuildSource({ definitions: adoDefinitions });
if (adoRepositories.length) sources["ado-pr"] = adoPullRequestSource({ repositories: adoRepositories });
const hasSources = Object.keys(sources).length > 0;
if (!hasSources) {
  throw new Error("configure HERDR_WATCH_GITHUB_REPOSITORIES, HERDR_WATCH_ADO_DEFINITIONS, or HERDR_WATCH_ADO_REPOSITORIES");
}

const stateHome = process.env.HERDR_WATCH_STATE_HOME || join(homedir(), ".local", "state", "herdr-supervisor");
const intervalMs = Number(process.env.HERDR_WATCH_INTERVAL_MS || 60_000);
if (!Number.isFinite(intervalMs) || intervalMs < 10_000 || intervalMs > MAX_TIMER_DELAY_MS) {
  throw new Error(`HERDR_WATCH_INTERVAL_MS must be between 10000 and ${MAX_TIMER_DELAY_MS}`);
}
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => controller.abort());
}

const statePath = join(stateHome, "external-events.json");
const releaseOwnership = await acquireWatcherLock(statePath);
try {
  const watcher = new ExternalEventWatcher({
    statePath,
    sources,
    deliver: herdrGoalDelivery(),
    activeGoals: canonicalActiveGoals,
    diagnose: herdrSupervisorDiagnostic(),
  });
  while (!controller.signal.aborted) {
    await watcher.runOnce();
    try {
      await delay(intervalMs, undefined, { signal: controller.signal });
    } catch (error) {
      if (error?.name !== "AbortError") throw error;
    }
  }
} finally {
  await releaseOwnership();
}
