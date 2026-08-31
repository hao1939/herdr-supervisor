export { sameAgentSession } from "./agent-session.ts";

export function canRecoverAgentSession(session) {
  return session?.agent === "codex" && session?.kind === "id";
}

export function canResumeNativeGoal(session, status) {
  return canRecoverAgentSession(session) && ["idle", "done"].includes(status);
}
