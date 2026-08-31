import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const VERSION = 1;
const MAX_TEXT = 2_000;
const MAX_TARGET_BYTES = 16 * 1024;
const MAX_WATCHES = 1_024;
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
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
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

  async setDiagnostics(destination) {
    const validated = validateDestination(destination);
    await this.mutate((state) => { state.diagnostics = validated; });
    return validated;
  }

  async report(key, message) {
    if (this.reportedDiagnostics.has(key)) return;
    this.reportedDiagnostics.add(key);
    await this.stateReady;
    await this.mutations;
    const destination = this.state.diagnostics;
    if (!destination) return;
    const adapter = this.deliveries[destination.adapter];
    if (!adapter) return;
    try {
      await adapter.deliver(destination.target, {
        source: "event-watchd",
        subject: key,
        revision: hash([key, message]),
        payload: { error: message },
        diagnostic: true,
      });
    } catch {
      // Health/list still exposes the original error. Diagnostics must not form a retry loop.
    }
  }

  async watch(input) {
    const source = text(input.source, "source");
    const subject = text(input.subject, "subject");
    const destination = validateDestination(input.destination);
    const intervalMs = interval(input.intervalMs ?? 60_000);
    const id = resourceId(source, subject);
    return this.locked(id, async () => {
      let observation;
      try {
        observation = await this.read(source, subject);
      } catch (error) {
        const message = String(error instanceof Error ? error.message : error).slice(0, MAX_TEXT);
        await this.report(`source:${source}:${subject}`, message);
        throw error;
      }
      const result = await this.mutate((state) => {
        const identity = watchId(source, subject, destination);
        if (!state.watches[identity] && Object.keys(state.watches).length >= MAX_WATCHES) {
          throw new Error("event watcher watch limit reached");
        }
        const previous = state.resources[id];
        if (previous && previous.revision !== observation.revision) {
          for (const [existingId, existing] of Object.entries(state.watches)) {
            if (existing.resourceId !== id || existingId === identity) continue;
            existing.pending = {
              revision: observation.revision,
              payload: observation.payload,
              observedAt: this.now(),
              retryAt: this.now(),
            };
          }
        }
        const effectiveInterval = Math.min(previous?.intervalMs ?? intervalMs, intervalMs);
        state.resources[id] = {
          source,
          subject,
          revision: observation.revision,
          payload: observation.payload,
          intervalMs: effectiveInterval,
          lastObservedAt: this.now(),
          nextPollAt: this.now() + effectiveInterval,
        };
        state.watches[identity] = { resourceId: id, destination };
        return { watchId: identity, source, subject, baseline: observation.revision };
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
      if (!Object.values(state.watches).some((candidate) => candidate.resourceId === resource)) {
        delete state.resources[resource];
      }
      return true;
    });
    this.schedule();
    return removed;
  }

  async observe(id) {
    await this.stateReady;
    await this.mutations;
    const resource = this.state.resources[id];
    if (!resource) return;
    let observation;
    try {
      observation = await this.read(resource.source, resource.subject);
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error).slice(0, MAX_TEXT);
      await this.mutate((state) => {
        if (!state.resources[id]) return;
        state.resources[id].lastError = message;
        state.resources[id].nextPollAt = this.now() + state.resources[id].intervalMs;
      });
      await this.report(`source:${resource.source}:${resource.subject}`, message);
      return;
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
        current.lastError = error;
        current.pending.retryAt = this.now() + state.resources[current.resourceId].intervalMs;
      });
      await this.report(`delivery:${id}`, error);
      return;
    }
    await this.mutate((state) => {
      const current = state.watches[id];
      if (!current?.pending || current.pending.revision !== watch.pending.revision) return;
      const resourceKey = current.resourceId;
      delete state.watches[id];
      if (!Object.values(state.watches).some((candidate) => candidate.resourceId === resourceKey)) {
        delete state.resources[resourceKey];
      }
    });
    this.reportedDiagnostics.delete(`delivery:${id}`);
  }

  async pollNow() {
    await this.stateReady;
    await this.mutate((state) => {
      for (const watch of Object.values(state.watches)) {
        if (watch.pending) watch.pending.retryAt = this.now();
      }
    });
    const ids = Object.keys(this.state.resources);
    await Promise.all(ids.map((id) =>
      this.locked(id, async () => {
        await this.deliverResource(id);
        await this.observe(id);
      })
    ));
    this.schedule();
  }

  async status() {
    await this.stateReady;
    await this.mutations;
    return structuredClone(this.state);
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
      this.timer = setTimeout(() => void this.tick(), delay);
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
      await Promise.all(ids.map((id) =>
        this.locked(id, async () => {
          await this.deliverResource(id);
          await this.stateReady;
          await this.mutations;
          if (this.state.resources[id]?.nextPollAt <= this.now()) await this.observe(id);
        })
      ));
    } finally {
      this.schedule();
    }
  }

  async start() {
    await this.stateReady;
    this.running = true;
    await this.mutate((state) => {
      for (const resource of Object.values(state.resources)) resource.nextPollAt = this.now();
    });
    this.schedule();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
  }
}
