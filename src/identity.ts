export { sameAgentSession } from "./agent-session.ts";

export function canRecoverAgentSession(session) {
  return session?.agent === "codex" && session?.kind === "id";
}
