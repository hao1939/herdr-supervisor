# External event watcher

`event-watchd` (the `daemon.mjs` process) observes external resources linked to
supervised goals and notifies the exact current worker when their authoritative
state changes. It removes provider waiting and polling from worker model turns.
It is not a task system, event bus, workflow engine, or decision agent.

```text
provider -> source adapter -> resource observation -> watcher core -> worker
                            failure ------------------------------> supervisor
```

The path is deliberately one way. A source adapter reports facts addressed to
a durable goal ID. The watcher validates, remembers, and delivers the changed
observation. The worker rereads the provider and decides what the change means
for its goal. Only watcher or delivery failures go to the supervisor.

## Using event-watchd

`event-watchd` is optional deployment plumbing. There is no subscription UI or
per-goal registration: configure trusted provider scopes once, then let workers
identify the resources they create with the durable goal ID they already own.

### What the supervisor does

You can tell the Pi supervisor which GitHub repositories, Azure DevOps (ADO)
repositories, or ADO pipeline definitions should wake workers. The supervisor
should:

1. help you identify the smallest trusted provider scopes;
2. explain the exact deployment variables below;
3. instruct supervised workers to put their current goal ID on new PRs and builds;
4. use watcher diagnostics to keep affected existing goals moving.

For example, ask: `Set up external watching for GitHub acme/api and ADO
pipeline acme/platform/42. Tell me exactly what I must configure.` The
supervisor should return the required scope and credential variables, explain
the worker metadata, and clearly identify the service recreation as your
operator step.

The supervisor does not have shell or deployment tools. It cannot change a
running container's environment, start the daemon, inspect its process, or
claim setup succeeded. An operator applies the configuration and restarts the
service. This is an intentional boundary, not another goal for a worker.

### Configure provider scopes

The three scope variables are comma-separated lists. Configure at least one:

| Variable | Entry shape | Observes |
|---|---|---|
| `HERDR_WATCH_GITHUB_REPOSITORIES` | `owner/repository` | GitHub PR head, state, draft state, checks, and statuses |
| `HERDR_WATCH_ADO_REPOSITORIES` | `organization/project/repository` | ADO PR head, state, merge status, reviewers, discussions, and policies |
| `HERDR_WATCH_ADO_DEFINITIONS` | `organization/project/definition-id` | ADO build source revision, state, result, and finish time |

For the container, export the desired values in the shell that runs Compose
and recreate the service so its environment changes:

```sh
export HERDR_WATCH_GITHUB_REPOSITORIES=acme/api,acme/web
export GITHUB_TOKEN='<token able to read those repositories>'
export HERDR_WATCH_ADO_REPOSITORIES=acme/platform/service
export HERDR_WATCH_ADO_DEFINITIONS=acme/platform/42
export AZURE_DEVOPS_EXT_PAT='<token able to read those ADO resources>'
docker compose up -d --force-recreate herdr
```

Pass secrets through the deployment environment or its secret store; never put
them in a goal, PR description, build tag, watcher checkpoint, or committed
Compose file. `GH_TOKEN` also works for GitHub. For ADO, a custom deployment may
omit the PAT when `AZURE_CLI` names an available Azure CLI executable whose
login can obtain an ADO access token. The stock image does not include Azure
CLI, and a login on another host or container is not shared.

The container entrypoint starts one watcher automatically whenever any scope
variable is non-empty. `HERDR_WATCH_INTERVAL_MS` changes the scan interval
(minimum 10 seconds; default 60 seconds), and `HERDR_WATCH_STATE_HOME` changes
the persistent checkpoint directory.

For local use, give the watcher the same goal store and Herdr socket environment
as the supervisor, export the provider scopes and credentials, and run it as a
long-lived process:

```sh
export HERDR_WATCH_GITHUB_REPOSITORIES=acme/api
export GITHUB_TOKEN='<token>'
npm run watch
```

### Link a resource to a goal

Workers do this as part of their native supervised Goal; they do not call the
watcher. A GitHub or ADO PR description must contain exactly one block like:

```markdown
## Supervision
- Goal ID: g_01234567-example
```

The readable goal, worker, pane, and public session fields may follow, but only
the exact `Goal ID` addresses delivery. An ADO build instead carries exactly one
tag:

```text
herdr-goal=g_01234567-example
```

The goal must still be active, and the configured provider scope must contain
the resource. Removing or duplicating the goal metadata makes the resource
ineligible rather than guessing a worker.

### Verify it

1. Check container logs for `Starting the shared external event watcher
   (event-watchd).` or keep the local `npm run watch` process alive. A quiet
   process after startup is normal.
2. Confirm the PR description or ADO build tag contains the exact active goal
   ID and that its repository or definition is in the configured scope.
