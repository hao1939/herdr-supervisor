# External event watcher

`event-watchd` (the `daemon.mjs` process) observes external resources linked to
supervised goals and notifies the exact current worker when their authoritative
state changes. It removes provider waiting and polling from worker model turns.
It is not a task system, event bus, workflow engine, or decision agent.

Its extension rule is:

> **Events carry facts. Knowledge guides action.**

Adapters extend what can be observed. Plain-language response guidance extends
what the responsible agent knows to do with those observations. The watcher
never turns that guidance into provider-specific workflow code.

```text
provider -> source adapter -> resource observation -> watcher core -> worker
                            failure ------------------------------> supervisor
```

The path is deliberately one way. A source adapter reports facts addressed to
a durable goal ID. The watcher validates, remembers, and delivers the changed
observation. The worker rereads the provider and decides what the change means
for its goal. Only watcher or delivery failures go to the supervisor.

This implementation currently has one fixed notification rule: a linked
provider resource wakes its exact goal worker. Do not add a generic `target`
field or runtime router to support another case. If live evidence justifies a
system-level observer later, wire that observer statically to the supervisor's
ordinary empowered session and keep its facts and response knowledge separate.

## Using event-watchd

`event-watchd` is an agent-operable external observation tool. There is no
subscription UI or per-goal registration: start it for trusted provider scopes,
then let workers identify the resources they create with the durable goal ID
they already own.

The supervisor is accountable for assembling this shared path for its
portfolio: choose the trusted scope, ensure one daemon is running, ensure the
fixed recipient has suitable response knowledge, and verify an end-to-end
change. This is setup and health ownership, not participation in every event.
It happens once per environment or integration change, not once per goal or
resource. Any authorized agent may carry out the ordinary process or code
operations on the supervisor's behalf.

### What an agent does

You can ask the Pi supervisor or another agent with ordinary shell access to
watch GitHub repositories, Azure DevOps (ADO) repositories, or ADO pipeline
definitions. The agent should:

1. help you identify the smallest trusted provider scopes;
2. inspect existing watcher processes and avoid starting a duplicate;
3. start the watcher with the exact scope variables below;
4. verify the process, provider access, metadata, and worker delivery;
5. confirm the receiving agent has the small response knowledge needed for the
   event;
6. diagnose or stop it with ordinary process tools; and
7. when needed, extend its source code through the documented adapter contract.

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

ADO PR discovery intentionally inspects only the first 100 active pulls in each
configured repository per scan. This keeps polling cost bounded. Pull requests
already linked to supervised goals are refreshed directly by exact identity,
even when they are outside that discovery window. A full 100-item discovery
page also emits a non-fatal warning to the supervisor so it can narrow the
scope, repair the adapter, or coordinate existing work without stopping useful
observations.

From a source checkout, an agent can pass the scope directly when it starts the
process. Credentials already present in that runtime are inherited:

```sh
node src/event-watcher/daemon.mjs --help
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

On successful startup, the daemon explains its effective configuration without
printing credentials:

```text
event-watchd started

Watching trusted scopes
  - github-pr: acme/api

Scan interval: 60000 ms
Checkpoint: /home/agent/.local/state/herdr-supervisor/external-events.json
Delivery: linked resource -> durable goal ID -> exact current worker
Failures: bounded diagnostic -> one Pi supervisor
Proof: startup only; verify provider access, metadata, and one changed-resource delivery
```

This is the effective process configuration, not proof that provider access or
delivery works. An agent should compare it with the requested scopes and then
complete the verification below before claiming setup is complete.

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
   or build result. On the next scan, the exact worker receives an
   `[event-watchd/v1]` `linked-resource-change` message naming its Goal,
   rereads the provider, and continues its Goal.
4. Confirm an unchanged later scan sends no duplicate notification. The
   checkpoint is normally at
   `~/.local/state/herdr-supervisor/external-events.json`; it is diagnostic
   state, not a file to edit or a second source of truth.

The receiving worker gets a self-explaining message with four parts: goal,
resource identity and observation revision, bounded facts, and the complete
response guide. For example:

```text
[event-watchd/v1]
Event: linked-resource-change
Recipient role: goal-worker

