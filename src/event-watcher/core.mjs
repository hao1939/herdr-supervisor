import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { atomicReplaceFile } from "../atomic-file.ts";

const VERSION = 1;
const GOAL_ID = /^g_[a-zA-Z0-9_-]+$/;
const MAX_TEXT = 2_000;
const MAX_PAYLOAD_BYTES = 16 * 1024;
const MAX_SCAN_RESULTS = 500;
const MAX_SCAN_WARNINGS = 10;
const DEFAULT_MAX_RESOURCES = 1024;
const MAX_EVENTS_PER_DELIVERY = 20;
const SOURCE_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
const PENDING_EVENT_KINDS = new Set(["change", "stale"]);

function requiredText(value, name) {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_TEXT) {
    throw new Error(`${name} must be a non-empty string no longer than ${MAX_TEXT} characters`);
  }
  return value.trim();
}

function boundedPayload(value) {
  const encoded = JSON.stringify(value ?? null);
  if (Buffer.byteLength(encoded) > MAX_PAYLOAD_BYTES) {
    throw new Error(`observation payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
  }
  return JSON.parse(encoded);
}

function observation(source, value, now) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${source} returned an invalid observation`);
  }
  const goalId = requiredText(value.goalId, "observation goalId");
  if (!GOAL_ID.test(goalId)) throw new Error("observation goalId is invalid");
  return {
    source,
    subject: requiredText(value.subject, "observation subject"),
    goalId,
    revision: requiredText(value.revision, "observation revision"),
    payload: boundedPayload(value.payload),
    observedAt: now,
  };
}

function keyFor(source, subject) {
  return `${source}\0${subject}`;
}

function emptyState() {
  return { version: VERSION, resources: {} };
}

function validateState(value, maxResources) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.version !== VERSION || !value.resources || typeof value.resources !== "object"
    || Array.isArray(value.resources)) {
    throw new Error("event watcher state is invalid or unsupported");
  }
  const entries = Object.entries(value.resources);
  if (entries.length > maxResources) throw new Error("event watcher state exceeds its resource limit");
  for (const [key, resource] of entries) {
    if (!resource || typeof resource !== "object" || Array.isArray(resource)) {
      throw new Error("event watcher resource is invalid");
    }
    const source = requiredText(resource.source, "resource source");
    const subject = requiredText(resource.subject, "resource subject");
    if (key !== keyFor(source, subject)) throw new Error("event watcher resource identity is invalid");
    if (!GOAL_ID.test(requiredText(resource.goalId, "resource goalId"))) {
      throw new Error("event watcher resource goalId is invalid");
    }
    requiredText(resource.revision, "resource revision");
    requiredText(resource.observedAt, "resource observedAt");
    if (!Number.isFinite(Date.parse(resource.observedAt))) {
      throw new Error("resource observedAt must be an ISO timestamp");
    }
    if (resource.staleNotified !== undefined && resource.staleNotified !== true) {
      throw new Error("resource stale notification marker is invalid");
    }
    if (resource.pending !== undefined) {
      const pending = resource.pending;
      if (!pending || typeof pending !== "object" || Array.isArray(pending)
        || pending.goalId !== resource.goalId || pending.revision !== resource.revision) {
        throw new Error("event watcher pending delivery is invalid");
      }
      const event = pending.event || "change";
      if (!PENDING_EVENT_KINDS.has(event)) throw new Error("event watcher pending event kind is invalid");
      if (event === "stale") {
        requiredText(pending.triggeredAt, "stale event triggeredAt");
        if (!Number.isFinite(Date.parse(pending.triggeredAt))) {
          throw new Error("stale event triggeredAt must be an ISO timestamp");
        }
        if (!Number.isSafeInteger(pending.staleAfterMs) || pending.staleAfterMs <= 0) {
          throw new Error("stale event threshold must be a positive integer");
        }
      }
      boundedPayload(pending.payload);
    }
  }
  return value;
}

async function load(path, maxResources) {
  try {
    return validateState(JSON.parse(await readFile(path, "utf8")), maxResources);
  } catch (error) {
    if (error?.code === "ENOENT") return emptyState();
    throw error;
  }
}

async function save(path, state) {
  await mkdir(dirname(path), { recursive: true });
  await atomicReplaceFile(path, `${JSON.stringify(state, null, 2)}\n`);
}

