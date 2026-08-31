const agentSessionFields = ["source", "agent", "kind", "value"];

export function sameAgentSession(left, right) {
  return Boolean(left && right && agentSessionFields.every((field) => left[field] === right[field]));
}
