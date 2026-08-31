import { createHash } from "node:crypto";

function parse(subject) {
  const match = /^([^/]+)\/([^#]+)#([1-9]\d*)$/.exec(subject);
  if (!match) throw new Error("GitHub PR subject must look like owner/repository#number");
  return { owner: match[1], repository: match[2], number: Number(match[3]) };
}

async function json(response, label) {
  if (!response.ok) {
    const body = (await response.text()).slice(0, 300);
    throw new Error(`${label} returned HTTP ${response.status}${body ? `: ${body}` : ""}`);
  }
  return response.json();
}

export function githubPullRequestSource({ fetchImpl = fetch, token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN } = {}) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "event-watchd-poc",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  return {
    async read(subject) {
      const { owner, repository, number } = parse(subject);
      const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
      const pull = await json(await fetchImpl(`${base}/pulls/${number}`, {
        headers,
        signal: AbortSignal.timeout(30_000),
      }), "GitHub pull request");
      const checks = await json(await fetchImpl(`${base}/commits/${pull.head.sha}/check-runs?per_page=100`, {
        headers,
        signal: AbortSignal.timeout(30_000),
      }), "GitHub checks");
      const stableChecks = checks.check_runs.map((check) => ({
        name: check.name,
        status: check.status,
        conclusion: check.conclusion,
      })).sort((left, right) => left.name.localeCompare(right.name));
      const stable = {
        head: pull.head.sha,
        state: pull.state,
        draft: pull.draft,
        mergeable: pull.mergeable,
        mergeableState: pull.mergeable_state,
        checks: stableChecks,
      };
      return {
        revision: createHash("sha256").update(JSON.stringify(stable)).digest("hex"),
        payload: {
          head: pull.head.sha,
          state: pull.state,
          draft: pull.draft,
          checks: stableChecks,
        },
      };
    },
  };
}
