import { createHash } from "node:crypto";
import { ambientAdoAuthorization } from "./ado-build.mjs";
import { boundedRefreshWindow } from "./refresh-window.mjs";
import { supervisionGoal } from "./supervision-metadata.mjs";

const MAX_REPOSITORIES = 10;
const MAX_ACTIVE_PULLS = 100;
const MAX_ANNOTATED_PULLS = 20;
const MAX_REMEMBERED_REFRESH = 10;
const MAX_EVIDENCE_ITEMS = 25;
const MAX_POLICIES = 100;
const ADO_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseRepository(value) {
  const match = /^([^/]+)\/([^/]+)\/([^/]+)$/.exec(value);
  if (!match) throw new Error(`ADO repository must look like organization/project/repository: ${value}`);
  return { organization: match[1], project: match[2], repository: match[3] };
}

function parseSubject(value) {
  const match = /^([^/]+)\/([^/]+)\/([^/]+)\/([1-9]\d*)$/.exec(value);
  return match ? {
    organization: match[1],
    project: match[2],
    repository: match[3],
    pullRequestId: Number(match[4]),
  } : undefined;
}

async function json(fetchImpl, url, authorization, label, signal) {
  const response = await fetchImpl(url, {
    headers: { Accept: "application/json", Authorization: authorization },
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

function completeCollection(result, label) {
  if (!Array.isArray(result?.value)) throw new Error(`${label} returned an invalid collection`);
  if (Number.isInteger(result.count) && result.count > result.value.length) {
    throw new Error(`${label} returned truncated state; refusing a partial revision`);
  }
  return result.value;
}

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function byJson(left, right) {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

function baseUrl(scope) {
  return `https://dev.azure.com/${encodeURIComponent(scope.organization)}/${encodeURIComponent(scope.project)}`;
}

function pullUrl(scope, suffix = "") {
  return `${baseUrl(scope)}/_apis/git/repositories/${encodeURIComponent(scope.repository)}/pullRequests${suffix}`;
}

function subjectFor(scope, pullRequestId) {
  return `${scope.organization}/${scope.project}/${scope.repository}/${pullRequestId}`;
}

function matchesCreator(pull, creatorId) {
  return !creatorId || (typeof pull.createdBy?.id === "string"
    && pull.createdBy.id.toLowerCase() === creatorId);
}

function pullRevision(pull, threads, policies) {
  const reviewers = (Array.isArray(pull.reviewers) ? pull.reviewers : []).map((reviewer) => ({
    id: reviewer.id,
    vote: reviewer.vote,
    isFlagged: Boolean(reviewer.isFlagged),
    hasDeclined: Boolean(reviewer.hasDeclined),
  })).sort(byJson);
  const discussions = threads.map((thread) => ({
    id: thread.id,
    status: thread.status || null,
    isDeleted: Boolean(thread.isDeleted),
    lastUpdatedDate: thread.lastUpdatedDate || null,
    comments: (Array.isArray(thread.comments) ? thread.comments : []).map((comment) => ({
      id: comment.id,
      commentType: comment.commentType || null,
      isDeleted: Boolean(comment.isDeleted),
      lastUpdatedDate: comment.lastUpdatedDate || null,
    })).sort(byJson),
  })).sort(byJson);
  const evaluations = policies.map((policy) => ({
    id: policy.evaluationId,
    configurationId: policy.configuration?.id,
    status: policy.status,
    startedDate: policy.startedDate || null,
    completedDate: policy.completedDate || null,
  })).sort(byJson);
  const stable = {
    head: pull.lastMergeSourceCommit?.commitId || null,
    status: pull.status,
    draft: Boolean(pull.isDraft),
    mergeStatus: pull.mergeStatus || null,
    closedDate: pull.closedDate || null,
    completionQueueTime: pull.completionQueueTime || null,
    reviewers,
    discussions,
    evaluations,
  };
  const discussionSummary = discussions.map((discussion) => ({
    id: discussion.id,
    status: discussion.status,
    isDeleted: discussion.isDeleted,
    lastUpdatedDate: discussion.lastUpdatedDate,
    commentCount: discussion.comments.length,
  }));
  return {
    revision: hash(stable),
    payload: {
      head: stable.head,
      status: stable.status,
      draft: stable.draft,
      mergeStatus: stable.mergeStatus,
      reviewers: reviewers.slice(0, MAX_EVIDENCE_ITEMS),
      discussions: discussionSummary.slice(0, MAX_EVIDENCE_ITEMS),
      policies: evaluations.slice(0, MAX_EVIDENCE_ITEMS),
      truncated: reviewers.length > MAX_EVIDENCE_ITEMS
        || discussions.length > MAX_EVIDENCE_ITEMS
        || evaluations.length > MAX_EVIDENCE_ITEMS,
    },
  };
}

export function adoPullRequestSource({
  repositories,
  creatorId,
  fetchImpl = fetch,
  authorization,
  getAuthorization = ambientAdoAuthorization,
} = {}) {
  if (!Array.isArray(repositories) || !repositories.length) {
    throw new Error("ADO pull request discovery requires at least one repository");
  }
  if (repositories.length > MAX_REPOSITORIES) {
    throw new Error(`ADO pull request discovery supports at most ${MAX_REPOSITORIES} repositories per watcher`);
  }
  if (creatorId !== undefined && (typeof creatorId !== "string" || !ADO_ID.test(creatorId.trim()))) {
    throw new Error("ADO pull request creator ID must be an Azure DevOps identity UUID");
  }
  const selectedCreatorId = creatorId?.trim().toLowerCase();
  const creatorFilter = selectedCreatorId
    ? `&searchCriteria.creatorId=${encodeURIComponent(selectedCreatorId)}`
    : "";
  const scopes = [...new Set(repositories)].map(parseRepository);
  const allowedRepositories = new Set(repositories);
  const rememberedWindow = boundedRefreshWindow(MAX_REMEMBERED_REFRESH, (resource) => resource.subject);
  const recentWindow = boundedRefreshWindow(
    MAX_ANNOTATED_PULLS - MAX_REMEMBERED_REFRESH,
    (resource) => resource.subject,
  );
  return {
    async scan(known = [], { signal } = {}) {
      signal?.throwIfAborted();
      const auth = authorization || await getAuthorization({ signal });
      const pullsBySubject = new Map();
      const active = [];
      const activeSubjects = new Set();
      const absent = [];
      const warnings = [];
      const remembered = rememberedWindow(known);
      const rememberedSubjects = new Set(remembered.map((resource) => resource.subject));
      const knownSubjects = new Set(known.map((resource) => resource.subject));
      const knownBySubject = new Map(known.map((resource) => [resource.subject, resource]));
      for (const scope of scopes) {
        const result = await json(
          fetchImpl,
          `${pullUrl(scope)}?searchCriteria.status=active${creatorFilter}&$top=${MAX_ACTIVE_PULLS}&api-version=7.1`,
          auth,
          "ADO pull request discovery",
          signal,
        );
        const pulls = completeCollection(result, "ADO pull request discovery");
        if (pulls.length >= MAX_ACTIVE_PULLS) {
          const repository = `${scope.organization}/${scope.project}/${scope.repository}`;
          warnings.push({
            code: `active-pull-window:${repository}`,
            message: `ADO pull request discovery inspected its bounded first ${MAX_ACTIVE_PULLS} active pulls for ${repository}${selectedCreatorId ? ` created by ${selectedCreatorId}` : ""}; additional active pulls may be undiscovered. Already-known pulls are still refreshed by exact identity.`,
          });
        }
        for (const pull of pulls) {
          const subject = subjectFor(scope, pull.pullRequestId);
          active.push({ subject });
          activeSubjects.add(subject);
        }
      }
      const exact = async (subject, scope, knownResource) => {
        try {
          const pull = await json(
            fetchImpl,
            `${pullUrl(scope, `/${scope.pullRequestId}`)}?api-version=7.1`,
            auth,
            "ADO pull request",
            signal,
          );
          pullsBySubject.set(subject, pull);
        } catch (error) {
          if (error?.status === 404 && knownResource) absent.push(subject);
          else if (error?.status !== 404) throw error;
        }
      };
      for (const resource of remembered) {
        const scope = parseSubject(resource.subject);
        if (!scope || !allowedRepositories.has(`${scope.organization}/${scope.project}/${scope.repository}`)) {
          absent.push(resource.subject);
          continue;
        }
        await exact(resource.subject, scope, true);
      }
      for (const candidate of recentWindow(active.filter((item) => !knownSubjects.has(item.subject)))) {
        await exact(candidate.subject, parseSubject(candidate.subject), false);
      }
      for (const resource of known) {
        const pull = pullsBySubject.get(resource.subject);
        if (pull && (!matchesCreator(pull, selectedCreatorId) || !supervisionGoal(pull.description))) {
          absent.push(resource.subject);
        }
      }
      const annotated = [...pullsBySubject.entries()]
        .map(([subject, pull]) => ({ subject, pull, goalId: supervisionGoal(pull.description) }))
        .filter((item) => item.goalId && matchesCreator(item.pull, selectedCreatorId));
      const retained = annotated.filter((item) => rememberedSubjects.has(item.subject));
      const recent = annotated.filter((item) => !rememberedSubjects.has(item.subject));
      const observations = [];
      for (const { subject, pull, goalId } of [...retained, ...recent]) {
        const scope = parseSubject(subject);
        const projectId = pull.repository?.project?.id;
        if (!scope || typeof projectId !== "string" || !projectId) {
          throw new Error("ADO pull request discovery returned a pull without canonical repository project identity");
        }
        const artifactId = `vstfs:///CodeReview/CodeReviewId/${projectId}/${scope.pullRequestId}`;
        const [threadResult, policyResult] = await Promise.all([
          json(
            fetchImpl,
            `${pullUrl(scope, `/${scope.pullRequestId}/threads`)}?api-version=7.1`,
            auth,
            "ADO pull request threads",
            signal,
          ),
          json(
            fetchImpl,
            `${baseUrl(scope)}/_apis/policy/evaluations?artifactId=${encodeURIComponent(artifactId)}&$top=${MAX_POLICIES}&api-version=7.1-preview.1`,
            auth,
            "ADO pull request policies",
            signal,
          ),
        ]);
        const threads = completeCollection(threadResult, "ADO pull request threads");
        const policies = completeCollection(policyResult, "ADO pull request policies");
        if (policies.length >= MAX_POLICIES) {
          throw new Error(`ADO pull request policies reached their ${MAX_POLICIES}-evaluation limit; refusing a partial revision`);
        }
        const current = pullRevision(pull, threads, policies);
        const knownResource = knownBySubject.get(subject);
        if (pull.status !== "active" && !activeSubjects.has(subject)
          && knownResource && !knownResource.pending
          && knownResource.goalId === goalId && knownResource.revision === current.revision) {
          absent.push(subject);
          continue;
        }
        observations.push({ subject, goalId, ...current });
      }
      return {
        observations,
        absent: [...new Set(absent)],
        ...(warnings.length ? { warnings } : {}),
      };
    },
  };
}
