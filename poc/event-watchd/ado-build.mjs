import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const ADO_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798";
const GOAL_TAG = /^herdr-goal=(g_[a-zA-Z0-9_-]+)$/;
const execFileAsync = promisify(execFile);

function parseDefinition(value) {
  const match = /^([^/]+)\/([^/]+)\/([1-9]\d*)$/.exec(value);
  if (!match) throw new Error(`ADO definition must look like organization/project/definition-id: ${value}`);
  return { organization: match[1], project: match[2], definitionId: Number(match[3]) };
}

function parseSubject(value) {
  const match = /^([^/]+)\/([^/]+)\/([1-9]\d*)$/.exec(value);
  return match ? { organization: match[1], project: match[2], buildId: Number(match[3]) } : undefined;
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
  definitions,
  fetchImpl = fetch,
  authorization,
  getAuthorization = ambientAdoAuthorization,
} = {}) {
  if (!Array.isArray(definitions) || !definitions.length) {
    throw new Error("ADO discovery requires at least one pipeline definition");
  }
  const scopes = definitions.map(parseDefinition);
  const allowedProjects = new Set(scopes.map((scope) => `${scope.organization}/${scope.project}`));
  return {
    async scan(known = []) {
      const auth = authorization || await getAuthorization();
      const builds = new Map();
      for (const { organization, project, definitionId } of scopes) {
        const base = `https://dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(project)}`;
        const result = await json(
          fetchImpl,
          `${base}/_apis/build/builds?definitions=${definitionId}&queryOrder=queueTimeDescending&$top=100&api-version=7.1`,
          auth,
        );
        if (!Array.isArray(result.value)) throw new Error("Azure DevOps build discovery returned an invalid list");
        for (const build of result.value) builds.set(`${organization}/${project}/${build.id}`, build);
      }
      for (const resource of known) {
        if (builds.has(resource.subject)) continue;
        const parsed = parseSubject(resource.subject);
        if (!parsed || !allowedProjects.has(`${parsed.organization}/${parsed.project}`)) continue;
        const base = `https://dev.azure.com/${encodeURIComponent(parsed.organization)}/${encodeURIComponent(parsed.project)}`;
        const build = await json(fetchImpl, `${base}/_apis/build/builds/${parsed.buildId}?api-version=7.1`, auth);
        builds.set(resource.subject, build);
      }
      const observations = [];
      for (const [subject, build] of builds) {
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
          subject,
          goalId,
          revision: hash(stable),
          payload: stable,
        });
      }
      return observations;
    },
  };
}
