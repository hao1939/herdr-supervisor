import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { boundedRefreshWindow } from "./refresh-window.mjs";

const ADO_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798";
const GOAL_TAG = /^herdr-goal=(g_[a-zA-Z0-9_-]+)$/;
const MAX_DEFINITIONS = 10;
const MAX_BUILDS = 500;
const MAX_REMEMBERED_REREADS = 50;
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
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`could not obtain Azure DevOps credentials using ${azureCli}: ${detail}; renew az login, set AZURE_CLI to the Azure CLI executable, or set AZURE_DEVOPS_EXT_PAT`, { cause: error });
  }
}

async function json(fetchImpl, url, authorization) {
  const response = await fetchImpl(url, {
    headers: { Accept: "application/json", Authorization: authorization },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const error = new Error(`Azure DevOps build discovery returned HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function currentBuild(build) {
  const payload = {
    id: build.id,
    sourceVersion: build.sourceVersion,
    status: build.status,
    result: build.result || null,
    finishTime: build.finishTime || null,
  };
  return { revision: hash(payload), payload };
}

export function adoBuildSource({
  definitions,
  fetchImpl = fetch,
  authorization,
  getAuthorization = ambientAdoAuthorization,
} = {}) {
  if (!Array.isArray(definitions) || !definitions.length) {
    throw new Error("ADO discovery requires at least one pipeline definition");
  }
  if (definitions.length > MAX_DEFINITIONS) {
    throw new Error(`ADO discovery supports at most ${MAX_DEFINITIONS} pipeline definitions per watcher`);
  }
  const scopes = definitions.map(parseDefinition);
  const allowedProjects = new Set(scopes.map((scope) => `${scope.organization}/${scope.project}`));
  const allowedDefinitions = new Set(scopes.map((scope) =>
    `${scope.organization}/${scope.project}/${scope.definitionId}`));
  const rereadWindow = boundedRefreshWindow(MAX_REMEMBERED_REREADS, (resource) => resource.subject);
  const recentWindow = boundedRefreshWindow(MAX_BUILDS, ([subject]) => subject);
  return {
    async scan(known = []) {
      const auth = authorization || await getAuthorization();
      const recent = new Map();
      const absent = [];
      for (const { organization, project, definitionId } of scopes) {
        const base = `https://dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(project)}`;
        const result = await json(
          fetchImpl,
          `${base}/_apis/build/builds?definitions=${definitionId}&queryOrder=queueTimeDescending&$top=100&api-version=7.1`,
          auth,
        );
        if (!Array.isArray(result.value)) throw new Error("Azure DevOps build discovery returned an invalid list");
        for (const build of result.value) recent.set(`${organization}/${project}/${build.id}`, build);
      }
      const selected = new Map();
      const missing = [];
      for (const resource of known) {
        const parsed = parseSubject(resource.subject);
        if (!parsed || !allowedProjects.has(`${parsed.organization}/${parsed.project}`)) {
          absent.push(resource.subject);
          continue;
        }
        const current = recent.get(resource.subject);
        if (current) {
          if (!taggedGoal(current.tags)) absent.push(resource.subject);
          continue;
        }
        missing.push({ subject: resource.subject, resource, parsed });
      }
      for (const { subject, resource, parsed } of rereadWindow(missing)) {
        if (selected.size >= MAX_BUILDS) break;
        const base = `https://dev.azure.com/${encodeURIComponent(parsed.organization)}/${encodeURIComponent(parsed.project)}`;
        try {
          const build = await json(
            fetchImpl,
            `${base}/_apis/build/builds/${parsed.buildId}?api-version=7.1`,
            auth,
          );
          const definition = `${parsed.organization}/${parsed.project}/${build.definition?.id}`;
          const goalId = taggedGoal(build.tags);
          if (!goalId || !allowedDefinitions.has(definition)) absent.push(subject);
          else {
            const current = currentBuild(build);
            if (build.status === "completed" && resource.goalId === goalId
              && !resource.pending && resource.revision === current.revision) {
              absent.push(subject);
            } else {
              selected.set(subject, build);
            }
          }
        } catch (error) {
          if (error?.status === 404) absent.push(subject);
          else throw error;
        }
      }
      const recentAnnotated = [...recent].filter(([, build]) => taggedGoal(build.tags));
      for (const [subject, build] of recentWindow(recentAnnotated, MAX_BUILDS - selected.size)) {
        selected.set(subject, build);
      }
      const observations = [];
      for (const [subject, build] of selected) {
        const goalId = taggedGoal(build.tags);
        if (!goalId) continue;
        const current = currentBuild(build);
        observations.push({
          subject,
          goalId,
          ...current,
        });
      }
      return { observations, absent: [...new Set(absent)] };
    },
  };
}
