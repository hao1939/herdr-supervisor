import { createHash } from "node:crypto";

const UNAUTHENTICATED_INTERVAL_MS = 5 * 60 * 1_000;
const AUTHENTICATED_INTERVAL_MS = 60 * 1_000;
const PAYLOAD_ITEMS = 25;
const LABEL_LENGTH = 200;

function parse(subject) {
  const match = /^([^/]+)\/([^#]+)#([1-9]\d*)$/.exec(subject);
  if (!match) throw new Error("GitHub PR subject must look like owner/repository#number");
  return { owner: match[1], repository: match[2], number: Number(match[3]) };
}

async function json(response, label) {
  if (!response.ok) {
    const body = (await response.text()).slice(0, 300);
    const error = new Error(`${label} returned HTTP ${response.status}${body ? `: ${body}` : ""}`);
    const retryAfterHeader = response.headers.get("retry-after");
    const resetHeader = response.headers.get("x-ratelimit-reset");
    const retryAfter = retryAfterHeader === null ? Number.NaN : Number(retryAfterHeader);
    const reset = resetHeader === null ? Number.NaN : Number(resetHeader);
    if (Number.isFinite(retryAfter) && retryAfter >= 0) {
      error.retryAfterMs = retryAfter * 1_000;
    } else if (Number.isFinite(reset) && reset > 0) {
      error.retryAfterMs = Math.max(1_000, reset * 1_000 - Date.now());
    }
    throw error;
  }
  return response.json();
}

async function pages(fetchImpl, url, headers, field, label) {
  const items = [];
  for (let page = 1; page <= 20; page += 1) {
    const separator = url.includes("?") ? "&" : "?";
    const result = await json(await fetchImpl(`${url}${separator}per_page=100&page=${page}`, {
      headers,
      signal: AbortSignal.timeout(30_000),
    }), label);
    const batch = result[field];
    if (!Array.isArray(batch)) throw new Error(`${label} returned an invalid ${field} list`);
    items.push(...batch);
    if (batch.length < 100) return items;
  }
  throw new Error(`${label} exceeded the bounded 2,000-item limit`);
}

export function githubPullRequestSource({ fetchImpl = fetch, token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN } = {}) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "event-watchd-poc",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  return {
    minimumIntervalMs: token ? AUTHENTICATED_INTERVAL_MS : UNAUTHENTICATED_INTERVAL_MS,
    maxResources: token ? 10 : 1,
    async read(subject) {
      const { owner, repository, number } = parse(subject);
      const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
      const pull = await json(await fetchImpl(`${base}/pulls/${number}`, {
        headers,
        signal: AbortSignal.timeout(30_000),
      }), "GitHub pull request");
      const commit = `${base}/commits/${encodeURIComponent(pull.head.sha)}`;
      const [checks, statuses] = await Promise.all([
        pages(fetchImpl, `${commit}/check-runs?filter=latest`, headers, "check_runs", "GitHub checks"),
        pages(fetchImpl, `${commit}/status`, headers, "statuses", "GitHub statuses"),
      ]);
      const stableChecks = checks.map((check) => ({
        id: check.id,
        name: String(check.name).slice(0, LABEL_LENGTH),
        status: check.status,
        conclusion: check.conclusion,
      })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
      const stableStatuses = statuses.map((status) => ({
        id: status.id,
        context: String(status.context).slice(0, LABEL_LENGTH),
        state: status.state,
      })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
      const stable = {
        head: pull.head.sha,
        state: pull.state,
        draft: pull.draft,
        mergeable: pull.mergeable,
        mergeableState: pull.mergeable_state,
        checks: stableChecks,
        statuses: stableStatuses,
      };
      return {
        revision: createHash("sha256").update(JSON.stringify(stable)).digest("hex"),
        payload: {
          head: pull.head.sha,
          state: pull.state,
          draft: pull.draft,
          mergeable: pull.mergeable,
          mergeableState: pull.mergeable_state,
          checks: stableChecks.slice(0, PAYLOAD_ITEMS),
          statuses: stableStatuses.slice(0, PAYLOAD_ITEMS),
          totalChecks: stableChecks.length,
          totalStatuses: stableStatuses.length,
          truncated: stableChecks.length > PAYLOAD_ITEMS || stableStatuses.length > PAYLOAD_ITEMS,
        },
      };
    },
  };
}
