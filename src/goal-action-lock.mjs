import { join } from "node:path";
import { acquireFilesystemLock } from "./filesystem-lock.mjs";

const GOAL_ID = /^g_[a-zA-Z0-9_-]+$/;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_MS = 25;
async function acquire(root, goalId, { timeoutMs, retryMs }) {
  if (!GOAL_ID.test(goalId)) throw new Error("invalid goal ID for action lock");
  return acquireFilesystemLock(join(root, ".action-locks", goalId), {
    label: `goal action lock ${goalId}`,
    timeoutMs,
    retryMs,
  });
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
