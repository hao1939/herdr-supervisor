export { sameAgentSession } from "./agent-session.ts";

export function canRecoverAgentSession(session) {
  return session?.agent === "codex" && session?.kind === "id";
}

export function canResumeNativeGoal(session, status) {
  return session?.agent === "codex" && ["idle", "done"].includes(status);
}
