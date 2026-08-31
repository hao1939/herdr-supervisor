import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const ADO_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798";
const MINIMUM_INTERVAL_MS = 60 * 1_000;
const MAX_RESOURCES = 10;
const MAX_CREDENTIAL_BYTES = 16 * 1024;
const execFileAsync = promisify(execFile);

function credential(value, name) {
  if (typeof value !== "string" || !value.trim()
    || Buffer.byteLength(value.trim()) > MAX_CREDENTIAL_BYTES) {
    throw new Error(`${name} must be non-empty and no larger than ${MAX_CREDENTIAL_BYTES} bytes`);
  }
  return value.trim();
}

function parse(subject) {
  const match = /^([^/]+)\/([^/]+)\/([1-9]\d*)$/.exec(subject);
  if (!match) throw new Error("ADO build subject must look like organization/project/build-id");
  return { organization: match[1], project: match[2], buildId: Number(match[3]) };
}

function retryAfter(response) {
  const value = response.headers.get("retry-after");
  const seconds = value === null ? Number.NaN : Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : undefined;
}

async function json(response) {
  if (!response.ok) {
    const error = new Error(`Azure DevOps build returned HTTP ${response.status}`);
    error.retryAfterMs = retryAfter(response);
    throw error;
  }
  return response.json();
}

export async function ambientAdoAuthorization({
  pat = process.env.AZURE_DEVOPS_EXT_PAT,
  azureCli = process.env.AZURE_CLI || "az",
  exec = execFileAsync,
} = {}) {
  if (pat) return `Basic ${Buffer.from(`:${credential(pat, "Azure DevOps PAT")}`).toString("base64")}`;
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
    return `Bearer ${credential(stdout, "Azure access token")}`;
  } catch {
    throw new Error("could not obtain Azure DevOps credentials; renew az login or set AZURE_DEVOPS_EXT_PAT");
  }
}

export function adoBuildSource({
  fetchImpl = fetch,
  authorization,
  getAuthorization = ambientAdoAuthorization,
} = {}) {
  return {
    minimumIntervalMs: MINIMUM_INTERVAL_MS,
    maxResources: MAX_RESOURCES,
    async read(subject) {
      const { organization, project, buildId } = parse(subject);
      const auth = authorization || await getAuthorization();
      const url = `https://dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(project)}`
        + `/_apis/build/builds/${buildId}?api-version=7.1`;
      const build = await json(await fetchImpl(url, {
        headers: { Accept: "application/json", Authorization: auth },
        signal: AbortSignal.timeout(30_000),
      }));
      const stable = {
        id: build.id,
        status: build.status,
        result: build.result || null,
        sourceVersion: build.sourceVersion,
        finishTime: build.finishTime || null,
      };
      return {
        revision: createHash("sha256").update(JSON.stringify(stable)).digest("hex"),
        payload: stable,
      };
    },
  };
}
