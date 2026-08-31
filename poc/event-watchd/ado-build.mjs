import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const ADO_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798";
const GOAL_TAG = /^herdr-goal=(g_[a-zA-Z0-9_-]+)$/;
const execFileAsync = promisify(execFile);

function parseProject(value) {
  const match = /^([^/]+)\/([^/]+)$/.exec(value);
  if (!match) throw new Error(`ADO project must look like organization/project: ${value}`);
  return { organization: match[1], project: match[2] };
}

export function taggedGoal(tags) {
  const matches = Array.isArray(tags)
    ? tags.map((tag) => GOAL_TAG.exec(tag)?.[1]).filter(Boolean)
    : [];
  return matches.length === 1 ? matches[0] : undefined;
}

export async function ambientAdoAuthorization({
  pat = process.env.AZURE_DEVOPS_EXT_PAT,
  azureCli = process.env.AZURE_CLI || "az",
  exec = execFileAsync,
} = {}) {
  if (pat) return `Basic ${Buffer.from(`:${pat}`).toString("base64")}`;
  try {
    const { stdout } = await exec(azureCli, [
      "account",
      "get-access-token",
      "--resource",
      ADO_RESOURCE,
      "--query",
      "accessToken",
      "--output",
      "tsv",
    ], { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 });
    if (!stdout.trim()) throw new Error("empty Azure access token");
    return `Bearer ${stdout.trim()}`;
  } catch {
    throw new Error("could not obtain Azure DevOps credentials; renew az login or set AZURE_DEVOPS_EXT_PAT");
  }
}

async function json(fetchImpl, url, authorization) {
  const response = await fetchImpl(url, {
    headers: { Accept: "application/json", Authorization: authorization },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Azure DevOps build discovery returned HTTP ${response.status}`);
  return response.json();
}

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function adoBuildDiscovery({
  projects,
  fetchImpl = fetch,
  authorization,
  getAuthorization = ambientAdoAuthorization,
} = {}) {
  if (!Array.isArray(projects) || !projects.length) {
    throw new Error("ADO discovery requires at least one project");
  }
  const scopes = projects.map(parseProject);
  return {
    async scan() {
      const auth = authorization || await getAuthorization();
      const observations = [];
      for (const { organization, project } of scopes) {
        const base = `https://dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(project)}`;
        const result = await json(
          fetchImpl,
          `${base}/_apis/build/builds?queryOrder=lastModifiedDescending&$top=100&api-version=7.1`,
          auth,
        );
        if (!Array.isArray(result.value)) throw new Error("Azure DevOps build discovery returned an invalid list");
        for (const build of result.value) {
          const goalId = taggedGoal(build.tags);
          if (!goalId) continue;
          const stable = {
            id: build.id,
            sourceVersion: build.sourceVersion,
            status: build.status,
            result: build.result || null,
            finishTime: build.finishTime || null,
            lastChangedDate: build.lastChangedDate || null,
          };
          observations.push({
            subject: `${organization}/${project}/${build.id}`,
            goalId,
            revision: hash(stable),
            payload: stable,
          });
        }
      }
      return observations;
    },
  };
}
