import { open, mkdir, readFile, readdir, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const GOAL_SCHEMA = "herdr.goal/v1";
export const STATE_VERSION = 1;
export const AUDIT_VERSION = 1;
const MAX_CONTRACT_BYTES = 128 * 1024;
const MAX_STATE_BYTES = 256 * 1024;
const MAX_AUDIT_ENTRY_BYTES = 64 * 1024;
const contractFields = new Set(["schema", "objective", "context", "acceptance", "constraints"]);
const stateFields = new Set([
  "version",
  "goalId",
  "revision",
  "createdAt",
  "updatedAt",
  "worker",
  "evidence",
  "progress",
  "reviewAt",
  "lastDecision",
  "wait",
  "terminal",
  "observationCursor",
]);
const workerFields = new Set(["paneId", "terminalId", "agentSession"]);
const agentSessionFields = new Set(["source", "agent", "kind", "value"]);
const decisionFields = new Set(["decision", "at", "action"]);
const waitFields = new Set(["condition", "reviewAt", "paneId"]);
const terminalFields = new Set(["state", "at", "summary"]);
const goalIdPattern = /^g_[a-zA-Z0-9_-]+$/;
const terminalStates = new Set(["accepted", "stopped"]);
const decisions = new Set(["leave", "steer", "ask_human", "accept", "stop"]);
const writes = new Map();

function serializeWrite(key, operation) {
  const previous = writes.get(key) || Promise.resolve();
  const update = previous.then(operation);
  const settled = update.catch(() => {});
  writes.set(key, settled);
  void settled.then(() => {
    if (writes.get(key) === settled) writes.delete(key);
  });
  return update;
}

export function defaultGoalsRoot(env = process.env) {
  if (env.HERDR_SUPERVISOR_GOALS) return env.HERDR_SUPERVISOR_GOALS;
  const root = env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(root, "herdr-supervisor", "goals");
}

export function newGoalId(uuid = randomUUID()) {
  return `g_${uuid}`;
}

export function goalPaths(goalId, root = defaultGoalsRoot()) {
  if (!goalIdPattern.test(goalId)) throw new Error("invalid goal ID");
  const directory = join(root, goalId);
  return {
    directory,
    contract: join(directory, "goal.json"),
    current: join(directory, "current.json"),
    journal: join(directory, "journal.jsonl"),
  };
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
}

function stringArray(value, label, { required = false } = {}) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  if (required && !value.length) throw new Error(`${label} must not be empty`);
}

function onlyFields(value, allowed, label) {
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) throw new Error(`${label} contains unsupported field ${field}`);
  }
}

export function validateGoalContract(contract) {
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
    throw new Error("invalid goal contract");
  }
  for (const field of Object.keys(contract)) {
    if (!contractFields.has(field)) throw new Error(`goal contract contains unsupported field ${field}`);
  }
  if (contract.schema !== GOAL_SCHEMA) throw new Error(`unsupported goal schema ${contract.schema}`);
  requiredString(contract.objective, "goal objective");
  stringArray(contract.context, "goal context");
  stringArray(contract.acceptance, "goal acceptance", { required: true });
  stringArray(contract.constraints, "goal constraints");
  return contract;
}

export function createGoalContract({ objective, context = [], acceptance, constraints = [] }) {
  return validateGoalContract({
    schema: GOAL_SCHEMA,
    objective,
    context: [...context],
    acceptance: [...(acceptance || [])],
    constraints: [...constraints],
  });
}

function validateWorker(worker) {
  if (!worker || typeof worker !== "object") throw new Error("goal state requires worker");
  onlyFields(worker, workerFields, "goal worker");
  requiredString(worker.paneId, "worker.paneId");
  requiredString(worker.terminalId, "worker.terminalId");
  if (!worker.agentSession || typeof worker.agentSession !== "object") {
    throw new Error("goal state requires worker.agentSession");
  }
  onlyFields(worker.agentSession, agentSessionFields, "worker agentSession");
  for (const field of ["source", "agent", "kind", "value"]) {
    requiredString(worker.agentSession[field], `worker.agentSession.${field}`);
  }
}

