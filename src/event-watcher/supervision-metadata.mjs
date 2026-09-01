const GOAL_ID = /^g_[a-zA-Z0-9_-]+$/;

export function supervisionGoal(body) {
  const lines = String(body || "").split(/\r?\n/);
  const matches = [];
  let inSupervision = false;
  for (const line of lines) {
    if (line.trim() === "## Supervision") {
      inSupervision = true;
      continue;
    }
    if (/^#{1,2}(\s|$)/.test(line)) {
      inSupervision = false;
      continue;
    }
    if (!inSupervision || !/^\s*-\s*Goal ID:/.test(line)) continue;
    const match = /^\s*-\s*Goal ID:\s*(?:"(g_[a-zA-Z0-9_-]+)"|(g_[a-zA-Z0-9_-]+))\s*$/.exec(line);
    if (!match) return undefined;
    const goalId = match[1] || match[2];
    if (goalId && GOAL_ID.test(goalId)) matches.push(goalId);
  }
  return matches.length === 1 ? matches[0] : undefined;
}