3. Let an authoritative watched field change, such as a check, policy, PR head,
   or build result. On the next scan, the exact worker receives `External
   resources changed for goal ...`, rereads the provider, and continues its
   Goal.
4. Confirm an unchanged later scan sends no duplicate notification. The
   checkpoint is normally at
   `~/.local/state/herdr-supervisor/external-events.json`; it is diagnostic
   state, not a file to edit or a second source of truth.

Provider and delivery failures are retried on the next bounded scan and sent as
diagnostics to the one Pi supervisor. The supervisor should use the affected
existing goal when possible and ask for operator action only for missing
credentials, scope, or deployment authority. If no notification arrives,
check—in this order—the daemon process, provider scope and credentials, exact
metadata, active goal, and exact live worker identity.

To disable container watching, clear all three scope variables and recreate the
service. To disable a local watcher, stop its process. Keeping or deleting its
checkpoint does not alter goals or provider resources; keeping it avoids a
fresh notification for every still-linked resource after restart.

## Boundaries

### Source adapter

A source adapter owns one provider/resource shape. It:

- validates its configured provider scope and obtains provider credentials;
- reads trusted provider metadata that links a resource to one durable goal;
- observes bounded authoritative state;
- computes a stable revision from the fields that matter;
- returns bounded current facts; and
- reports when a previously known resource is authoritatively absent.

An adapter never imports Herdr APIs, reads worker state, resolves panes or
native sessions, sends prompts, or decides what action should happen. It
addresses only a `goalId`. Pane, process, worker-name, and session identity must
not appear in adapter output. It also never triggers delivery directly: its
complete boundary is the value returned from `scan`.

### Watcher core

`ExternalEventWatcher` validates adapter output, filters inactive goals,
deduplicates unchanged revisions, persists bounded pending delivery, batches
changes by goal, and retries safely. It knows no provider-specific workflow.

### Worker notification

`herdrGoalDelivery` resolves the durable goal ID against canonical goal state,
verifies one exact current native session, resumes a settled Codex Goal when
needed, and sends the bounded observation. The notification is a wake hint,
not provider authority or completion proof.

### Diagnostics

Source and delivery failures are bounded observations for the supervisor. The
supervisor uses the ordinary goal loop to judge their impact. Diagnostics do
not create goals or recovery workflows.

## Source adapter contract

The daemon gives each configured source a stable source name and calls:

```js
scan(knownResources) => ({
  observations: [{ subject, goalId, revision, payload }],
  absent: [subject],
})
```

`knownResources` contains the source's remembered `{ subject, goalId,
revision, pending }` values so the adapter can refresh old resources as well as
discover recent ones.

- `subject` is the stable resource identity within this source.
- `goalId` is the exact durable goal address read from trusted metadata.
- `revision` changes only when authoritative state useful to the worker changes.
- `payload` contains bounded observed facts. It may include a provider's own
  recommendation as attributed evidence, but never an instruction invented by
  the adapter.
- `absent` contains known subjects that were deleted, left configured scope, or
  no longer carry valid goal metadata.

Scans must be safe to repeat. A partial or truncated provider response must
fail instead of producing a false revision. Credentials and secrets never
enter observations or watcher state. Untrusted public metadata must not be
allowed to select a worker; scope and metadata trust are adapter responsibilities.

## Adding a built-in source

There is intentionally no dynamic plugin loader or registration lifecycle.
Extending the watcher is an ordinary reviewed code change:

1. Add `<provider>-<resource>.mjs` with a factory named
   `<provider><Resource>Source`.
2. Implement the `scan(knownResources)` contract and keep provider details in
   that module.
3. Wire its bounded configuration and source name into `daemon.mjs`.
4. Add focused tests for linking, revisions, absence, truncation, credentials,
   bounds, and remembered-resource refresh.
5. Document operator configuration in the root README and container setup.

Keep one shared daemon unless a source has a proven separate security or
lifecycle boundary. Do not add semantic routing, suggestions, per-resource
subscriptions, renewal, or provider workflow to the watcher. If interpretation
requires goal context, notify the worker and let its model decide.

## Files

- `core.mjs`: provider-independent observation, revision, and delivery state.
- `daemon.mjs`: static built-in source composition and process lifecycle.
- `herdr.mjs`: goal-addressed worker notification and supervisor diagnostics.
- `supervision-metadata.mjs`: strict durable goal metadata parsing.
- `refresh-window.mjs`: disposable bounded refresh rotation.
- `github-pr.mjs`, `ado-pr.mjs`, `ado-build.mjs`: built-in source adapters.

The repository's [current design](../../docs/design.md) remains authoritative
for the wider supervisor architecture.
