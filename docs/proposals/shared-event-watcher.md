# Shared external event watcher

**Status:** Revised PoC design
**Reviewed:** 2026-09-01

## Decision

Use one small daemon to discover annotated external resources, remember their
latest revision, and wake the goal that owns each changed resource.

Workers do not register watches. A pull request, build, or other supported
resource carries its durable Herdr goal ID in provider metadata. Provider
adapters scan configured repositories or projects and return:

```text
resource identity + current revision + durable goal ID
```

The daemon compares the revision with its small checkpoint. On a new revision,
it resolves the goal ID through canonical goal state and wakes that goal's
current exact worker. The worker rereads provider authority and decides what
the change means.

```text
configured provider adapter scans resources
                  |
                  v
      resource + revision + goal ID
                  |
                  v
       compare remembered revision
                  |
                  v
      resolve goal -> current worker
                  |
                  v
            wake the worker

observation or delivery failure -> supervisor diagnostic
```

This is a shared observation optimization. It does not replace native Codex
Goals, Herdr runtime events, supervisor reviews, or bounded health checks.

## Why metadata instead of subscriptions

Explicit subscriptions create lifecycle questions that do not help the goal:

- When should a worker register?
- Must it renew after every PR update, build rerun, or restart?
- When is it safe to unregister?
- What repairs a watch when the resource and subscription disagree?

Provider metadata removes that second lifecycle. The resource itself says
which durable goal owns it for as long as the resource exists. A PR can receive
many commits, reviews, CI runs, status changes, and a later merge. Each changed
revision naturally wakes the same goal. There is no watch ID, renewal, or
cleanup operation.

The invariant is deliberately smaller than a subscription API:

> Attach the goal ID once when creating each provider resource. Never register
> that resource with the watcher.

The revision checkpoint is only the daemon's bounded observation cache. It is
not a registry of what workers currently care about. A worker therefore does
not have to predict when the last interesting update has happened, repair a
lost registration, or unregister after a merge, failed run, restart, or goal
move.

This metadata is not live routing data. It contains only the durable goal ID.
The daemon must not route using a saved pane or native session from a PR body.
It loads canonical goal state at delivery time and verifies the current exact
native worker through Herdr.

## Boundaries

The system has four small responsibilities:

1. **Resource producer:** attaches the current goal ID when it creates a PR or
   queues a build.
2. **Provider adapter:** discovers annotated resources, computes a stable
   revision from authoritative provider fields, and reports when a remembered
   resource is authoritatively absent.
3. **Watcher core:** remembers revisions and requests delivery for changes.
4. **Herdr delivery adapter:** resolves the durable goal to its current exact
   worker and sends a wake hint.

Code observes, remembers, and wakes. It does not decide whether a check passed,
a review is resolved, a PR should merge, or a goal is complete. The worker and
supervisor make those decisions with the goal contract and current evidence.

## Metadata contract

The portable ownership field is:

```text
herdr-goal=<goal-id>
```

Each provider stores it in the simplest durable metadata it already supports:

- GitHub pull requests use the existing secondary `## Supervision` description
  block. The adapter reads only its `Goal ID` value for routing.
- Azure DevOps builds use a build tag such as
  `herdr-goal=g_63bfbf0e-66c1-4d47-89c8-b49ed0087bde`. Azure DevOps
  rejects a colon in the build-tag API path, so the portable spelling uses an
  equals sign.

The human-readable PR block may also show a pane or native session for audit
and debugging. Those values are presentation only. They may become stale and
must never select a delivery target.

Attaching metadata is not watcher registration. It is part of creating the
resource, like linking a work item or naming a source branch. A small creation
tool may add it automatically from the caller's current goal. Workers that use
provider CLIs directly follow the same metadata convention.

The worker path is therefore ordinary provider work:

1. The normal goal prompt already supplies the durable goal ID.
2. The worker creates the PR or queues the build with the provider's existing
   CLI or API.
3. It writes and verifies the goal metadata once on that resource.
4. It continues useful goal work without calling the watcher.

A rerun that creates a new build ID is a new resource, so its ordinary creation
path attaches the same goal tag once. Commits, reviews, statuses, and other
revisions of an existing resource need no worker action. Moving the goal to
another pane or native session also needs no metadata update because delivery
resolves current canonical goal state. Only an intentional move to a different
durable goal changes ownership metadata.

There is no matching unregister operation. The metadata remains useful across
every later revision of that resource. Removing metadata merely makes the
adapter report that resource absent and the watcher forgets its cache entry;
provider retention and a removed configured scope work the same way. Completing
a goal makes later delivery irrelevant. A size bound never evicts another live
resource: the daemon preserves existing exact rereads and visibly defers a new
discovery until authority removes an entry or capacity is increased. None of
those cases needs a worker-owned lifecycle.

