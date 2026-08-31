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

This metadata is not live routing data. It contains only the durable goal ID.
The daemon must not route using a saved pane or native session from a PR body.
It loads canonical goal state at delivery time and verifies the current exact
native worker through Herdr.

## Boundaries

The system has four small responsibilities:

1. **Resource producer:** attaches the current goal ID when it creates a PR or
   queues a build.
2. **Provider adapter:** discovers annotated resources and computes a stable
   revision from authoritative provider fields.
3. **Watcher core:** remembers revisions and requests delivery for changes.
4. **Herdr delivery adapter:** resolves the durable goal to its current exact
   worker and sends a wake hint.

Code observes, remembers, and wakes. It does not decide whether a check passed,
a review is resolved, a PR should merge, or a goal is complete. The worker and
supervisor make those decisions with the goal contract and current evidence.

## Metadata contract

The portable ownership field is:

```text
herdr-goal:<goal-id>
```

Each provider stores it in the simplest durable metadata it already supports:

- GitHub pull requests use the existing secondary `## Supervision` description
  block. The adapter reads only its `Goal` value for routing.
- Azure DevOps builds use a build tag such as
  `herdr-goal:g_63bfbf0e-66c1-4d47-89c8-b49ed0087bde`.

The human-readable PR block may also show a pane or native session for audit
and debugging. Those values are presentation only. They may become stale and
must never select a delivery target.

Attaching metadata is not watcher registration. It is part of creating the
resource, like linking a work item or naming a source branch. A small creation
tool may add it automatically from the caller's current goal. Workers that use
provider CLIs directly follow the same metadata convention.

## Discovery

The daemon has environment-level provider scopes, such as a GitHub repository
or an Azure DevOps project. These scopes are deployment configuration, not
per-worker watches.

Each adapter periodically lists a bounded window of recently updated
resources in its scope and returns only resources with a valid goal ID. The
window includes recently closed or completed resources so the final transition
is observed. If an old resource changes later, its provider update time makes
it recent again and it is rediscovered.

Adapters own provider syntax and pagination. The core sees only normalized
observations:

```json
{
  "source": "ado-build",
  "subject": "organization/project/178997557",
  "goalId": "g_63bfbf0e-66c1-4d47-89c8-b49ed0087bde",
  "revision": "provider-derived-hash",
  "payload": {}
}
```

The payload is bounded context for the wake hint, not completion evidence.

## Revisions and first discovery

A revision includes only fields whose changes may matter to a worker. Examples:

- PR head, state, draft state, mergeability, reviews, checks, and statuses;
- build source version, status, result, and finish time.

On first discovery, the daemon records the revision and emits one wake. This
may produce a harmless extra review when a resource was just created, but it
also catches a resource that changed while the daemon was stopped. Avoiding
that one duplicate would require a registration baseline or more recovery
state, which costs more than the saved model turn.

Every later distinct revision emits another wake. Fast consecutive revisions
may coalesce to the newest value because the worker always rereads provider
authority. The watcher is not an audit log.

## Delivery and failure

The delivery input is a durable goal ID, never a pane ID:

1. Load the active goal record.
2. Read its current worker binding.
3. Resolve and verify that exact native session in fresh Herdr state.
4. Resume its native Goal if it is settled.
5. Send a short hint naming the changed resource.

If the goal is complete, missing, ambiguous, or temporarily has no valid
worker, delivery fails closed. The daemon does not guess another worker or
create a goal. It records one bounded diagnostic for the supervisor. The
supervisor uses ordinary goal reasoning and tools to repair the situation.

A wake is at-least-once. A crash near delivery may produce the same hint again.
That is acceptable because the worker rereads authority and provider actions
must be idempotent or independently verified.

## Minimal state

The daemon keeps one atomically replaced bounded checkpoint:

```text
(source, subject) -> goal ID, latest revision, last seen time,
                     optional latest undelivered revision
```

It does not persist:

- watch IDs;
- destinations;
- worker sessions or panes;
- predicates or expected terminal states;
- task, attempt, review, or workflow state;
- provider credentials.

Old entries are removed by a simple size and age bound. If an evicted resource
is rediscovered, it produces one duplicate wake. That is safe and much simpler
than perfect retention.

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

The provisioner has only two integration duties:

- start the daemon with its configured provider scopes; and
- make the goal metadata convention available to workers and creation tools.

## Live evidence

The MLVM experiment proved the identity path:

- ADO PR `16980570` contains a complete `## Supervision` block.
- Its goal ID maps exactly to the active canonical goal and current worker.
- Linked build `178997557` has useful build state but no goal metadata.

The PR is therefore discoverable now. Standalone builds need the goal tag added
when they are queued. This is the first end-to-end case for the revised PoC.

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
