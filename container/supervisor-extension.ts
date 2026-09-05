// Explicit entry point for the one dedicated supervisor Pi session.
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { atomicReplaceFile } from "../src/atomic-file.ts";
import { herdrSupervisor } from "../src/extension.ts";

const supervisorGoals =
  process.env.HERDR_SUPERVISOR_GOALS
  || join(process.env.XDG_STATE_HOME || "/home/node/.local/state", "herdr-supervisor", "goals");
const supervisorPaneFile = join(supervisorGoals, ".supervisor", "pane-id");

async function rememberSupervisorSession(ctx) {
  const paneId = process.env.HERDR_PANE_ID;
  const sessionFile = ctx?.sessionManager?.getSessionFile?.();
  const sessionId = ctx?.sessionManager?.getSessionId?.();
  if (!paneId || !sessionFile || !sessionId || paneId.includes("\n") || sessionFile.includes("\n") || sessionId.includes("\n")) {
    return;
  }
  await mkdir(dirname(supervisorPaneFile), { recursive: true, mode: 0o700 });
  await atomicReplaceFile(supervisorPaneFile, `${paneId}\n${sessionFile}\n${sessionId}\n`);
}

export default function explicitSupervisor(pi, services) {
  pi.on("session_start", async (_event, ctx) => {
    await rememberSupervisorSession(ctx);
  });
  return herdrSupervisor(pi, services);
}