export function validateGoalState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error("invalid goal state");
  for (const field of Object.keys(state)) {
    if (!stateFields.has(field)) throw new Error(`goal state contains unsupported field ${field}`);
  }
  if (state.version !== STATE_VERSION) throw new Error(`unsupported goal state version ${state.version}`);
  if (!goalIdPattern.test(state.goalId)) throw new Error("invalid goal ID");
  if (!Number.isInteger(state.revision) || state.revision < 1) {
    throw new Error("goal state requires a positive revision");
  }
  for (const field of ["createdAt", "updatedAt"]) {
    requiredString(state[field], `goal state ${field}`);
    if (!Number.isFinite(Date.parse(state[field]))) throw new Error(`goal state ${field} must be an ISO timestamp`);
  }
  validateWorker(state.worker);
  stringArray(state.evidence, "goal state evidence");
  if (state.progress !== undefined && typeof state.progress !== "string") {
    throw new Error("goal state progress must be a string");
  }
  if (state.reviewAt !== undefined) {
    requiredString(state.reviewAt, "goal state reviewAt");
    if (!Number.isFinite(Date.parse(state.reviewAt))) {
      throw new Error("goal state reviewAt must be an ISO timestamp");
    }
  }
  if (state.lastDecision !== undefined) {
    if (!state.lastDecision || typeof state.lastDecision !== "object") {
      throw new Error("goal state lastDecision must be an object");
    }
    onlyFields(state.lastDecision, decisionFields, "lastDecision");
    if (!decisions.has(state.lastDecision.decision)) {
      throw new Error(`unsupported goal decision ${state.lastDecision.decision}`);
    }
    requiredString(state.lastDecision.at, "lastDecision.at");
    requiredString(state.lastDecision.action, "lastDecision.action");
    if (!Number.isFinite(Date.parse(state.lastDecision.at))) {
      throw new Error("lastDecision.at must be an ISO timestamp");
    }
  }
  if (state.wait !== undefined) {
    if (!state.wait || typeof state.wait !== "object" || Array.isArray(state.wait)) {
      throw new Error("goal wait must be an object");
    }
    onlyFields(state.wait, waitFields, "goal wait");
    requiredString(state.wait.condition, "goal wait condition");
    requiredString(state.wait.reviewAt, "goal wait reviewAt");
    if (state.wait.paneId !== undefined) requiredString(state.wait.paneId, "goal wait paneId");
    if (!Number.isFinite(Date.parse(state.wait.reviewAt))) {
      throw new Error("goal wait reviewAt must be an ISO timestamp");
    }
  }
  if (state.terminal !== undefined) {
    if (!state.terminal || !terminalStates.has(state.terminal.state)) {
      throw new Error("goal terminal state must be accepted or stopped");
    }
    onlyFields(state.terminal, terminalFields, "goal terminal state");
    requiredString(state.terminal.at, "terminal.at");
    requiredString(state.terminal.summary, "terminal.summary");
    if (!Number.isFinite(Date.parse(state.terminal.at))) {
      throw new Error("terminal.at must be an ISO timestamp");
    }
  }
  if (state.observationCursor !== undefined) {
    if (!state.observationCursor || typeof state.observationCursor !== "object") {
      throw new Error("goal state observationCursor must be an object");
    }
    requiredString(state.observationCursor.kind, "observationCursor.kind");
  }
  return state;
}

export function createGoalState({ goalId = newGoalId(), at = new Date().toISOString(), worker }) {
  return validateGoalState({
    version: STATE_VERSION,
    goalId,
    revision: 1,
    createdAt: at,
    updatedAt: at,
    worker: structuredClone(worker),
    evidence: [],
    progress: "Goal started; awaiting the first review.",
  });
}

function jsonContent(value, maxBytes, label) {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(content) > maxBytes) throw new Error(`${label} is too large`);
  return content;
}