function storeObservation(state, item, maxResources) {
  const key = keyFor(item.source, item.subject);
  const current = state.resources[key];
  if (current?.goalId === item.goalId && current.revision === item.revision) {
    return { stored: true, changed: false };
  }
  if (!current && Object.keys(state.resources).length >= maxResources) {
    return { stored: false, changed: false };
  }
  state.resources[key] = {
    source: item.source,
    subject: item.subject,
    goalId: item.goalId,
    revision: item.revision,
    observedAt: item.observedAt,
    pending: {
      event: "change",
      goalId: item.goalId,
      revision: item.revision,
      payload: item.payload,
    },
  };
  return { stored: true, changed: true };
}

// Source adapters return goal-addressed resource observations only. This core
// owns revision comparison and calls the injected delivery boundary; adapters
// never resolve or contact workers.
export class ExternalEventWatcher {
  constructor({
    statePath,
    sources,
    deliver,
    activeGoals,
    diagnose = (diagnostic) => console.error(diagnostic.message),
    now = () => new Date(),
    maxResources = DEFAULT_MAX_RESOURCES,
    staleAfterMs = 0,
  }) {
    if (!statePath || !sources || typeof deliver !== "function"
      || (activeGoals !== undefined && typeof activeGoals !== "function")) {
      throw new Error("statePath, sources, and deliver are required; activeGoals must be a function");
    }
    if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs < 0) {
      throw new Error("staleAfterMs must be a non-negative integer");
    }
    this.statePath = statePath;
    this.sources = sources;
    this.deliver = deliver;
    this.activeGoals = activeGoals;
    this.diagnose = diagnose;
    this.now = now;
    this.maxResources = maxResources;
    this.staleAfterMs = staleAfterMs;
    this.ready = load(statePath, maxResources).then((state) => { this.state = state; });
    this.runs = Promise.resolve();
    this.reported = new Set();
    this.sourceFailures = new Map();
  }

  async report(key, diagnostic) {
    if (this.reported.has(key)) return;
    try {
      await this.diagnose({ ...diagnostic, observedAt: this.now().toISOString() });
      this.reported.add(key);
    } catch (error) {
      console.error(`event watcher diagnostic delivery failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  async scan(signal) {
    signal?.throwIfAborted();
    const found = [];
    const absent = [];
    for (const [source, adapter] of Object.entries(this.sources)) {
      signal?.throwIfAborted();
      const failure = this.sourceFailures.get(source);
      if (failure && this.now().getTime() < failure.retryAt) continue;
      const known = Object.values(this.state.resources)
        .filter((resource) => resource.source === source)
        .map((resource) => ({
          subject: resource.subject,
          goalId: resource.goalId,
          revision: resource.revision,
          pending: Boolean(resource.pending),
        }));
      try {
        const result = await adapter.scan(known, { signal });
        signal?.throwIfAborted();
        if (!result || typeof result !== "object" || Array.isArray(result)
          || !Array.isArray(result.observations) || !Array.isArray(result.absent)
          || (result.warnings !== undefined && !Array.isArray(result.warnings))) {
          throw new Error(`${source} scan returned an invalid result`);
        }
        const values = result.observations;
        if (values.length > MAX_SCAN_RESULTS) {
          throw new Error(`${source} scan must return at most ${MAX_SCAN_RESULTS} observations`);
        }
        if (found.length + values.length > this.maxResources) {
          throw new Error(`${source} observations exceed the shared ${this.maxResources}-resource limit`);
        }
        const seen = new Set();
        const at = this.now().toISOString();
        const normalized = [];
        for (const value of values) {
          const item = observation(source, value, at);
          const key = keyFor(item.source, item.subject);
          if (seen.has(key)) throw new Error(`${source} returned duplicate subject ${item.subject}`);
          seen.add(key);
          normalized.push(item);
        }
        const knownSubjects = new Set(known.map((resource) => resource.subject));
        const missing = new Set();
        for (const value of result.absent) {
          const subject = requiredText(value, "absent subject");
          if (!knownSubjects.has(subject)) throw new Error(`${source} returned unknown absent subject ${subject}`);
          if (missing.has(subject)) throw new Error(`${source} returned duplicate absent subject ${subject}`);
          if (seen.has(keyFor(source, subject))) {
            throw new Error(`${source} returned ${subject} as both observed and absent`);
          }
          missing.add(subject);
        }
        const warnings = result.warnings || [];
        if (warnings.length > MAX_SCAN_WARNINGS) {
          throw new Error(`${source} scan must return at most ${MAX_SCAN_WARNINGS} warnings`);
        }
        const warningKeys = new Set();
        for (const warning of warnings) {
          if (!warning || typeof warning !== "object" || Array.isArray(warning)) {
            throw new Error(`${source} returned an invalid warning`);
          }
          const code = requiredText(warning.code, "warning code");
          const key = `warning:${source}:${code}`;
          if (warningKeys.has(key)) throw new Error(`${source} returned duplicate warning ${code}`);
          warningKeys.add(key);
          await this.report(key, {
            kind: "source-warning",
            source,
            affectedGoalIds: [...new Set([
              ...known.map((resource) => resource.goalId),
              ...normalized.map((item) => item.goalId),
            ])].slice(0, 20),
            retry: "The watcher will continue its bounded scans while the supervisor considers this condition.",
            message: requiredText(warning.message, "warning message"),
          });
        }
        for (const key of this.reported) {
          if (key.startsWith(`warning:${source}:`) && !warningKeys.has(key)) this.reported.delete(key);
        }
        found.push(...normalized);
        absent.push(...[...missing].map((subject) => keyFor(source, subject)));
        this.sourceFailures.delete(source);
        this.reported.delete(`source:${source}`);
      } catch (error) {
        signal?.throwIfAborted();
        const failures = (failure?.failures || 0) + 1;
        const delay = SOURCE_RETRY_DELAYS_MS[Math.min(failures - 1, SOURCE_RETRY_DELAYS_MS.length - 1)];
        const retryAt = this.now().getTime() + delay;
        this.sourceFailures.set(source, { failures, retryAt });
        this.reported.delete(`source:${source}`);
        await this.report(`source:${source}`, {
          kind: "source",
          source,
          affectedGoalIds: [...new Set(known.map((resource) => resource.goalId))].slice(0, 20),
          retry: `The watcher will retry this provider scope no earlier than ${new Date(retryAt).toISOString()}; repeated failures use bounded backoff.`,
          message: `${source} discovery failed: ${error instanceof Error ? error.message : error}`,
        });
      }
    }
    return { observations: found, absent };
  }

  async deliverPending(observed) {
    const delivered = [];
    const groups = new Map();
    const pendingDeliveries = new Set();
    for (const [key, resource] of Object.entries(this.state.resources)) {
      if (!resource.pending) continue;
      const event = resource.pending.event || "change";
      const deliveryKey = `delivery:${resource.pending.goalId}:${event}`;
      pendingDeliveries.add(deliveryKey);
      if (!observed.has(key)) continue;
      const group = groups.get(deliveryKey) || { goalId: resource.pending.goalId, event, items: [] };
      group.items.push({ key, resource, pending: structuredClone(resource.pending) });
      groups.set(deliveryKey, group);
    }
    for (const key of this.reported) {
      if (key.startsWith("delivery:") && !pendingDeliveries.has(key)) this.reported.delete(key);
    }
    for (const [deliveryKey, { goalId, event, items }] of groups) {
      const batch = items.slice(0, MAX_EVENTS_PER_DELIVERY);
      try {
        const outcome = await this.deliver(goalId, batch.map(({ resource, pending }) => ({
          event,
          source: resource.source,
          subject: resource.subject,
          revision: pending.revision,
          payload: pending.payload,
          observedAt: event === "stale" ? pending.triggeredAt : resource.observedAt,
          ...(event === "stale" ? {
            unchangedSince: resource.observedAt,
            staleForMs: Date.parse(pending.triggeredAt) - Date.parse(resource.observedAt),
            staleAfterMs: pending.staleAfterMs,
          } : {}),
        })));
        for (const { key, pending } of batch) {
          delivered.push([key, pending.goalId, pending.revision, event]);
        }
        this.reported.delete(deliveryKey);
        if (outcome?.warning) {
          const subjects = batch.map(({ resource }) => `${resource.source} ${resource.subject}`).join(", ");
          await this.report(deliveryKey, {
            kind: "delivery",
            goalId,
            affectedGoalIds: [goalId],
            retry: "The event will not be sent again automatically because delivery may already have taken effect. Inspect current worker evidence before deciding whether to act.",
            message: `delivery outcome for ${goalId} and ${subjects} is uncertain: ${outcome.warning}`,
          });
        }
      } catch (error) {
        const subjects = batch.map(({ resource }) => `${resource.source} ${resource.subject}`).join(", ");
        await this.report(deliveryKey, {
          kind: "delivery",
          goalId,
          affectedGoalIds: [goalId],
          retry: "The latest resource event remains pending and will be retried after a successful current provider read.",
          message: `could not wake ${goalId} for ${subjects}: ${error instanceof Error ? error.message : error}`,
        });
      }
    }
    if (!delivered.length) return;
    const next = structuredClone(this.state);
    for (const [key, goalId, revision, event] of delivered) {
      const current = next.resources[key];
      if (current?.pending?.goalId === goalId && current.pending.revision === revision
        && (current.pending.event || "change") === event) {
        if (event === "stale") current.staleNotified = true;
        delete current.pending;
      }
    }
    validateState(next, this.maxResources);
    await save(this.statePath, next);
    this.state = next;
  }

  async run(signal) {
    await this.ready;
    signal?.throwIfAborted();
    const scan = await this.scan(signal);
    signal?.throwIfAborted();
    const goalIds = [...new Set([
      ...Object.values(this.state.resources).map((resource) => resource.goalId),
      ...scan.observations.map((item) => item.goalId),
    ])];
    let active;
    try {
      active = this.activeGoals ? await this.activeGoals() : new Set(goalIds);
      signal?.throwIfAborted();
      if (!(active instanceof Set) || [...active].some((goalId) => typeof goalId !== "string")) {
        throw new Error("active goal resolver returned an invalid set");
      }
      this.reported.delete("goals");
    } catch (error) {
      signal?.throwIfAborted();
      await this.report("goals", {
        kind: "goals",
        affectedGoalIds: goalIds.slice(0, 20),
        retry: "The watcher will resolve canonical active goals again on its next bounded scan.",
        message: `could not resolve active goal ownership: ${error instanceof Error ? error.message : error}`,
      });
      return;
    }
    const inactiveObserved = new Set(scan.observations
      .filter((item) => !active.has(item.goalId))
      .map((item) => keyFor(item.source, item.subject)));
    const observations = scan.observations.filter((item) => active.has(item.goalId));
    const observed = new Set(observations.map((item) => keyFor(item.source, item.subject)));
    const next = structuredClone(this.state);
    let changed = false;
    let checkpointSpaceFreed = false;
    for (const [key, resource] of Object.entries(next.resources)) {
      if (!Object.hasOwn(this.sources, resource.source)
        || !active.has(resource.goalId)
        || inactiveObserved.has(key)) {
        delete next.resources[key];
        changed = true;
        checkpointSpaceFreed = true;
      }
    }
    for (const key of scan.absent) {
      if (!next.resources[key]) continue;
      delete next.resources[key];
      changed = true;
      checkpointSpaceFreed = true;
    }
    const known = [];
    const discovered = [];
    for (const item of observations) {
      const key = keyFor(item.source, item.subject);
      (next.resources[key] ? known : discovered).push(item);
    }
    const deferred = [];
    for (const item of [...known, ...discovered]) {
      const result = storeObservation(next, item, this.maxResources);
      if (!result.stored) deferred.push(item);
      if (result.changed) changed = true;
    }
    const staleAt = this.now();
    for (const item of observations) {
      const resource = next.resources[keyFor(item.source, item.subject)];
      if (!resource || resource.goalId !== item.goalId || resource.revision !== item.revision) continue;
      const unchangedForMs = Math.max(0, staleAt.getTime() - Date.parse(resource.observedAt));
      if (resource.pending && (resource.pending.event || "change") === "stale"
        && (this.staleAfterMs === 0 || unchangedForMs < this.staleAfterMs)) {
        delete resource.pending;
        changed = true;
      }
      if (this.staleAfterMs === 0 || unchangedForMs < this.staleAfterMs
        || resource.pending || resource.staleNotified) continue;
      resource.pending = {
        event: "stale",
        goalId: resource.goalId,
        revision: resource.revision,
        payload: item.payload,
        triggeredAt: staleAt.toISOString(),
        staleAfterMs: this.staleAfterMs,
      };
      changed = true;
    }
    if (changed) {
      validateState(next, this.maxResources);
      await save(this.statePath, next);
      this.state = next;
    }
    signal?.throwIfAborted();
    await this.deliverPending(observed);
    if (checkpointSpaceFreed) this.reported.delete("checkpoint-limit");
    if (!deferred.length) {
      if (Object.keys(this.state.resources).length < this.maxResources) {
        this.reported.delete("checkpoint-limit");
      }
      return;
    }
    const examples = deferred.slice(0, 5)
      .map((item) => `${item.source} ${item.subject}`)
      .join(", ");
    await this.report("checkpoint-limit", {
      kind: "checkpoint-limit",
      affectedGoalIds: [...new Set(deferred.map((item) => item.goalId))].slice(0, 20),
      retry: "Existing resources remain monitored; deferred resources are reconsidered when checkpoint space becomes available.",
      message: `event watcher checkpoint reached its ${this.maxResources}-resource limit; preserved existing monitoring and deferred ${deferred.length} newly discovered resources until a goal completes, a remembered resource is authoritatively absent, or its provider scope is removed: ${examples}`,
    });
  }

  runOnce(signal) {
    const next = this.runs.then(() => this.run(signal));
    this.runs = next.catch(() => {});
    return next;
  }
}