## Discovery

The daemon has environment-level provider scopes, such as a GitHub repository
or an Azure DevOps pipeline definition. These scopes are deployment
configuration, not per-worker watches. Definition scope matters in a large ADO
project because unrelated long-running builds can fill a project-wide recent
page and hide a newly queued build.

Each adapter periodically lists a bounded window of recent resources in its
scope and returns only resources with a valid goal ID. It also rereads exact
resources already present in the bounded revision checkpoint. This second read
keeps later updates visible after a resource leaves the recent window; it does
not create a separate subscription record. When more resources are remembered
than one scan may reread, the adapter takes the next bounded window each scan,
so every remembered resource is refreshed within a bounded number of scans and
neither recent nor remembered resources starve. That rotation is disposable
runtime state: after a restart it simply starts again from the beginning.
Recently closed or completed resources stay in the discovery window long enough
to observe their final transition.

Adapters own provider syntax and pagination. The PoC GitHub adapter reads one
maximum-size page of checks and statuses. If GitHub reports more items than
that page contains, the scan fails visibly instead of hashing partial state.
Full pagination can be added if real usage justifies its request and complexity
cost; it is not a correctness shortcut. The core sees only normalized
observations and exact remembered subjects that are now absent:

```json
{
  "source": "ado-build",
  "subject": "organization/project/178997557",
  "goalId": "g_63bfbf0e-66c1-4d47-89c8-b49ed0087bde",
  "revision": "provider-derived-hash",
  "payload": {}
}
```

An omitted recent resource is not automatically absent because bounded scans
may omit healthy older resources. Absence is explicit only after the adapter
checks that remembered subject and proves its metadata, resource, or configured
scope is gone.

The payload is bounded context for the wake hint, not completion evidence.

## Revisions and first discovery

A revision includes only fields whose changes may matter to a worker. Examples:

- PR head, state, draft state, mergeability, reviews, checks, and statuses;
- build source version, status, result, and finish time.

The PoC GitHub adapter derives its revision from the listed pull-request
metadata, which already moves when a review is submitted or dismissed, plus the
head commit's checks and statuses. It does not read mergeability, because that
field is absent from the list response and would cost one extra request per
selected pull request. A mergeability recomputation that changes nothing else,
such as a new base-branch conflict, therefore waits for the bounded goal review
until that request budget is settled.

On first discovery, the daemon records the revision and emits one wake. This
may produce a harmless extra review when a resource was just created, but it
also catches a resource that changed while the daemon was stopped. Avoiding
that one duplicate would require a registration baseline or more recovery
state, which costs more than the saved model turn.

Every later distinct revision emits another wake. Changes discovered together
for one goal are delivered in one bounded message, and fast consecutive
revisions may coalesce to the newest value because the worker always rereads
provider authority. The watcher is not an audit log.

## Delivery and failure

The delivery input is a durable goal ID, never a pane ID:

1. Load the active goal record.
2. Read its current worker binding.
3. Resolve and verify that exact native session in fresh Herdr state.
4. Resume its native Goal if it is settled.
5. Send a short hint naming the changed resource.

If the goal is already complete, the change is safely ignored. If the goal is
missing, ambiguous, unreadable, or temporarily has no valid worker, delivery
fails closed. The daemon does not guess another worker or create a goal. It
records one bounded diagnostic for the supervisor, which uses ordinary goal
reasoning and tools to repair the situation.

The daemon resolves the environment's one Pi supervisor from fresh Herdr state
and sends it a bounded diagnostic. It persists no supervisor destination. If
the supervisor is missing or ambiguous, the diagnostic fails closed, remains
visible in service stderr, and is retried on the next failing scan.

Replacing the current watcher still has several production gates:

- the final exact-worker check and Herdr prompt are separate requests, so Herdr
  needs a session-addressed or atomic prompt boundary;
- an in-progress provider scan needs bounded cancellation during shutdown;
- GitHub discovery needs an authenticated request budget and provider-directed
  backoff before it is enabled continuously.

These are delivery and observation hardening requirements, not reasons to add
watch registration. The PoC stays draft until live frequency and deployment
scale justify the smallest fixes.

A wake is at-least-once. A crash near delivery may produce the same hint again.
That is acceptable because the worker rereads authority and provider actions
must be idempotent or independently verified.

A failed wake remains pending, but it is retried only after the exact resource
appears in a successful current scan. If provider authority is unavailable, the
daemon keeps the pending revision and sends nothing. This prevents an older
remembered revision from being delivered after the provider may already have
advanced.

