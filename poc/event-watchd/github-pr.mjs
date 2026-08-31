import { createHash } from "node:crypto";
import { MAX_DATA_BYTES } from "./protocol.mjs";

const UNAUTHENTICATED_INTERVAL_MS = 5 * 60 * 1_000;
const AUTHENTICATED_INTERVAL_MS = 60 * 1_000;
const AUTHENTICATED_RESOURCES = 7;
const AUTHENTICATED_PAGES = 5;
const UNAUTHENTICATED_PAGES = 1;
const CAPACITY_RETRY_MS = 60 * 60 * 1_000;
const AUTHENTICATED_REQUESTS_PER_HOUR = 4_500;
const UNAUTHENTICATED_REQUESTS_PER_HOUR = 50;
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

async function pages(fetchImpl, url, headers, field, label, maxPages) {
  const items = [];
  for (let page = 1; page <= maxPages; page += 1) {
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
  const error = new Error(`${label} exceeded the bounded ${maxPages * 100}-item limit`);
  error.retryAfterMs = CAPACITY_RETRY_MS;
  throw error;
}

function requestBudget(fetchImpl, limit, now) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("GitHub request limit must be a positive integer");
  const timestamps = [];
  return async (input, init) => {
    const cutoff = now() - CAPACITY_RETRY_MS;
    while (timestamps[0] <= cutoff) timestamps.shift();
    if (timestamps.length >= limit) {
      const error = new Error(`GitHub source reached its ${limit}-request hourly budget`);
      error.retryAfterMs = Math.max(1_000, timestamps[0] + CAPACITY_RETRY_MS - now());
      throw error;
    }
    timestamps.push(now());
    return fetchImpl(input, init);
  };
}

function payloadFor(stable, checks, statuses) {
  const payload = {
    ...stable,
    checks: checks.slice(0, PAYLOAD_ITEMS),
    statuses: statuses.slice(0, PAYLOAD_ITEMS),
    totalChecks: checks.length,
    totalStatuses: statuses.length,
    truncated: checks.length > PAYLOAD_ITEMS || statuses.length > PAYLOAD_ITEMS,
  };
  while (Buffer.byteLength(JSON.stringify(payload)) > MAX_DATA_BYTES) {
    if (!payload.checks.length && !payload.statuses.length) {
      throw new Error("GitHub pull request metadata exceeds the bounded payload limit");
    }
    if (payload.checks.length >= payload.statuses.length && payload.checks.length) payload.checks.pop();
    else payload.statuses.pop();
    payload.truncated = true;
  }
  return payload;
}

export function githubPullRequestSource({
  fetchImpl = fetch,
  token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
  requestLimit = token ? AUTHENTICATED_REQUESTS_PER_HOUR : UNAUTHENTICATED_REQUESTS_PER_HOUR,
  now = () => Date.now(),
} = {}) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "event-watchd-poc",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const maxPages = token ? AUTHENTICATED_PAGES : UNAUTHENTICATED_PAGES;
  const budgetedFetch = requestBudget(fetchImpl, requestLimit, now);
  return {
    minimumIntervalMs: token ? AUTHENTICATED_INTERVAL_MS : UNAUTHENTICATED_INTERVAL_MS,
    maxResources: token ? AUTHENTICATED_RESOURCES : 1,
    async read(subject) {
      const { owner, repository, number } = parse(subject);
      const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
      const pull = await json(await budgetedFetch(`${base}/pulls/${number}`, {
        headers,
        signal: AbortSignal.timeout(30_000),
      }), "GitHub pull request");
      const commit = `${base}/commits/${encodeURIComponent(pull.head.sha)}`;
      const [checks, statuses] = await Promise.all([
        pages(budgetedFetch, `${commit}/check-runs?filter=latest`, headers, "check_runs", "GitHub checks", maxPages),
        pages(budgetedFetch, `${commit}/status`, headers, "statuses", "GitHub statuses", maxPages),
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
        payload: payloadFor({
          head: pull.head.sha,
          state: pull.state,
          draft: pull.draft,
          mergeable: pull.mergeable,
          mergeableState: pull.mergeable_state,
        }, stableChecks, stableStatuses),
      };
    },
  };
}
