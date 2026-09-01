import { loadSupervisorGoals } from "../goal-registry.ts";
import { HerdrClient } from "../herdr-client.ts";
import { identityMismatch } from "../supervision.ts";
import { withGoalActionLock } from "../goal-action-lock.mjs";
import { defaultGoalsRoot } from "../goal-store.ts";

const MAX_EVENT_FACT_BYTES = 8 * 1024;

function observedEvent(event) {
  const lines = [`- ${event.source} ${event.subject}`];
  if (event.payload === undefined) return lines;
  const facts = JSON.stringify(event.payload);
  if (Buffer.byteLength(facts) <= MAX_EVENT_FACT_BYTES) {
    lines.push(`  Observed facts: ${facts}`);
  } else {
    lines.push(`  Observed facts omitted because they exceed ${MAX_EVENT_FACT_BYTES} bytes; reread the provider.`);
  }
  return lines;
}

export function herdrRequest(method, params = {}, {
  socketPath,
  timeoutMs = 5_000,
} = {}) {
  const client = new HerdrClient({ ...(socketPath ? { socketPath } : {}), timeoutMs });
  return client.request(method, params, timeoutMs);
}

export async function canonicalActiveGoals(goalsRoot) {
  const goals = await loadSupervisorGoals(goalsRoot);
  if (goals.errors.length) {
    throw new Error(`canonical goal state is unreadable for ${goals.errors.map((goal) => goal.goalId).join(", ")}`);
  }
  return new Set(goals.active.map((goal) => goal.goalId));
}

export function herdrGoalDelivery({
  goalsRoot,
  request = herdrRequest,
  ...options
} = {}) {
  const root = goalsRoot || defaultGoalsRoot();
  return async (goalId, events) => withGoalActionLock(root, goalId, async () => {
    if (!Array.isArray(events) || !events.length) throw new Error("event delivery requires at least one resource change");
    const goals = await loadSupervisorGoals(root);
    const binding = goals.active.find((goal) => goal.goalId === goalId);
    if (!binding) {
      if (goals.completed.some((goal) => goal.goalId === goalId)) return { ignored: "goal completed" };
      if (goals.errors.some((goal) => goal.goalId === goalId)) throw new Error("canonical goal state is unreadable");
      throw new Error("active canonical goal was not found");
    }
    const findExact = async () => {
      const result = await request("session.snapshot", {}, options);
      const matches = result.snapshot.agents.filter((agent) => !identityMismatch(binding, agent));
      if (matches.length !== 1) {
        throw new Error(`canonical goal worker resolved to ${matches.length} live native sessions`);
      }
      return matches[0];
    };
    let agent = await findExact();
    if (binding.agentSession.agent === "codex" && ["idle", "done"].includes(agent.agent_status)) {
      await request("agent.prompt", {
        target: agent.pane_id,
        text: "/goal resume",
        wait: { until: ["working"], timeout_ms: 10_000 },
      }, { ...options, timeoutMs: 12_000 });
      agent = await findExact();
      if (agent.agent_status !== "working") {
        throw new Error("exact worker settled again before event delivery");
      }
    }
    await request("agent.prompt", {
      target: agent.pane_id,
      text: [
        `External resources changed for goal ${goalId}:`,
        ...events.flatMap(observedEvent),
        "Reread current provider authority, decide what the change means, and continue useful work toward the goal.",
        "Observed facts are only a bounded wake hint, not provider authority or completion proof.",
      ].join("\n"),
    }, options);
    return { paneId: agent.pane_id };
  });
}

export function herdrSupervisorDiagnostic({
  request = herdrRequest,
  ...options
} = {}) {
  return async (diagnostic) => {
    const result = await request("session.snapshot", {}, options);
    const supervisors = result.snapshot.agents.filter((agent) =>
      agent.agent === "pi" && agent.agent_session?.source === "herdr:pi");
    if (supervisors.length !== 1) {
      throw new Error(`expected one Pi supervisor, found ${supervisors.length}`);
    }
    const bounded = (value, limit = 2_000) => String(value || "").trim().slice(0, limit);
    const affected = Array.isArray(diagnostic?.affectedGoalIds)
      ? [...new Set(diagnostic.affectedGoalIds.map((goalId) => bounded(goalId, 200)).filter(Boolean))].slice(0, 20)
      : [];
    const facts = [
      diagnostic?.kind ? `Kind: ${bounded(diagnostic.kind, 100)}` : undefined,
      diagnostic?.source ? `Source: ${bounded(diagnostic.source, 200)}` : undefined,
      affected.length ? `Known affected goals: ${affected.join(", ")}` : "Known affected goals: not identified",
      `Observed failure: ${bounded(diagnostic?.message || "external event watcher failed")}`,
      diagnostic?.retry ? `Built-in retry: ${bounded(diagnostic.retry)}` : undefined,
    ].filter(Boolean);
    await request("agent.prompt", {
      target: supervisors[0].pane_id,
      text: [
        "External event watcher diagnostic:",
        ...facts,
        "Use current supervisor status and existing goal actions to keep affected goals moving. Let the stated built-in retry run; do not poll.",
        "Ask the human only for genuinely missing authority, configuration, or information. Do not claim to inspect or repair a service unless your tools provide that evidence.",
        "This is evidence, not a new goal and not completion proof.",
      ].join("\n"),
    }, options);
  };
}
