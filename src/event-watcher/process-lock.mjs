import lockfile from "proper-lockfile";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const STALE_MS = 30_000;
const UPDATE_MS = 10_000;

export async function acquireWatcherLock(statePath) {
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  try {
    return await lockfile.lock(statePath, {
      realpath: false,
      retries: 0,
      stale: STALE_MS,
      update: UPDATE_MS,
    });
  } catch (error) {
    if (error?.code !== "ELOCKED") throw error;
    throw new Error(`event-watchd checkpoint ${statePath} is already owned by another process`, { cause: error });
  }
}