Event facts
  Goal ID: g_01234567-example
  Resource count: 1
  Resource 1
    Source: github-pr
    Subject: acme/api#42
    Observed at: 2026-09-03T00:00:00.000Z
    Revision: <stable provider-state hash>
    Observed facts:
      { ... }

Agent response knowledge
  # Linked provider resource changed
  ...
```

The worker does not need to locate watcher documentation before responding.
The injected guide explains why it received the event, how to reread authority,
and what progress report is expected. The full editable source is
`knowledge/linked-resource-change.md` beside the watcher code.

Source failures use one watcher-core policy for every adapter: become eligible
for retry after one minute, then five minutes, fifteen minutes, and one hour
while the source remains broken. The actual attempt occurs on the first
configured scan after that threshold. Each due attempt that still fails sends a
fresh diagnostic to the Pi supervisor; success resets that source to normal
scanning immediately. Healthy adapters keep scanning while one source backs
off. This state is process-local, so restart makes one immediate fresh attempt
instead of adding a durable retry system.

Failed delivery remains pending and retries after a later successful current
observation of that resource; bounded refresh means this may be later than the
next scan. Both failure kinds are sent as diagnostics to the one Pi supervisor.
The receiving agent should inspect the affected existing goals and watcher
process with its available tools, repair what current authority permits, and
ask only for genuinely missing credentials or authority. This is an ordinary
infrastructure-diagnostic turn with ordinary tools, not a fenced focused or
global goal review; the event facts do not grant new authority. If no
notification arrives, check—in this order—the daemon process, provider scope
and credentials, exact metadata, active goal, and exact live worker identity.

To disable a manually started watcher, stop its process. For entrypoint-managed
watching, clear all three scope variables and recreate the service. Keeping or
deleting its checkpoint does not alter goals or provider resources; keeping it
avoids a fresh notification for every still-linked resource after restart.

## Boundaries

### Two extension surfaces

Before changing code, identify which surface is missing:

- **Fact extension:** add or change an adapter because the agent cannot observe
  a useful authoritative change or cannot be woken by it.
- **Knowledge extension:** update the responsible agent's stable guidance
  because it already receives sufficient facts and has sufficient actions, but
  needs a clearer way to assess or handle the case.

An event contains source identity, subject, revision, observed links, and
bounded provider facts—never an invented action. Plain-language,
version-controlled response knowledge names the responsible role, why the
event matters, what authority to inspect, suitable existing actions, and the
expected output or next condition. Put goal-specific policy in the goal,
compact common rules in the recipient's prompt, and detailed operating help in
a colocated guide. If an automatic review cannot read that guide, supply its
small required rules in the turn context.

This split lets incident experience improve agent behavior without changing
watcher state or delivery. Add deterministic code only when the missing fact,
wake, validation, or effect is genuinely reusable and cannot be handled
reliably with existing primitives.

All agent notifications use the versioned `[event-watchd/v1]` envelope shown
above. `Event`, `Recipient role`, `Event facts`, and `Agent response knowledge`
are stable fields. The watcher owns accurate event facts; the recipient owns
how it responds. Each predefined event kind owns its bounded fact names and
colocated response guide. A new source adapter reuses an existing event kind
unless the recipient genuinely needs different facts or knowledge. An
incompatible envelope change requires a new version.

Improve the path in that order. First compare a delivered event with current
provider authority and prove its identity, Goal link, time, revision, and facts
are accurate and sufficient. Only then evaluate the agent response. If the
event is good but the response is weak, update goal context, response
knowledge, or general agent guidance. Do not hide bad event data with prompting
or add watcher code for reasoning the agent can already perform. Return to the
event layer only when the delivered event fails accuracy, clarity, relevance,
or sufficiency; name the concrete event defect. If the event passes, improve
the agent side instead.

The current worker path proves the complete contract: an adapter emits facts,
the watcher delivers them to one exact goal worker, and the notifier injects
the colocated response guide. A supervisor-level observation can use the same
envelope with the predefined `supervisor` recipient role and an ordinary Herdr
prompt. It does not need to enter the periodic fenced global-review transaction
or introduce a custom event, socket, spool, queue, or router.

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
changes by goal, and applies the shared process-local source backoff. It knows
no provider-specific workflow.

### Worker notification

`herdrGoalDelivery` resolves the durable goal ID against canonical goal state,
verifies one exact current native session, resumes a settled Codex Goal when
needed, and sends the bounded observation. The notification is a wake hint,
not provider authority or completion proof.

### Diagnostics

Source warnings, source failures, and delivery failures are bounded
observations for the supervisor. Warnings do not discard valid scan results.
The supervisor uses the ordinary goal loop to judge their impact. Diagnostics
do not create goals or recovery workflows.

## Source adapter contract

The daemon gives each configured source a stable source name and calls:

```js
scan(knownResources, { signal }) => ({
  observations: [{ subject, goalId, revision, payload }],
  absent: [subject],
  warnings: [{ code, message }], // optional, non-fatal supervisor diagnostic
})
```

`knownResources` contains the source's remembered `{ subject, goalId,
revision, pending }` values so the adapter can refresh old resources as well as
discover recent ones. `signal` aborts an in-flight scan during daemon shutdown;
adapters pass it through every provider request rather than delaying process
exit until request timeouts expire.

- `subject` is the stable resource identity within this source.
- `goalId` is the exact durable goal address read from trusted metadata.
- `revision` changes only when authoritative state useful to the worker changes.
- `payload` contains bounded observed facts. It may include a provider's own
  recommendation as attributed evidence, but never an instruction invented by
  the adapter.
- `absent` contains known subjects that were deleted, left configured scope, or
  no longer carry valid goal metadata.
- `warnings` contains bounded conditions that need supervisor attention but do
  not invalidate the returned observations. `code` is a stable identity used
  to coalesce repeats until the condition clears; `message` states the observed
  fact and its impact without prescribing a workflow.

Scans must be safe to repeat and abort promptly when `signal` is aborted. A
partial or truncated authoritative resource response must fail instead of
producing a false revision. A deliberately bounded discovery window may return
valid results with a warning. Credentials and secrets never enter observations
or watcher state. Untrusted public metadata must not be allowed to select a
worker; scope and metadata trust are adapter responsibilities.

## Adding a built-in source

There is intentionally no dynamic plugin loader or registration lifecycle.
Extending the watcher is an ordinary reviewed code change:

1. Add `<provider>-<resource>.mjs` with a factory named
   `<provider><Resource>Source`.
2. Implement the `scan(knownResources, { signal })` contract, pass the signal to
   provider I/O, and keep provider details in
   that module.
3. Wire its bounded configuration and source name into `daemon.mjs`.
4. Add focused tests for linking, revisions, absence, truncation, credentials,
   bounds, and remembered-resource refresh.
5. Document the observed facts and the response knowledge needed by the fixed
   recipient, including how that knowledge reaches an automatic turn.
6. Document agent operation in this guide and any optional deployment setup.

Keep one shared daemon unless a source has a proven separate security or
lifecycle boundary. Do not add semantic routing, suggestions, per-resource
subscriptions, renewal, or provider workflow to the watcher. If interpretation
requires goal context, notify the worker and let its model decide.

## Files

- `core.mjs`: provider-independent observation, revision, and delivery state.
- `daemon.mjs`: static built-in source composition and process lifecycle.
- `herdr.mjs`: goal-addressed worker notification and supervisor diagnostics.
- `messages.mjs`: readable startup receipts and fact-plus-knowledge notices.
- `knowledge/`: plain-language response knowledge injected into event turns.
- `supervision-metadata.mjs`: strict durable goal metadata parsing.
- `refresh-window.mjs`: disposable bounded refresh rotation.
- `github-pr.mjs`, `ado-pr.mjs`, `ado-build.mjs`: built-in source adapters.
- `process-lock.mjs`: small, mature lease used only to prevent two watcher
  processes from owning the same checkpoint.

The repository's [current design](../../docs/design.md) remains authoritative
for the wider supervisor architecture.
