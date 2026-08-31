import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

const VERSION = 1;
const MAX_TEXT = 2_000;
const MAX_TARGET_BYTES = 16 * 1024;
const MAX_WATCHES = 1_024;
const MAX_CONCURRENT_READS = 4;
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 20;
const MAX_LIST_TEXT = 500;
const MIN_INTERVAL_MS = 1_000;
const MAX_INTERVAL_MS = 24 * 60 * 60 * 1_000;

function text(value, name) {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_TEXT) {
    throw new Error(`${name} must be a non-empty string no longer than ${MAX_TEXT} characters`);
  }
  return value.trim();
}

function data(value, name) {
  const encoded = JSON.stringify(value);
  if (!encoded || Buffer.byteLength(encoded) > MAX_TARGET_BYTES) {
    throw new Error(`${name} must be JSON no larger than ${MAX_TARGET_BYTES} bytes`);
  }
  return JSON.parse(encoded);
}

function interval(value) {
  if (!Number.isInteger(value) || value < MIN_INTERVAL_MS || value > MAX_INTERVAL_MS) {
    throw new Error(`intervalMs must be between ${MIN_INTERVAL_MS} and ${MAX_INTERVAL_MS}`);
  }
  return value;
}

function listLimit(value) {
  if (value === undefined) return DEFAULT_LIST_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIST_LIMIT) {
    throw new Error(`limit must be between 1 and ${MAX_LIST_LIMIT}`);
  }
  return value;
}

function summaryText(value) {
  if (typeof value !== "string") return undefined;
  return value.slice(0, MAX_LIST_TEXT);
}

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}

function resourceId(source, subject) {
  return `res_${hash([source, subject])}`;
}

function watchId(source, subject, destination) {
  return `watch_${hash([source, subject, destination])}`;
}

function emptyState() {
  return { version: VERSION, resources: {}, watches: {} };
}

