import { readFileSync } from "node:fs";

const MAX_EVENT_FACT_BYTES = 8 * 1024;
const linkedResourceKnowledge = readFileSync(
  new URL("./knowledge/linked-resource-change.md", import.meta.url),
  "utf8",
).trim();

function indented(value, prefix = "  ") {
  return value.split("\n").map((line) => `${prefix}${line}`).join("\n");
}

function observedResource(event) {
  const lines = [
    `Resource: ${event.source} ${event.subject}`,
    event.observedAt ? `Observed at: ${event.observedAt}` : undefined,
    event.revision ? `Revision: ${event.revision}` : undefined,
  ].filter(Boolean);
  if (event.payload === undefined) return lines.join("\n");
  const facts = JSON.stringify(event.payload, null, 2);
  lines.push(
    "Observed facts:",
    Buffer.byteLength(facts) <= MAX_EVENT_FACT_BYTES
      ? indented(facts)
      : `  Omitted because they exceed ${MAX_EVENT_FACT_BYTES} bytes; reread the provider.`,
  );
  return lines.join("\n");
}

export function workerEventMessage(goalId, events) {
  return [
    "External provider change",
    `Goal: ${goalId}`,
    "",
    "What event-watchd observed",
    ...events.flatMap((event, index) => [
      index ? "" : undefined,
      indented(observedResource(event)),
    ].filter(Boolean)),
    "",
    "Response knowledge",
    indented(linkedResourceKnowledge),
  ].join("\n");
}

export function watcherStartupMessage({ scopes, intervalMs, statePath }) {
  const configured = Object.entries(scopes)
    .filter(([, values]) => values.length)
    .map(([source, values]) => `  - ${source}: ${values.join(", ")}`);
  return [
    "event-watchd started",
    "",
    "Watching trusted scopes",
    ...configured,
    "",
    `Scan interval: ${intervalMs} ms`,
    `Checkpoint: ${statePath}`,
    "Delivery: linked resource -> durable goal ID -> exact current worker",
    "Failures: bounded diagnostic -> one Pi supervisor",
    "Proof: startup only; verify provider access, metadata, and one changed-resource delivery",
  ].join("\n");
}

export function watcherHelpMessage() {
  return [
    "event-watchd observes linked provider resources and notifies their exact supervised worker.",
    "",
    "Configure at least one trusted scope",
    "  HERDR_WATCH_GITHUB_REPOSITORIES=owner/repository",
    "  HERDR_WATCH_ADO_REPOSITORIES=organization/project/repository",
    "  HERDR_WATCH_ADO_DEFINITIONS=organization/project/definition-id",
    "",
    "Start from this checkout",
    "  HERDR_WATCH_GITHUB_REPOSITORIES=owner/repository npm run watch",
    "",
    "Link resources",
    "  PR description: ## Supervision followed by - Goal ID: <durable-goal-id>",
    "  ADO build tag: herdr-goal=<durable-goal-id>",
    "",
    "Startup proves configuration only. Verify provider access, exact metadata,",
    "and one changed resource reaching the exact worker before claiming success.",
    "Full guide: src/event-watcher/README.md",
  ].join("\n");
}
