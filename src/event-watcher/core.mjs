import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

const VERSION = 1;
const GOAL_ID = /^g_[a-zA-Z0-9_-]+$/;
const MAX_TEXT = 2_000;
const MAX_PAYLOAD_BYTES = 16 * 1024;
const MAX_SCAN_RESULTS = 500;
const DEFAULT_MAX_RESOURCES = 1024;
const MAX_EVENTS_PER_DELIVERY = 20;

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
    if (resource.pending !== undefined) {
      const pending = resource.pending;
      if (!pending || typeof pending !== "object" || Array.isArray(pending)
        || pending.goalId !== resource.goalId || pending.revision !== resource.revision) {
        throw new Error("event watcher pending delivery is invalid");
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
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await open(temporary, "wx", 0o600);
    await file.writeFile(`${JSON.stringify(state, null, 2)}\n`);
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await file?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
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
      goalId: item.goalId,
      revision: item.revision,
      payload: item.payload,
    },
  };
  return { stored: true, changed: true };
}

export class MetadataEventWatcher {
  constructor({
    statePath,
    sources,
    deliver,
    activeGoals,
    diagnose = (diagnostic) => console.error(diagnostic.message),
    now = () => new Date(),
    maxResources = DEFAULT_MAX_RESOURCES,
  }) {
    if (!statePath || !sources || typeof deliver !== "function"
      || (activeGoals !== undefined && typeof activeGoals !== "function")) {
      throw new Error("statePath, sources, and deliver are required; activeGoals must be a function");
    }
    this.statePath = statePath;
    this.sources = sources;
    this.deliver = deliver;
    this.activeGoals = activeGoals;
    this.diagnose = diagnose;
    this.now = now;
    this.maxResources = maxResources;
    this.ready = load(statePath, maxResources).then((state) => { this.state = state; });
    this.runs = Promise.resolve();
    this.reported = new Set();
  }

  async report(key, diagnostic) {
    if (this.reported.has(key)) return;
    try {
      await this.diagnose(diagnostic);
      this.reported.add(key);
    } catch (error) {
      console.error(`event watcher diagnostic delivery failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  async scan() {
    const found = [];
    const absent = [];
    for (const [source, adapter] of Object.entries(this.sources)) {
      try {
        const known = Object.values(this.state.resources)
          .filter((resource) => resource.source === source)
          .map((resource) => ({ subject: resource.subject, goalId: resource.goalId }));
        const result = await adapter.scan(known);
        if (!result || typeof result !== "object" || Array.isArray(result)
          || !Array.isArray(result.observations) || !Array.isArray(result.absent)) {
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
        found.push(...normalized);
        absent.push(...[...missing].map((subject) => keyFor(source, subject)));
        this.reported.delete(`source:${source}`);
      } catch (error) {
        await this.report(`source:${source}`, {
          kind: "source",
          source,
          message: `${source} discovery failed: ${error instanceof Error ? error.message : error}`,
        });
      }
    }
    return { observations: found, absent };
  }

  async deliverPending(observed) {
    const delivered = [];
    const groups = new Map();
    const pendingGoals = new Set();
    for (const [key, resource] of Object.entries(this.state.resources)) {
      if (!resource.pending) continue;
      pendingGoals.add(resource.pending.goalId);
      if (!observed.has(key)) continue;
      const items = groups.get(resource.pending.goalId) || [];
      items.push({ key, resource, pending: structuredClone(resource.pending) });
      groups.set(resource.pending.goalId, items);
    }
    for (const key of this.reported) {
      if (key.startsWith("delivery:") && !pendingGoals.has(key.slice("delivery:".length))) this.reported.delete(key);
    }
    for (const [goalId, items] of groups) {
      const batch = items.slice(0, MAX_EVENTS_PER_DELIVERY);
      try {
        await this.deliver(goalId, batch.map(({ resource, pending }) => ({
          source: resource.source,
          subject: resource.subject,
          revision: pending.revision,
          payload: pending.payload,
          observedAt: resource.observedAt,
        })));
        for (const { key, pending } of batch) {
          delivered.push([key, pending.goalId, pending.revision]);
        }
        this.reported.delete(`delivery:${goalId}`);
      } catch (error) {
        const subjects = batch.map(({ resource }) => `${resource.source} ${resource.subject}`).join(", ");
        await this.report(`delivery:${goalId}`, {
          kind: "delivery",
          goalId,
          message: `could not wake ${goalId} for ${subjects}: ${error instanceof Error ? error.message : error}`,
        });
      }
    }
    if (!delivered.length) return;
    const next = structuredClone(this.state);
    for (const [key, goalId, revision] of delivered) {
      const current = next.resources[key];
      if (current?.pending?.goalId === goalId && current.pending.revision === revision) {
        delete current.pending;
      }
    }
    validateState(next, this.maxResources);
    await save(this.statePath, next);
    this.state = next;
  }

  async run() {
    await this.ready;
    const scan = await this.scan();
    const goalIds = [...new Set([
      ...Object.values(this.state.resources).map((resource) => resource.goalId),
      ...scan.observations.map((item) => item.goalId),
    ])];
    let active;
    try {
      active = this.activeGoals ? await this.activeGoals() : new Set(goalIds);
      if (!(active instanceof Set) || [...active].some((goalId) => typeof goalId !== "string")) {
        throw new Error("active goal resolver returned an invalid set");
      }
      this.reported.delete("goals");
    } catch (error) {
      await this.report("goals", {
        kind: "goals",
        message: `could not resolve active goal ownership: ${error instanceof Error ? error.message : error}`,
      });
      return;
    }
    const observations = scan.observations.filter((item) => active.has(item.goalId));
    const observed = new Set(observations.map((item) => keyFor(item.source, item.subject)));
    const next = structuredClone(this.state);
    let changed = false;
    let capacityFreed = false;
    for (const [key, resource] of Object.entries(next.resources)) {
      if (!Object.hasOwn(this.sources, resource.source) || !active.has(resource.goalId)) {
        delete next.resources[key];
        changed = true;
        capacityFreed = true;
      }
    }
    for (const key of scan.absent) {
      if (!next.resources[key]) continue;
      delete next.resources[key];
      changed = true;
      capacityFreed = true;
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
    if (changed) {
      validateState(next, this.maxResources);
      await save(this.statePath, next);
      this.state = next;
    }
    await this.deliverPending(observed);
    if (capacityFreed) this.reported.delete("capacity");
    if (!deferred.length) {
      if (Object.keys(this.state.resources).length < this.maxResources) {
        this.reported.delete("capacity");
      }
      return;
    }
    const examples = deferred.slice(0, 5)
      .map((item) => `${item.source} ${item.subject}`)
      .join(", ");
    await this.report("capacity", {
      kind: "capacity",
      message: `event watcher checkpoint reached its ${this.maxResources}-resource limit; preserved existing monitoring and deferred ${deferred.length} newly discovered resources until a goal completes, a remembered resource is authoritatively absent, or capacity is increased: ${examples}`,
    });
  }

  runOnce() {
    const next = this.runs.then(() => this.run());
    this.runs = next.catch(() => {});
    return next;
  }
}
