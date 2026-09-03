import lockfile from "proper-lockfile";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const DEFAULT_STALE_MS = 30_000;
const DEFAULT_UPDATE_MS = 10_000;

export async function acquireFilesystemLock(lockPath, {
  label = "filesystem lock",
  timeoutMs = 30_000,
  retryMs = 25,
} = {}) {
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const retries = timeoutMs === 0 ? 0 : {
    retries: Math.max(0, Math.ceil(timeoutMs / retryMs) - 1),
    factor: 1,
    minTimeout: retryMs,
    maxTimeout: retryMs,
    randomize: false,
  };

  try {
    return await lockfile.lock(lockPath, {
      realpath: false,
      retries,
      stale: DEFAULT_STALE_MS,
      update: DEFAULT_UPDATE_MS,
    });
  } catch (error) {
    if (error?.code !== "ELOCKED") throw error;
    if (timeoutMs === 0) {
      throw new Error(`${label} is already owned by another live process`, { cause: error });
    }
    throw new Error(`timed out waiting for ${label}`, { cause: error });
  }
}
