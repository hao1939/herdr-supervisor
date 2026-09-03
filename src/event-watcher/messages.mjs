import { readFileSync } from "node:fs";

const MAX_EVENT_FACT_BYTES = 8 * 1024;
const linkedResourceKnowledge = readFileSync(
  new URL("./knowledge/linked-resource-change.md", import.meta.url),
  "utf8",
).trim();
const watcherDiagnosticKnowledge = readFileSync(
  new URL("./knowledge/watcher-diagnostic.md", import.meta.url),
  "utf8",
).trim();

export const eventMessageContract = "event-watchd/v1";

function indented(value, prefix = "  ") {
  return value.split("\n").map((line) => `${prefix}${line}`).join("\n");
}

function observedResource(event, index) {
  const lines = [
    `Resource ${index + 1}`,
    `  Source: ${event.source}`,
    `  Subject: ${event.subject}`,
    event.observedAt ? `  Observed at: ${event.observedAt}` : undefined,
    event.revision ? `  Revision: ${event.revision}` : undefined,
  ].filter(Boolean);
  if (event.payload === undefined) return lines.join("\n");
  const facts = JSON.stringify(event.payload, null, 2);
  lines.push(
    "  Observed facts:",
    Buffer.byteLength(facts) <= MAX_EVENT_FACT_BYTES
      ? indented(facts, "    ")
      : `    Omitted because they exceed ${MAX_EVENT_FACT_BYTES} bytes; reread the provider.`,
  );
  return lines.join("\n");
}

function eventMessage({ event, recipient, facts, knowledge }) {
  return [
    `[${eventMessageContract}]`,
    `Event: ${event}`,
    `Recipient role: ${recipient}`,
    "",
    "Event facts",
    indented(facts),
    "",
    "Agent response knowledge",
    indented(knowledge),
  ].join("\n");
}

export function workerEventMessage(goalId, events) {
  return eventMessage({
    event: "linked-resource-change",
    recipient: "goal-worker",
    facts: [
      `Goal ID: ${goalId}`,
      `Resource count: ${events.length}`,
      ...events.flatMap((observed, index) => [
        index ? "" : undefined,
        observedResource(observed, index),
      ].filter(Boolean)),
    ].join("\n"),
    knowledge: linkedResourceKnowledge,
  });
}

function bounded(value, limit = 2_000) {
  return String(value || "").trim().slice(0, limit);
}

export function supervisorDiagnosticMessage(diagnostic) {
  const affected = Array.isArray(diagnostic?.affectedGoalIds)
    ? [...new Set(diagnostic.affectedGoalIds.map((goalId) => bounded(goalId, 200)).filter(Boolean))].slice(0, 20)
    : [];
  return eventMessage({
    event: "watcher-diagnostic",
    recipient: "supervisor",
    facts: [
      diagnostic?.kind ? `Failure kind: ${bounded(diagnostic.kind, 100)}` : undefined,
      diagnostic?.source ? `Source: ${bounded(diagnostic.source, 200)}` : undefined,
      affected.length ? `Affected Goal IDs: ${affected.join(", ")}` : "Affected Goal IDs: not identified",
      `Observed failure: ${bounded(diagnostic?.message || "external event watcher failed")}`,
      diagnostic?.retry ? `Built-in retry: ${bounded(diagnostic.retry)}` : undefined,
    ].filter(Boolean).join("\n"),
    knowledge: watcherDiagnosticKnowledge,
  });
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
