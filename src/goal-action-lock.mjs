import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

const GOAL_ID = /^g_[a-zA-Z0-9_-]+$/;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_MS = 25;
const OWNER_GRACE_MS = 5_000;

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function linuxStartTime(pid) {
  if (process.platform !== "linux") return undefined;
  try {
    const value = await readFile(`/proc/${pid}/stat`, "utf8");
    const end = value.lastIndexOf(")");
    if (end < 0) return undefined;
    return value.slice(end + 2).split(" ")[19];
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    return undefined;
  }
}

async function processIdentity(pid = process.pid) {
  return { pid, startTime: await linuxStartTime(pid) };
}

async function ownerIsAlive(owner) {
  if (!Number.isInteger(owner?.pid) || owner.pid < 1) return false;
  const currentStart = await linuxStartTime(owner.pid);
  if (currentStart === null) return false;
  if (currentStart !== undefined && owner.startTime !== undefined) {
    return currentStart === owner.startTime;
  }
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function inspectOwner(lockPath) {
  try {
    return JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    const info = await stat(lockPath);
    if (Date.now() - info.mtimeMs < OWNER_GRACE_MS) return undefined;
    return null;
  }
}

async function removeDeadLock(lockPath, owner) {
  if (owner !== null && await ownerIsAlive(owner)) return false;
  let claim;
  try {
    claim = await open(join(lockPath, ".cleanup"), "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST" || error?.code === "ENOENT") return false;
    throw error;
  }
  let removed = false;
  try {
    const current = await inspectOwner(lockPath);
    if (owner !== null && current?.token !== owner.token) return false;
    if (current !== null && current !== undefined && await ownerIsAlive(current)) return false;
    await rm(lockPath, { recursive: true, force: true });
    removed = true;
    return true;
  } finally {
    await claim.close().catch(() => {});
    if (!removed) await unlink(join(lockPath, ".cleanup")).catch(() => {});
  }
}

async function acquire(root, goalId, { timeoutMs, retryMs }) {
  if (!GOAL_ID.test(goalId)) throw new Error("invalid goal ID for action lock");
  const locksRoot = join(root, ".action-locks");
  const lockPath = join(locksRoot, goalId);
  const deadline = Date.now() + timeoutMs;
  const token = randomUUID();
  const identity = await processIdentity();
  await mkdir(locksRoot, { recursive: true, mode: 0o700 });
  while (true) {
    let created = false;
    try {
      await mkdir(lockPath, { mode: 0o700 });
      created = true;
      const owner = { token, ...identity };
      const file = await open(join(lockPath, "owner.json"), "wx", 0o600);
      try {
        await file.writeFile(`${JSON.stringify(owner)}\n`);
      } finally {
        await file.close();
      }
      return async () => {
        let current;
        try { current = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")); }
        catch (error) {
          if (error?.code === "ENOENT") throw new Error(`goal action lock disappeared for ${goalId}`);
          throw error;
        }
        if (current.token !== token) throw new Error(`goal action lock ownership changed for ${goalId}`);
        await unlink(join(lockPath, "owner.json"));
        await rm(lockPath, { recursive: true });
      };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        if (created) await rm(lockPath, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
    }
    const owner = await inspectOwner(lockPath).catch((error) => {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    });
    if (owner !== undefined && await removeDeadLock(lockPath, owner)) continue;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for goal action lock ${goalId}`);
    await pause(retryMs);
  }
}

export async function withGoalActionLock(root, goalId, operation, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retryMs = DEFAULT_RETRY_MS,
} = {}) {
  const release = await acquire(root, goalId, { timeoutMs, retryMs });
  try {
    return await operation();
  } finally {
    await release();
  }
}