When the checkpoint is full and a new resource appears, the daemon still retries
currently observed pending deliveries, preserves every remembered resource, and
sends one coalesced capacity diagnostic naming the deferred current resources.
An authoritative absence or configured-scope removal frees a slot naturally.
The daemon never silently exceeds the bound or drops the only address for a
later exact reread.

## Minimal state

The daemon keeps one atomically replaced bounded checkpoint:

```text
(source, subject) -> goal ID, latest revision, time that revision was first observed,
                     optional latest undelivered revision
```

It does not persist:

- watch IDs;
- destinations;
- worker sessions or panes;
- predicates or expected terminal states;
- task, attempt, review, or workflow state;
- provider credentials.

Entries are removed only when provider authority reports the resource absent or
its provider scope is removed. At the size bound, new discoveries are deferred
with one coalesced diagnostic. This keeps resource lifetime exact without a
registration cleanup protocol.

Provider schedules, open connections, and retry timers are disposable. On
restart the daemon reloads the checkpoint, rescans configured scopes, and
retries the latest pending delivery. Credentials are reread from the
environment.

## Process placement

Run one daemon per trusted Herdr environment. The container or service manager
owns its lifetime. The watcher is not hosted by an interactive worker and does
not require a worker-facing socket because workers have no register, renew,
unregister, list, or read operations.

Herdr Supervisor supplies the goal resolver and wake adapter. Provider adapters
remain small modules that can later consume webhooks or service hooks instead
of polling without changing the observation contract.

Configured scopes must also define who may write trusted ownership metadata.
The current GitHub PR-body convention is appropriate only when a trusted worker
or maintainer owns that block. A public contributor can edit their own PR body,
so production use for public intake needs a maintainer- or bot-authored
metadata record. This changes only provider authorization; it does not create
a subscription lifecycle.

The provisioner has only two integration duties:

- start the daemon with its configured provider scopes; and
- make the goal metadata convention available to workers and creation tools.

## Live evidence

The MLVM experiment now proves the metadata path end to end for goal
`g_63bfbf0e-66c1-4d47-89c8-b49ed0087bde` and its exact current worker in pane
`w1:p11`:

- Builds `178997557`, `179017733`, and `179018392` carry the durable goal tag;
  the worker registered no watch.
- First discovery woke the exact worker. The worker reread ADO authority and
  reconciled the resources instead of treating the hint as completion proof.
- Canceling duplicate build `179018392` produced later revisions and another
  wake without renewal. Its final state is completed/canceled.
- Repeated unchanged scans of build `179017733` produced no new wake. After the
  daemon restarted with its existing checkpoint, the build changed from
  `notStarted` to `inProgress` at `2026-08-31T19:31:37Z`; the watcher recorded
  the new revision at `19:31:43Z` and woke the same Codex session
  `01a04ca8-8771-7473-8e20-cebef028f430`.
- That worker reread the exact build and SHA, recorded its own durable
  checkpoint, and continued independent goal work while leaving terminal ADO
  proof event-driven.
- The shared daemon remained healthy and retained all three latest revisions in
  its bounded checkpoint.
- The current PoC runtime was then deployed over the same checkpoint. A direct
  container start initially lacked the user-local Azure CLI on `PATH`; the
  existing `AZURE_CLI` environment setting fixed that deployment boundary
  without adding credentials or watcher state. The resulting provider failure
  reached the Pi supervisor, whose existing goal checkpoint records the
  diagnostic and its decision to steer the same worker.
- On the recovered daemon, build `179017733` exposed another real revision. The
  checkpoint advanced, the pending wake cleared, and exact Codex session
  `01a04ca8-8771-7473-8e20-cebef028f430` in pane `w1:p11` returned to
  `working`. The worker reconciled the changed build, finished a useful PR
  readiness checkpoint, and moved to another independent route instead of
  polling. Later unchanged scans left the checkpoint timestamp unchanged.

The metadata lifecycle and live ADO path are proven. The production gates above
remain open, so this PoC does not replace the current watcher yet.

## PoC acceptance

The revised PoC is useful only if it proves all of these with a real goal:

1. Creating an annotated PR or build requires no watcher registration.
2. First discovery wakes the exact current worker once.
3. A later provider update wakes it again without renewal.
4. Moving or resuming the goal still routes through current canonical state.
5. Restart preserves enough revision state to avoid losing a later change.
6. Duplicate delivery is harmless and a missing worker fails closed.
7. Provider or delivery failure becomes a visible supervisor diagnostic.
8. Workers do no polling and can continue independent goal work meanwhile.

Start with one GitHub repository and one Azure DevOps project. Do not add
webhooks, a worker CLI, a socket protocol, predicates, acknowledgements, or a
generic workflow API until live evidence proves one is needed.
