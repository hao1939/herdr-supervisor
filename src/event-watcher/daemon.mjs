#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { adoBuildSource } from "./ado-build.mjs";
import { adoPullRequestSource } from "./ado-pr.mjs";
import { ExternalEventWatcher } from "./core.mjs";
import { githubPullRequestSource } from "./github-pr.mjs";
import { canonicalActiveGoals, herdrGoalDelivery, herdrSupervisorDiagnostic } from "./herdr.mjs";
import { watcherHelpMessage, watcherStartupMessage } from "./messages.mjs";
import { acquireWatcherLock } from "./process-lock.mjs";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  await new Promise((resolve, reject) => {
    process.stdout.write(`${watcherHelpMessage()}\n`, (error) => error ? reject(error) : resolve());
  });
  process.exit(0);
}

function list(name) {
  return String(process.env[name] || "").split(",").map((item) => item.trim()).filter(Boolean);
}

const githubRepositories = list("HERDR_WATCH_GITHUB_REPOSITORIES");
const adoDefinitions = list("HERDR_WATCH_ADO_DEFINITIONS");
const adoRepositories = list("HERDR_WATCH_ADO_REPOSITORIES");
const adoCreatorId = String(process.env.HERDR_WATCH_ADO_CREATOR_ID || "").trim() || undefined;
const sources = {};
if (githubRepositories.length) sources["github-pr"] = githubPullRequestSource({ repositories: githubRepositories });
if (adoDefinitions.length) sources["ado-build"] = adoBuildSource({ definitions: adoDefinitions });
if (adoRepositories.length) {
  sources["ado-pr"] = adoPullRequestSource({ repositories: adoRepositories, creatorId: adoCreatorId });
}
const hasSources = Object.keys(sources).length > 0;
if (!hasSources) {
  throw new Error(`no trusted provider scope configured\n\n${watcherHelpMessage()}`);
}

const stateHome = process.env.HERDR_WATCH_STATE_HOME || join(homedir(), ".local", "state", "herdr-supervisor");
const intervalMs = Number(process.env.HERDR_WATCH_INTERVAL_MS || 60_000);
if (!Number.isFinite(intervalMs) || intervalMs < 10_000 || intervalMs > MAX_TIMER_DELAY_MS) {
  throw new Error(`HERDR_WATCH_INTERVAL_MS must be between 10000 and ${MAX_TIMER_DELAY_MS}`);
}
const staleAfterMs = Number(process.env.HERDR_WATCH_STALE_AFTER_MS || 24 * 60 * 60_000);
if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs < 0) {
  throw new Error("HERDR_WATCH_STALE_AFTER_MS must be a non-negative integer");
}
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => controller.abort());
}

const statePath = join(stateHome, "external-events.json");
const releaseOwnership = await acquireWatcherLock(statePath);
try {
  console.error(watcherStartupMessage({
    scopes: {
      "github-pr": githubRepositories,
      "ado-pr": adoRepositories.map((repository) =>
        adoCreatorId ? `${repository} (creator ${adoCreatorId})` : repository),
      "ado-build": adoDefinitions,
    },
    intervalMs,
    staleAfterMs,
    statePath,
  }));
  const watcher = new ExternalEventWatcher({
    statePath,
    sources,
    deliver: herdrGoalDelivery(),
    activeGoals: canonicalActiveGoals,
    diagnose: herdrSupervisorDiagnostic(),
    staleAfterMs,
  });
  while (!controller.signal.aborted) {
    try {
      await watcher.runOnce(controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) throw error;
      break;
    }
    try {
      await delay(intervalMs, undefined, { signal: controller.signal });
    } catch (error) {
      if (error?.name !== "AbortError") throw error;
    }
  }
} finally {
  await releaseOwnership();
}
