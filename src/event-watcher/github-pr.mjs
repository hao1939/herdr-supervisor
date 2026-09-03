import { createHash } from "node:crypto";
import { boundedRefreshWindow } from "./refresh-window.mjs";
import { supervisionGoal } from "./supervision-metadata.mjs";

export { supervisionGoal } from "./supervision-metadata.mjs";

const MAX_REPOSITORIES = 10;
const MAX_ANNOTATED_PULLS = 20;
const MAX_REMEMBERED_REFRESH = 10;
const MAX_EVIDENCE_ITEMS = 25;

function parseRepository(value) {
  const match = /^([^/]+)\/([^/]+)$/.exec(value);
  if (!match) throw new Error(`GitHub repository must look like owner/name: ${value}`);
  return { owner: match[1], repository: match[2] };
}

function parseSubject(value) {
  const match = /^([^/]+)\/([^#]+)#([1-9]\d*)$/.exec(value);
  return match ? { owner: match[1], repository: match[2], number: Number(match[3]) } : undefined;
}

async function json(fetchImpl, url, headers, label, signal) {
  const response = await fetchImpl(url, {
    headers,
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
      : AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const error = new Error(`${label} returned HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function completeCollection(result, field, label) {
  const items = result?.[field];
  if (!Array.isArray(items)) throw new Error(`${label} returned an invalid collection`);
  const total = result.total_count;
  if ((Number.isInteger(total) && total > items.length) || (!Number.isInteger(total) && items.length >= 100)) {
    throw new Error(`${label} returned truncated state; refusing a partial revision`);
  }
  return items;
}

export function githubPullRequestSource({
  repositories,
  fetchImpl = fetch,
  token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
} = {}) {
  if (!Array.isArray(repositories) || !repositories.length) {
    throw new Error("GitHub discovery requires at least one repository");
  }
  if (repositories.length > MAX_REPOSITORIES) {
    throw new Error(`GitHub discovery supports at most ${MAX_REPOSITORIES} repositories per watcher`);
  }
  if (!token) throw new Error("GitHub discovery requires GITHUB_TOKEN or GH_TOKEN");
  const scopes = repositories.map(parseRepository);
  const allowedRepositories = new Set(repositories);
  const rememberedWindow = boundedRefreshWindow(MAX_REMEMBERED_REFRESH, (resource) => resource.subject);
  const recentWindow = boundedRefreshWindow(
    MAX_ANNOTATED_PULLS - MAX_REMEMBERED_REFRESH,
    (resource) => resource.subject,
  );
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "herdr-event-watchd",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  return {
    async scan(known = [], { signal } = {}) {
      signal?.throwIfAborted();
      const observations = [];
      const absent = [];
      const pullsBySubject = new Map();
      const remembered = rememberedWindow(known);
      const rememberedSubjects = new Set(remembered.map((resource) => resource.subject));
      const knownBySubject = new Map(known.map((resource) => [resource.subject, resource]));
      const recentSubjects = new Set();
      for (const { owner, repository } of scopes) {
        const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
        const pulls = await json(
          fetchImpl,
          `${base}/pulls?state=all&sort=updated&direction=desc&per_page=100`,
          headers,
          "GitHub pull request discovery",
          signal,
        );
        if (!Array.isArray(pulls)) throw new Error("GitHub pull request discovery returned an invalid list");
        for (const pull of pulls) {
          const subject = `${owner}/${repository}#${pull.number}`;
          pullsBySubject.set(subject, pull);
          recentSubjects.add(subject);
        }
      }
      for (const resource of remembered) {
        if (pullsBySubject.has(resource.subject)) continue;
        const parsed = parseSubject(resource.subject);
        if (!parsed || !allowedRepositories.has(`${parsed.owner}/${parsed.repository}`)) {
          absent.push(resource.subject);
          continue;
        }
        const base = `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repository)}`;
        try {
          const pull = await json(fetchImpl, `${base}/pulls/${parsed.number}`, headers, "GitHub pull request", signal);
          pullsBySubject.set(resource.subject, pull);
        } catch (error) {
          if (error?.status === 404) absent.push(resource.subject);
          else throw error;
        }
      }
      for (const resource of known) {
        const pull = pullsBySubject.get(resource.subject);
        if (pull && !supervisionGoal(pull.body)) absent.push(resource.subject);
      }
      const annotated = [...pullsBySubject.entries()]
        .map(([subject, pull]) => ({ subject, pull, goalId: supervisionGoal(pull.body) }))
        .filter((item) => item.goalId);
      const retained = annotated.filter((item) => rememberedSubjects.has(item.subject));
      const recent = recentWindow(annotated.filter((item) => !rememberedSubjects.has(item.subject)));
      const selected = [...retained, ...recent];
      for (const { subject, pull, goalId } of selected) {
        const parsed = parseSubject(subject);
        const base = `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repository)}`;
        const commit = `${base}/commits/${encodeURIComponent(pull.head.sha)}`;
        const [checksResult, statusesResult] = await Promise.all([
          json(fetchImpl, `${commit}/check-runs?filter=latest&per_page=100`, headers, "GitHub checks", signal),
          json(fetchImpl, `${commit}/status?per_page=100`, headers, "GitHub statuses", signal),
        ]);
        const checks = completeCollection(checksResult, "check_runs", "GitHub checks").map((check) => ({
          id: check.id,
          name: check.name,
          status: check.status,
          conclusion: check.conclusion,
        })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
        const statuses = completeCollection(statusesResult, "statuses", "GitHub statuses").map((status) => ({
          id: status.id,
          context: status.context,
          state: status.state,
        })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
        const stable = {
          head: pull.head.sha,
          state: pull.state,
          draft: Boolean(pull.draft),
          updatedAt: pull.updated_at,
          checks,
          statuses,
        };
        const revision = hash(stable);
        const knownResource = knownBySubject.get(subject);
        if (pull.state !== "open" && !recentSubjects.has(subject) && knownResource
          && knownResource.goalId === goalId && !knownResource.pending
          && knownResource.revision === revision) {
          absent.push(subject);
          continue;
        }
        observations.push({
          subject,
          goalId,
          revision,
          payload: {
            head: stable.head,
            state: stable.state,
            draft: stable.draft,
            updatedAt: stable.updatedAt,
            checks: checks.slice(0, MAX_EVIDENCE_ITEMS),
            statuses: statuses.slice(0, MAX_EVIDENCE_ITEMS),
            truncated: checks.length > MAX_EVIDENCE_ITEMS || statuses.length > MAX_EVIDENCE_ITEMS,
          },
        });
      }
      return { observations, absent: [...new Set(absent)] };
    },
  };
}
