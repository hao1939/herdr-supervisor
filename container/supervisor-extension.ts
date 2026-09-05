// Explicit entry point for the one dedicated supervisor Pi session.
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { atomicReplaceFile } from "../src/atomic-file.ts";
import { herdrSupervisor } from "../src/extension.ts";

const supervisorGoals =
  process.env.HERDR_SUPERVISOR_GOALS
  || join(process.env.XDG_STATE_HOME || "/home/node/.local/state", "herdr-supervisor", "goals");
const supervisorPaneFile = join(supervisorGoals, ".supervisor", "pane-id");

async function markerPane() {
  try {
    return (await readFile(supervisorPaneFile, "utf8")).split(/\r?\n/, 1)[0];
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function rememberSupervisorSession(ctx, mayTransfer) {
  const paneId = process.env.HERDR_PANE_ID;
  const sessionFile = ctx?.sessionManager?.getSessionFile?.();
  const sessionId = ctx?.sessionManager?.getSessionId?.();
  if (!paneId || !sessionFile || !sessionId || paneId.includes("\n") || sessionFile.includes("\n") || sessionId.includes("\n")) {
    return false;
  }
  await mkdir(dirname(supervisorPaneFile), { recursive: true, mode: 0o700 });
  const release = await lockfile.lock(supervisorPaneFile, {
    realpath: false,
    retries: { retries: 10, factor: 1, minTimeout: 10, maxTimeout: 10 },
    stale: 30_000,
    update: 10_000,
  });
  try {
    if (!mayTransfer && await markerPane() !== paneId) return false;
    await atomicReplaceFile(supervisorPaneFile, `${paneId}\n${sessionFile}\n${sessionId}\n`);
    return true;
  } finally {
    await release();
  }
}

export default function explicitSupervisor(pi, services) {
  let initialSession = true;
  pi.on("session_start", async (_event, ctx) => {
    const mayTransfer = initialSession;
    initialSession = false;
    let remembered = false;
    try {
      remembered = await rememberSupervisorSession(ctx, mayTransfer);
    } finally {
      if (mayTransfer && !remembered) initialSession = true;
    }
  });
  return herdrSupervisor(pi, services);
}
