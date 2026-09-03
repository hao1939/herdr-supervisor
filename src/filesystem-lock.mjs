import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

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

export async function acquireFilesystemLock(lockPath, {
  label = "filesystem lock",
  timeoutMs = 30_000,
  retryMs = 25,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  const token = randomUUID();
  const identity = await processIdentity();
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  while (true) {
    let created = false;
    try {
      await mkdir(lockPath, { mode: 0o700 });
      created = true;
      const file = await open(join(lockPath, "owner.json"), "wx", 0o600);
      try {
        await file.writeFile(`${JSON.stringify({ token, ...identity })}\n`);
      } finally {
        await file.close();
      }
      return async () => {
        let current;
        try { current = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")); }
        catch (error) {
          if (error?.code === "ENOENT") throw new Error(`${label} disappeared`);
          throw error;
        }
        if (current.token !== token) throw new Error(`${label} ownership changed`);
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
    if (Date.now() >= deadline) {
      if (timeoutMs === 0) throw new Error(`${label} is already owned by another live process`);
      throw new Error(`timed out waiting for ${label}`);
    }
    await pause(retryMs);
  }
}
