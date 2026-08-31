const agentSessionFields = ["source", "agent", "kind", "value"];

export function sameAgentSession(left, right) {
  return Boolean(left && right && agentSessionFields.every((field) => left[field] === right[field]));
}

export function canRecoverAgentSession(session) {
  return session?.agent === "codex" && session?.kind === "id";
}