async function concurrent(items, limit, operation) {
  let next = 0;
  async function run() {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      await operation(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateDestination(value) {
  if (!object(value)) throw new Error("destination must be an object");
  return { adapter: text(value.adapter, "destination adapter"), target: data(value.target, "destination target") };
}

function validateState(value) {
  if (!object(value) || value.version !== VERSION || !object(value.resources) || !object(value.watches)) {
    throw new Error("unsupported or malformed event watcher state");
  }
  if (Object.keys(value.watches).length > MAX_WATCHES) throw new Error("event watcher state exceeds its watch limit");
  for (const [id, resource] of Object.entries(value.resources)) {
    if (!object(resource)
      || id !== resourceId(text(resource.source, "resource source"), text(resource.subject, "resource subject"))
      || text(resource.revision, "resource revision") !== resource.revision
      || !Number.isFinite(resource.nextPollAt)) {
      throw new Error("unsupported or malformed event watcher resource");
    }
    interval(resource.intervalMs);
    data(resource.payload, "resource payload");
  }
  for (const [id, watch] of Object.entries(value.watches)) {
    if (!object(watch) || !value.resources[watch.resourceId]) {
      throw new Error("unsupported or malformed event watcher watch");
    }
    watch.intervalMs ??= value.resources[watch.resourceId].intervalMs;
    interval(watch.intervalMs);
    const destination = validateDestination(watch.destination);
    const resource = value.resources[watch.resourceId];
    if (id !== watchId(resource.source, resource.subject, destination)) {
      throw new Error("unsupported or malformed event watcher identity");
    }
    if (watch.pending) {
      text(watch.pending.revision, "pending revision");
      data(watch.pending.payload, "pending payload");
      if (!Number.isFinite(watch.pending.observedAt) || !Number.isFinite(watch.pending.retryAt)) {
        throw new Error("unsupported or malformed pending delivery");
      }
    }
  }
  if (value.diagnostics !== undefined) validateDestination(value.diagnostics);
  return value;
}

async function load(path) {
  try {
    return validateState(JSON.parse(await readFile(path, "utf8")));
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

export class EventWatchService {
  constructor({ statePath, sources, deliveries, now = () => Date.now() }) {
    this.statePath = statePath;
    this.sources = sources;
    this.deliveries = deliveries;
    this.now = now;
    this.stateReady = load(statePath).then((state) => { this.state = state; });
    this.mutations = Promise.resolve();
    this.resourceLocks = new Map();
    this.reportedDiagnostics = new Set();
    this.scheduleGeneration = 0;
    this.running = false;
    this.schedulerError = undefined;
  }

  async mutate(change) {
    const run = async () => {
      await this.stateReady;
      const candidate = structuredClone(this.state);
      const result = await change(candidate);
      validateState(candidate);
      await save(this.statePath, candidate);
      this.state = candidate;
      return result;
    };
    const next = this.mutations.then(run, run);
    this.mutations = next.catch(() => {});
    return next;
  }

  async locked(id, operation) {
    const previous = this.resourceLocks.get(id) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.resourceLocks.set(id, current);
    try {
      return await current;
    } finally {
      if (this.resourceLocks.get(id) === current) this.resourceLocks.delete(id);
    }
  }

  async read(source, subject) {
    const adapter = this.sources[source];
    if (!adapter) throw new Error(`unsupported source ${source}`);
    const observation = await adapter.read(subject);
    return {
      revision: text(observation.revision, "observed revision"),
      payload: data(observation.payload ?? null, "observed payload"),
    };
  }

  async readCurrent(input) {
    const source = text(input.source, "source");
    const subject = text(input.subject, "subject");
    return { source, subject, ...await this.read(source, subject) };
  }

  async setDiagnostics(destination) {
    const validated = validateDestination(destination);
    const changed = await this.mutate((state) => {
      const differs = JSON.stringify(state.diagnostics) !== JSON.stringify(validated);
      state.diagnostics = validated;
      return differs;
    });
    if (changed) this.reportedDiagnostics.clear();
    return validated;
  }

  async report(key, message) {
    await this.stateReady;
    await this.mutations;
    const destination = this.state.diagnostics;
    if (!destination) return;
    const adapter = this.deliveries[destination.adapter];
    if (!adapter) return;
    if (this.reportedDiagnostics.has(key)) return;
    this.reportedDiagnostics.add(key);
    try {
      await adapter.deliver(destination.target, {
        source: "event-watchd",
        subject: key,
        revision: hash([key, message]),
        payload: { error: message },
        diagnostic: true,
      });
    } catch {
      this.reportedDiagnostics.delete(key);
      // Health/list still exposes the original error. Diagnostics must not form a retry loop.
    }
  }

  rescheduleResource(state, id) {
    const resource = state.resources[id];
    if (!resource) return;
    const watches = Object.values(state.watches).filter((watch) => watch.resourceId === id);
    if (!watches.length) {
      delete state.resources[id];
      return;
    }
    const previousIntervalMs = resource.intervalMs;
    resource.intervalMs = Math.min(...watches.map((watch) => watch.intervalMs));
    if (resource.intervalMs < previousIntervalMs) {
      resource.nextPollAt = Math.min(resource.nextPollAt, this.now() + resource.intervalMs);
    }
  }

  resourceIsDue(state, id, now = this.now()) {
    const resource = state.resources[id];
    return Boolean(resource && (
      resource.nextPollAt <= now
      || Object.values(state.watches).some((watch) =>
        watch.resourceId === id && watch.pending?.retryAt <= now)
    ));
  }

  async watch(input) {
    const source = text(input.source, "source");
    const subject = text(input.subject, "subject");
    const destination = validateDestination(input.destination);
    const requestedIntervalMs = interval(input.intervalMs ?? 60_000);
    const sourceMinimum = this.sources[source]?.minimumIntervalMs;
    const intervalMs = Math.max(requestedIntervalMs, sourceMinimum === undefined ? MIN_INTERVAL_MS : interval(sourceMinimum));
    const id = resourceId(source, subject);
    const identity = watchId(source, subject, destination);
    return this.locked(id, async () => {
      await this.stateReady;
      await this.mutations;
      if (this.state.watches[identity]) {
        const existing = this.state.watches[identity];
        return {
          watchId: identity,
          source,
          subject,
          baseline: this.state.resources[id].revision,
          payload: this.state.resources[id].payload,
          intervalMs: existing.intervalMs,
          existing: true,
        };
      }
      const sourceCapacity = this.sources[source]?.maxResources;
      if (sourceCapacity !== undefined) {
        if (!Number.isInteger(sourceCapacity) || sourceCapacity < 1) {
          throw new Error(`source ${source} has an invalid resource capacity`);
        }
        const existingResources = Object.values(this.state.resources)
          .filter((resource) => resource.source === source).length;
        if (!this.state.resources[id] && existingResources >= sourceCapacity) {
          throw new Error(`source ${source} reached its ${sourceCapacity}-resource capacity`);
        }
      }
      let observation;
      try {
        observation = await this.read(source, subject);
      } catch (error) {
        const message = String(error instanceof Error ? error.message : error).slice(0, MAX_TEXT);
        await this.report(`source:${source}:${subject}`, message);
        throw error;
      }
      const result = await this.mutate((state) => {
        if (!state.watches[identity] && Object.keys(state.watches).length >= MAX_WATCHES) {
          throw new Error("event watcher watch limit reached");
        }
        if (!state.resources[id] && sourceCapacity !== undefined) {
          const committedResources = Object.values(state.resources)
            .filter((resource) => resource.source === source).length;
          if (committedResources >= sourceCapacity) {
            throw new Error(`source ${source} reached its ${sourceCapacity}-resource capacity`);
          }
        }
        const previous = state.resources[id];
        if (previous && previous.revision !== observation.revision) {
          for (const existing of Object.values(state.watches)) {
            if (existing.resourceId !== id) continue;
            existing.pending = {
              revision: observation.revision,
              payload: observation.payload,
              observedAt: this.now(),
              retryAt: this.now(),
            };
          }
        }
        state.resources[id] = {
          source,
          subject,
          revision: observation.revision,
          payload: observation.payload,
          intervalMs,
          lastObservedAt: this.now(),
          nextPollAt: this.now() + intervalMs,
        };
        state.watches[identity] = { resourceId: id, destination, intervalMs };
        this.rescheduleResource(state, id);
        return {
          watchId: identity,
          source,
          subject,
          baseline: observation.revision,
          payload: observation.payload,
          intervalMs,
        };
      });
      this.reportedDiagnostics.delete(`source:${source}:${subject}`);
      await this.deliverResource(id);
      this.schedule();
      return result;
    });
  }

  async unwatch(identity) {
    const id = text(identity, "watch id");
    const removed = await this.mutate((state) => {
      const watch = state.watches[id];
      if (!watch) return false;
      const resource = watch.resourceId;
      delete state.watches[id];
      this.rescheduleResource(state, resource);
      return true;
    });
    this.schedule();
    return removed;
  }

  async observe(id) {
    await this.stateReady;
    await this.mutations;
    const resource = this.state.resources[id];
    if (!resource) return false;
    let observation;
    try {
      observation = await this.read(resource.source, resource.subject);
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error).slice(0, MAX_TEXT);
      const requestedRetry = Number(error?.retryAfterMs);
      const retryAfterMs = Number.isFinite(requestedRetry)
        ? Math.min(MAX_INTERVAL_MS, Math.max(resource.intervalMs, requestedRetry))
        : resource.intervalMs;
      await this.mutate((state) => {
        if (!state.resources[id]) return;
        state.resources[id].lastError = message;
        state.resources[id].nextPollAt = this.now() + retryAfterMs;
        state.resources[id].backoffUntil = state.resources[id].nextPollAt;
        for (const watch of Object.values(state.watches)) {
          if (watch.resourceId === id && watch.pending) {
            watch.pending.retryAt = state.resources[id].nextPollAt;
          }
        }
      });
      await this.report(`source:${resource.source}:${resource.subject}`, message);
      return false;
    }
    await this.mutate((state) => {
      const current = state.resources[id];
      if (!current) return;
      const changed = current.revision !== observation.revision;
      current.revision = observation.revision;
      current.payload = observation.payload;
      current.lastObservedAt = this.now();
      current.nextPollAt = this.now() + current.intervalMs;
      delete current.lastError;
      delete current.backoffUntil;
      this.reportedDiagnostics.delete(`source:${resource.source}:${resource.subject}`);
      if (!changed) return;
      for (const watch of Object.values(state.watches)) {
        if (watch.resourceId !== id) continue;
        watch.pending = {
          revision: observation.revision,
          payload: observation.payload,
          observedAt: this.now(),
          retryAt: this.now(),
        };
      }
    });
    await this.deliverResource(id);
    return true;
  }

  async deliverResource(resourceIdValue) {
    await this.stateReady;
    await this.mutations;
    const candidates = Object.entries(this.state.watches)
      .filter(([, watch]) => watch.resourceId === resourceIdValue && watch.pending?.retryAt <= this.now())
      .map(([id]) => id);
    for (const id of candidates) await this.deliver(id);
  }

  async deliver(id) {
    await this.stateReady;
    await this.mutations;
    const watch = structuredClone(this.state.watches[id]);
    if (!watch?.pending) return;
    const resource = this.state.resources[watch.resourceId];
    const adapter = this.deliveries[watch.destination.adapter];
    let error;
    try {
      if (!adapter) throw new Error(`unsupported delivery adapter ${watch.destination.adapter}`);
      await adapter.deliver(watch.destination.target, {
        source: resource.source,
        subject: resource.subject,
        revision: watch.pending.revision,
        payload: watch.pending.payload,
      });
    } catch (caught) {
      error = String(caught instanceof Error ? caught.message : caught).slice(0, MAX_TEXT);
    }
    if (error) {
      await this.mutate((state) => {
        const current = state.watches[id];
        if (!current?.pending || current.pending.revision !== watch.pending.revision) return;
        const currentResource = state.resources[current.resourceId];
        current.lastError = error;
        current.pending.retryAt = Math.max(
          this.now() + currentResource.intervalMs,
          currentResource.nextPollAt,
        );
      });
      await this.report(`delivery:${id}`, error);
      return;
    }
    await this.mutate((state) => {
      const current = state.watches[id];
      if (!current?.pending || current.pending.revision !== watch.pending.revision) return;
      const resourceKey = current.resourceId;
      delete state.watches[id];
      this.rescheduleResource(state, resourceKey);
    });
    this.reportedDiagnostics.delete(`delivery:${id}`);
  }

  async pollNow() {
    await this.stateReady;
    await this.mutate((state) => {
      const now = this.now();
      for (const watch of Object.values(state.watches)) {
        if (!watch.pending) continue;
        const resource = state.resources[watch.resourceId];
        if (resource?.backoffUntil > now) continue;
        watch.pending.retryAt = now;
      }
    });
    const now = this.now();
    const ids = Object.entries(this.state.resources)
      .filter(([, resource]) => !(resource.backoffUntil > now))
      .map(([id]) => id);
    await concurrent(ids, MAX_CONCURRENT_READS, (id) =>
      this.locked(id, async () => {
        // Time can advance while this task waits for the per-resource lock, so
        // recheck backoff here rather than trusting the filter snapshot above.
        if (this.state.resources[id]?.backoffUntil > this.now()) return;
        const observed = await this.observe(id);
        if (!observed) await this.deliverResource(id);
      })
    );
    this.schedule();
  }

  async status() {
    await this.stateReady;
    await this.mutations;
    return structuredClone(this.state);
  }

  async list(input = {}) {
    await this.stateReady;
    await this.mutations;
    const limit = listLimit(input.limit);
    const cursor = input.cursor === undefined ? undefined : text(input.cursor, "cursor");
    const entries = Object.entries(this.state.watches)
      .sort(([left], [right]) => left.localeCompare(right));
    const start = cursor === undefined
      ? 0
      : entries.findIndex(([id]) => id > cursor);
    const page = (start < 0 ? [] : entries.slice(start, start + limit));
    const watches = page.map(([id, watch]) => {
      const resource = this.state.resources[watch.resourceId];
      const subject = summaryText(resource.subject);
      return {
        watchId: id,
        source: resource.source,
        subject,
        subjectTruncated: subject.length !== resource.subject.length,
        intervalMs: watch.intervalMs,
        revision: resource.revision,
        nextPollAt: resource.nextPollAt,
        pending: watch.pending ? {
          revision: watch.pending.revision,
          observedAt: watch.pending.observedAt,
          retryAt: watch.pending.retryAt,
        } : null,
        error: summaryText(watch.lastError || resource.lastError) || null,
      };
    });
    const consumed = start < 0 ? entries.length : start + page.length;
    return {
      totalWatches: entries.length,
      totalResources: Object.keys(this.state.resources).length,
      diagnosticsConfigured: Boolean(this.state.diagnostics),
      schedulerError: summaryText(this.schedulerError) || null,
      watches,
      nextCursor: consumed < entries.length && page.length ? page.at(-1)[0] : null,
    };
  }

  schedule() {
    clearTimeout(this.timer);
    const generation = ++this.scheduleGeneration;
    if (!this.running) return;
    void this.status().then((state) => {
      if (!this.running || generation !== this.scheduleGeneration) return;
      const times = [
        ...Object.values(state.resources).map((resource) => resource.nextPollAt),
        ...Object.values(state.watches).flatMap((watch) => watch.pending ? [watch.pending.retryAt] : []),
      ];
      if (!times.length) return;
      const delay = Math.max(0, Math.min(...times) - this.now());
      this.timer = setTimeout(() => {
        void this.tick().catch(async (error) => {
          this.running = false;
          this.schedulerError = String(error instanceof Error ? error.message : error).slice(0, MAX_TEXT);
          await this.report("scheduler", this.schedulerError);
        });
      }, delay);
    });
  }

  async tick() {
    if (!this.running) return;
    try {
      await this.stateReady;
      await this.mutations;
      const now = this.now();
      const ids = Object.entries(this.state.resources)
        .filter(([, resource]) => resource.nextPollAt <= now
          || Object.values(this.state.watches).some((watch) => watch.resourceId === resourceId(resource.source, resource.subject)
            && watch.pending?.retryAt <= now))
        .map(([id]) => id);
      await concurrent(ids, MAX_CONCURRENT_READS, (id) =>
        this.locked(id, async () => {
          await this.stateReady;
          await this.mutations;
          if (!this.resourceIsDue(this.state, id)) return;
          const observed = await this.observe(id);
          if (!observed) await this.deliverResource(id);
        })
      );
    } finally {
      this.schedule();
    }
  }

  async start() {
    await this.stateReady;
    await this.mutate((state) => {
      const counts = new Map();
      for (const resource of Object.values(state.resources)) {
        const source = this.sources[resource.source];
        if (!source) throw new Error(`persisted watch uses unsupported source ${resource.source}`);
        counts.set(resource.source, (counts.get(resource.source) ?? 0) + 1);
      }
      for (const [name, count] of counts) {
        const capacity = this.sources[name].maxResources;
        if (capacity !== undefined && (!Number.isInteger(capacity) || capacity < 1)) {
          throw new Error(`source ${name} has an invalid resource capacity`);
        }
        if (capacity !== undefined && count > capacity) {
          throw new Error(`persisted source ${name} has ${count} resources but current capacity is ${capacity}`);
        }
      }
      for (const watch of Object.values(state.watches)) {
        const resource = state.resources[watch.resourceId];
        const minimum = this.sources[resource.source].minimumIntervalMs;
        if (minimum !== undefined) watch.intervalMs = Math.max(watch.intervalMs, interval(minimum));
      }
      for (const id of Object.keys(state.resources)) {
        this.rescheduleResource(state, id);
        state.resources[id].nextPollAt = this.now();
      }
      for (const watch of Object.values(state.watches)) {
        if (watch.pending) watch.pending.retryAt = this.now();
      }
    });
    this.schedulerError = undefined;
    this.running = true;
    this.schedule();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
  }
}
