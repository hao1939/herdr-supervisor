import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const EXTERNAL_WATCH_SOURCES = ["github-pr", "ado-build"] as const;
export type ExternalWatchSource = typeof EXTERNAL_WATCH_SOURCES[number];

export type ExternalWatch = {
  source: ExternalWatchSource;
  subject: string;
  revision?: string;
  nextPollAt: number;
  lastError?: string;
};

export type ExternalWatchRequest = Pick<ExternalWatch, "source" | "subject" | "revision">;

type ExternalRead = {
  revision: string;
  summary: string;
};

export type ExternalSource = {
  read(subject: string): Promise<ExternalRead>;
};

export type ExternalObservation = ExternalWatchRequest & {
  goalId: string;
  ok: boolean;
  observedRevision?: string;
  changed?: boolean;
  summary?: string;
  error?: string;
};

const MAX_TEXT = 2_000;
const ADO_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798";
const execFileAsync = promisify(execFile);

function requiredText(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_TEXT) {
    throw new Error(`${field} must be a non-empty string no longer than ${MAX_TEXT} characters`);
  }
  return value.trim();
}

function stableRevision(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function responseJson(response: Response, label: string) {
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
  return response.json();
}

async function pagedItems(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  field: string,
  label: string,
) {
  const items: any[] = [];
  for (let page = 1; page <= 20; page += 1) {
    const separator = url.includes("?") ? "&" : "?";
    const value: any = await responseJson(await fetchImpl(
      `${url}${separator}per_page=100&page=${page}`,
      { headers, signal: AbortSignal.timeout(30_000) },
    ), label);
    const batch = value[field];
    if (!Array.isArray(batch)) throw new Error(`${label} returned an invalid ${field} list`);
    items.push(...batch);
    if (batch.length < 100) return items;
  }
  throw new Error(`${label} exceeded the bounded 2,000-item observation limit`);
}

function parseGitHubSubject(subject: string) {
  const match = /^([^/]+)\/([^/#]+)#([1-9]\d*)$/.exec(subject);
  if (!match) throw new Error("GitHub PR subject must look like owner/repository#number");
  return { owner: match[1], repository: match[2], number: Number(match[3]) };
}

export function githubPullRequestSource({
  fetchImpl = fetch,
  token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
}: { fetchImpl?: typeof fetch; token?: string } = {}): ExternalSource {
  return {
    async read(subject) {
      const { owner, repository, number } = parseGitHubSubject(subject);
      const headers = {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "herdr-supervisor",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      };
      const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
      const pull: any = await responseJson(
        await fetchImpl(`${base}/pulls/${number}`, { headers, signal: AbortSignal.timeout(30_000) }),
        "GitHub pull request",
      );
      const commit = `${base}/commits/${encodeURIComponent(pull.head.sha)}`;
      const [checks, statuses] = await Promise.all([
        pagedItems(fetchImpl, `${commit}/check-runs?filter=latest`, headers, "check_runs", "GitHub check runs"),
        pagedItems(fetchImpl, `${commit}/status`, headers, "statuses", "GitHub commit statuses"),
      ]);
      const compactChecks = checks.map((check) => ({
        id: check.id,
        name: String(check.name).slice(0, 200),
        status: check.status,
        conclusion: check.conclusion,
      })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
      const compactStatuses = statuses.map((status) => ({
        id: status.id,
        context: String(status.context).slice(0, 200),
        state: status.state,
      })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
      const stable = {
        headSha: pull.head.sha,
        state: pull.state,
        draft: pull.draft,
        mergeable: pull.mergeable,
        checks: compactChecks,
        statuses: compactStatuses,
      };
      const completed = compactChecks.filter((check) => check.status === "completed").length
        + compactStatuses.filter((status) => status.state !== "pending").length;
      const total = compactChecks.length + compactStatuses.length;
      return {
        revision: stableRevision(stable),
        summary: `GitHub PR ${owner}/${repository}#${number} is ${pull.state}; ${completed}/${total} checks completed`,
      };
    },
  };
}

function parseAdoSubject(subject: string) {
  const match = /^([^/]+)\/([^/]+)\/([1-9]\d*)$/.exec(subject);
  if (!match) throw new Error("ADO build subject must look like organization/project/build-id");
  return { organization: match[1], project: match[2], buildId: Number(match[3]) };
}

async function ambientAdoAuthorization() {
  const pat = process.env.AZURE_DEVOPS_EXT_PAT;
  if (pat) return `Basic ${Buffer.from(`:${pat}`).toString("base64")}`;
  try {
    const { stdout } = await execFileAsync("az", [
      "account",
      "get-access-token",
      "--resource",
      ADO_RESOURCE,
      "--query",
      "accessToken",
      "--output",
      "tsv",
    ], { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 });
    return `Bearer ${requiredText(stdout, "Azure access token")}`;
  } catch {
    throw new Error("could not obtain Azure DevOps credentials; renew az login or set AZURE_DEVOPS_EXT_PAT");
  }
}

export function adoBuildSource({
  fetchImpl = fetch,
  authorization,
}: { fetchImpl?: typeof fetch; authorization?: string } = {}): ExternalSource {
  return {
    async read(subject) {
      const { organization, project, buildId } = parseAdoSubject(subject);
      const auth = authorization || await ambientAdoAuthorization();
      const url = `https://dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(project)}`
        + `/_apis/build/builds/${buildId}?api-version=7.1`;
      const build: any = await responseJson(await fetchImpl(url, {
        headers: { Accept: "application/json", Authorization: auth },
        signal: AbortSignal.timeout(30_000),
      }), "Azure DevOps build");
      const stable = {
        id: build.id,
        status: build.status,
        result: build.result || null,
        sourceVersion: build.sourceVersion,
        finishTime: build.finishTime || null,
      };
      return {
        revision: stableRevision(stable),
        summary: `ADO build ${organization}/${project}/${buildId} is ${build.status}`
          + (build.result ? ` (${build.result})` : ""),
      };
    },
  };
}

export function defaultExternalSources(): Record<ExternalWatchSource, ExternalSource> {
  return {
    "github-pr": githubPullRequestSource(),
    "ado-build": adoBuildSource(),
  };
}

/** Read each exact subject once and fan the result out to its waiting goals. */
export async function observeExternalWatches(
  watches: Array<ExternalWatchRequest & { goalId: string }>,
  sources: Partial<Record<ExternalWatchSource, ExternalSource>> = defaultExternalSources(),
): Promise<ExternalObservation[]> {
  const groups = new Map<string, {
    source: ExternalWatchSource;
    subject: string;
    watches: Array<ExternalWatchRequest & { goalId: string }>;
  }>();
  for (const input of watches) {
    const watch = {
      goalId: requiredText(input.goalId, "goalId"),
      source: input.source,
      subject: requiredText(input.subject, "subject"),
      revision: input.revision === undefined ? undefined : requiredText(input.revision, "revision"),
    };
    if (!EXTERNAL_WATCH_SOURCES.includes(watch.source)) {
      throw new Error(`unsupported external source ${watch.source}`);
    }
    const identity = JSON.stringify([watch.source, watch.subject]);
    const group = groups.get(identity) || { source: watch.source, subject: watch.subject, watches: [] };
    group.watches.push(watch);
    groups.set(identity, group);
  }

  const batches = await Promise.all([...groups.values()].map(async (group) => {
    const source = sources[group.source];
    if (!source) {
      return group.watches.map((watch) => ({
        ...watch,
        ok: false,
        error: `unsupported external source ${group.source}`,
      }));
    }
    try {
      const result = await source.read(group.subject);
      const revision = requiredText(result.revision, "observed revision");
      const summary = requiredText(result.summary, "observed summary");
      return group.watches.map((watch) => ({
        ...watch,
        ok: true,
        observedRevision: revision,
        changed: watch.revision !== undefined && watch.revision !== revision,
        summary,
      }));
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error).slice(0, MAX_TEXT);
      return group.watches.map((watch) => ({ ...watch, ok: false, error: message }));
    }
  }));
  return batches.flat();
}