async function atomicWrite(path, value) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await open(temporary, "wx", 0o600);
    await file.writeFile(value);
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try {
      // The file sync protects its contents. Syncing the containing directory
      // protects the rename that makes those contents current after a crash.
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

async function missing(path) {
  try {
    await readFile(path, "utf8");
    return false;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
}

export async function installGoal(goalId, contract, root = defaultGoalsRoot()) {
  validateGoalContract(contract);
  const paths = goalPaths(goalId, root);
  if (!(await missing(paths.contract))) throw new Error(`goal ${goalId} is already installed`);
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  await atomicWrite(paths.contract, jsonContent(contract, MAX_CONTRACT_BYTES, "goal contract"));
  return contract;
}

export async function loadGoalContract(goalId, root = defaultGoalsRoot()) {
  const { contract } = goalPaths(goalId, root);
  return validateGoalContract(JSON.parse(await readFile(contract, "utf8")));
}

export async function updateGoalContract(goalId, change, root = defaultGoalsRoot()) {
  const key = `${root}\0${goalId}\0contract`;
  return serializeWrite(key, async () => {
    const current = await loadGoalContract(goalId, root);
    const next = await change(structuredClone(current));
    validateGoalContract(next);
    await atomicWrite(goalPaths(goalId, root).contract, jsonContent(next, MAX_CONTRACT_BYTES, "goal contract"));
    return next;
  });
}

export async function startGoal(goalId, worker, root = defaultGoalsRoot(), options: any = {}) {
  await loadGoalContract(goalId, root);
  const paths = goalPaths(goalId, root);
  if (!(await missing(paths.current))) throw new Error(`goal ${goalId} already has local execution state`);
  const state = createGoalState({
    goalId,
    at: options.at,
    worker,
  });
  await atomicWrite(paths.current, jsonContent(state, MAX_STATE_BYTES, "goal state"));
  return state;
}

export async function loadGoalState(goalId, root = defaultGoalsRoot()) {
  const { current } = goalPaths(goalId, root);
  return validateGoalState(JSON.parse(await readFile(current, "utf8")));
}

export async function loadGoal(goalId, root = defaultGoalsRoot()) {
  const [contract, state] = await Promise.all([
    loadGoalContract(goalId, root),
    loadGoalState(goalId, root),
  ]);
  return { contract, state };
}

export async function listGoalRecords(root = defaultGoalsRoot()) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const goalIds = entries
    .filter((entry) => entry.isDirectory() && goalIdPattern.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  return Promise.all(goalIds.map(async (goalId) => {
    try {
      const contract = await loadGoalContract(goalId, root);
      let state;
      try {
        state = await loadGoalState(goalId, root);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      return { goalId, contract, state };
    } catch (error) {
      return { goalId, error };
    }
  }));
}

export async function updateGoalState(goalId, change, root = defaultGoalsRoot(), now = () => new Date().toISOString()) {
  const key = `${root}\0${goalId}\0state`;
  return serializeWrite(key, async () => {
    const current = await loadGoalState(goalId, root);
    if (current.terminal) throw new Error(`goal ${goalId} is already ${current.terminal.state}`);
    const next = await change(structuredClone(current));
    if (next.goalId !== current.goalId || next.version !== current.version || next.createdAt !== current.createdAt) {
      throw new Error("a goal state update cannot change its identity");
    }
    if (
      next.worker.paneId !== current.worker.paneId
      || ["source", "agent", "kind", "value"].some(
        (field) => next.worker.agentSession?.[field] !== current.worker.agentSession?.[field],
      )
    ) {
      throw new Error("a goal state update cannot replace its worker pane or native session");
    }
    next.revision = current.revision + 1;
    next.updatedAt = now();
    validateGoalState(next);
    await atomicWrite(goalPaths(goalId, root).current, jsonContent(next, MAX_STATE_BYTES, "goal state"));
    return next;
  });
}

export function validateAuditEntry(entry) {
  if (!entry || typeof entry !== "object") throw new Error("invalid audit entry");
  if (entry.v !== AUDIT_VERSION) throw new Error(`unsupported audit version ${entry.v}`);
  if (!goalIdPattern.test(entry.goalId)) throw new Error("invalid audit goal ID");
  requiredString(entry.id, "audit entry id");
  requiredString(entry.at, "audit entry time");
  requiredString(entry.type, "audit entry type");
  requiredString(entry.summary, "audit entry summary");
  if (!Number.isFinite(Date.parse(entry.at))) throw new Error("audit entry time must be an ISO timestamp");
  if (!Number.isInteger(entry.goalRevision) || entry.goalRevision < 1) {
    throw new Error("audit entry requires a positive goal revision");
  }
  return entry;
}

async function repairAuditTail(path) {
  let file;
  try {
    file = await open(path, "r+");
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  try {
    const info = await file.stat();
    if (!info.size) return;
    const length = Math.min(info.size, MAX_AUDIT_ENTRY_BYTES);
    const start = info.size - length;
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, start);
    if (buffer.at(-1) === 0x0a) return;
    const lastNewline = buffer.lastIndexOf(0x0a);
    const tailStart = start + lastNewline + 1;
    const tail = buffer.subarray(lastNewline + 1).toString("utf8");
    try {
      validateAuditEntry(JSON.parse(tail));
      await file.write("\n", info.size);
    } catch {
      await file.truncate(tailStart);
    }
    await file.sync();
  } finally {
    await file.close();
  }
}

export async function appendAudit(entry, root = defaultGoalsRoot()) {
  validateAuditEntry(entry);
  const paths = goalPaths(entry.goalId, root);
  const line = `${JSON.stringify(entry)}\n`;
  if (Buffer.byteLength(line) > MAX_AUDIT_ENTRY_BYTES) throw new Error("audit entry is too large");
  const key = `${paths.journal}\0audit`;
  return serializeWrite(key, async () => {
    const state = await loadGoalState(entry.goalId, root);
    if (entry.goalRevision > state.revision) {
      throw new Error("audit entry refers to an unknown future goal revision");
    }
    await repairAuditTail(paths.journal);
    const file = await open(paths.journal, "a", 0o600);
    try {
      await file.writeFile(line);
      await file.sync();
    } finally {
      await file.close();
    }
    return entry;
  });
}

export async function readAudit(goalId, root = defaultGoalsRoot()) {
  const { journal } = goalPaths(goalId, root);
  let content;
  try {
    content = await readFile(journal, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const terminated = content.endsWith("\n");
  const lines = content.split("\n");
  if (terminated) lines.pop();
  const entries = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    try {
      entries.push(validateAuditEntry(JSON.parse(line)));
    } catch (error) {
      if (!terminated && index === lines.length - 1) break;
      throw new Error(`invalid goal audit ${journal} line ${index + 1}: ${error.message}`);
    }
  }
  return entries;
}
