#!/usr/bin/env node
import { HerdrClient } from "../src/herdr-client.js";
import { loadSupervisorGoals } from "../src/goal-registry.js";
import { formatWorker, liveWorker } from "../src/supervision.js";

function usage(error) {
  if (error) console.error(`Error: ${error}\n`);
  console.error(`Usage:
  herdr-supervisor workers
  herdr-supervisor status`);
  process.exitCode = 2;
}

const [command] = process.argv.slice(2);
const client = new HerdrClient();

try {
  if (command === "workers") {
    const snapshot = await client.snapshot();
    if (!snapshot.agents.length) console.log("No observable workers.");
    for (const agent of snapshot.agents) {
      console.log(`${agent.pane_id} · ${agent.agent} · ${agent.agent_status} · ${agent.foreground_cwd || agent.cwd || "unknown directory"}`);
    }
  } else if (command === "status") {
    const [goals, snapshot] = await Promise.all([loadSupervisorGoals(), client.snapshot()]);
    if (!goals.active.length) console.log("No supervised workers.");
    else console.log(goals.active.map((binding) => formatWorker(liveWorker(binding, snapshot))).join("\n\n"));
    if (goals.unstarted.length) console.log(`\n${goals.unstarted.length} portable goal contract(s) have no local worker yet.`);
    if (goals.errors.length) console.log(`\nNeeds repair: ${goals.errors.map((record) => record.goalId).join(", ")}.`);
  } else {
    usage();
  }
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
}
