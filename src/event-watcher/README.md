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

`event-watchd` is an agent-operable external observation tool. There is no
subscription UI or per-goal registration: start it for trusted provider scopes,
then let workers identify the resources they create with the durable goal ID
they already own.

### What an agent does

You can ask the Pi supervisor or another agent with ordinary shell access to
watch GitHub repositories, Azure DevOps (ADO) repositories, or ADO pipeline
definitions. The agent should:

1. help you identify the smallest trusted provider scopes;
2. inspect existing watcher processes and avoid starting a duplicate;
3. start the watcher with the exact scope variables below;
4. verify the process, provider access, metadata, and worker delivery;
5. diagnose or stop it with ordinary process tools; and
6. when needed, extend its source code through the documented adapter contract.

Workers remain unaware of this machinery. They only put their current goal ID
on new PRs and builds, receive bounded notifications, and reread provider
authority to decide what to do.

For example, ask: `Watch GitHub acme/api and ADO pipeline
acme/platform/42 for my supervised goals. Set it up and verify it.` An agent
with sufficient access should inspect, act, and return evidence. It should ask
you only for a missing credential or authority that it cannot obtain safely.

Having no shell or process capability is a limitation of that particular agent
session, not part of the watcher design. In that case the agent should give the
smallest exact command for a capable agent or human to run; it must not claim
setup succeeded.

### Configure and start it

The three scope variables are comma-separated lists. Configure at least one.
Each built-in list accepts at most ten entries; narrow the trusted scope or
make an ordinary reviewed code change instead of silently splitting ownership
across watcher processes.

| Variable | Entry shape | Observes |
|---|---|---|
| `HERDR_WATCH_GITHUB_REPOSITORIES` | `owner/repository` | GitHub PR head, state, draft state, checks, and statuses |
| `HERDR_WATCH_ADO_REPOSITORIES` | `organization/project/repository` | ADO PR head, state, merge status, reviewers, discussions, and policies |
| `HERDR_WATCH_ADO_DEFINITIONS` | `organization/project/definition-id` | ADO build source revision, state, result, and finish time |

From a source checkout, an agent can pass the scope directly when it starts the
process. Credentials already present in that runtime are inherited:

```sh
HERDR_WATCH_GITHUB_REPOSITORIES=acme/api,acme/web npm run watch
```

The command stays in the foreground so its first failure is visible. Once the
configuration is proven, the agent may run the same command through the
runtime's ordinary long-lived process facility. It should preserve the goal
store, Herdr socket, credentials, and `HERDR_WATCH_STATE_HOME`, and ensure only
one watcher owns that checkpoint.

This is ordinary process management, not a watcher-specific control protocol.
An agent may inspect the process, stop it cleanly, and restart it with different
scopes. It does not need a supervisor-only tool or configuration registry. The
daemon claims one process-lifetime lock beside its checkpoint and fails fast if
another live process already owns it; a stale lock is recovered after its
process is gone.

### Credentials

Pass secrets through the runtime environment or its secret store; never put
them in a goal, PR description, build tag, watcher checkpoint, committed file,
or conversational instruction. `GITHUB_TOKEN` or `GH_TOKEN` must be able to
read the configured GitHub repositories. ADO uses `AZURE_DEVOPS_EXT_PAT`, or an
Azure login and CLI available in the same runtime. It runs `AZURE_CLI` when the
override is set and otherwise finds `az` on `PATH`. The stock image does not
include Azure CLI, and a login on another host or container is not shared.

`HERDR_WATCH_INTERVAL_MS` changes the scan interval (minimum 10 seconds;
default 60 seconds). `HERDR_WATCH_STATE_HOME` changes the persistent checkpoint
directory.

### Optional container auto-start

For unattended restart recovery, the container entrypoint can start one watcher
automatically. Export the desired values in the shell that runs Compose and
recreate the service:

```sh
export HERDR_WATCH_GITHUB_REPOSITORIES=acme/api,acme/web
export GITHUB_TOKEN='<token supplied by the deployment secret store>'
docker compose up -d --force-recreate herdr
```

This is a deployment convenience, not the only supported setup path. Before
starting another watcher manually, inspect whether the entrypoint already
started one.

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

Source failures are retried on the next bounded scan. Failed delivery remains
pending and retries after a later successful current observation of that
resource; bounded refresh means this may be later than the next scan. Both are
sent as diagnostics to the one Pi supervisor. The receiving agent should
inspect the affected existing goals and watcher process with its available
tools, repair what current authority permits, and ask only for genuinely
missing credentials or authority. If no notification arrives, check—in this
order—the daemon process, provider scope and credentials, exact metadata,
active goal, and exact live worker identity.

To disable a manually started watcher, stop its process. For entrypoint-managed
watching, clear all three scope variables and recreate the service. Keeping or
deleting its checkpoint does not alter goals or provider resources; keeping it
avoids a fresh notification for every still-linked resource after restart.

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
5. Document agent operation in this guide and any optional deployment setup.

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
- `../filesystem-lock.mjs`: small, mature filesystem-lock wrapper used to
  prevent two processes from owning the same checkpoint.

The repository's [current design](../../docs/design.md) remains authoritative
for the wider supervisor architecture.
