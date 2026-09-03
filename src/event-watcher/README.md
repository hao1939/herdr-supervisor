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
