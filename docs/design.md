# Herdr Supervisor design

**Status:** Current design

## Purpose

Herdr Supervisor lets one human-facing agent watch several Herdr workers and
help each one finish an explicit goal. It stays lightweight by using Herdr as
the runtime and Codex's native Goal as the worker's continuation loop. It does
not build another task system.

The core rule is:

> Code collects current facts and executes a validated choice. The model makes
> the semantic choice.

## Scope discipline

The Supervisor implements the small foundation that every goal needs and lets
the model handle situational judgment. The practical heuristic is **solidify
the common 20%; teach the model the remaining 80%**. This is not a feature
quota. It is a test for whether a behavior belongs in code.

The minimal core lets an agent:

- **observe** current worker and external facts;
- **decide** what those facts mean for the goal;
- **act** through small validated effects;
- **remember** the portable goal and latest local checkpoint; and
- **wake** on meaningful events or a bounded health check.

For every new request or failure, ask in order:

1. Can the agent handle it with those existing primitives?
2. Will the agent reliably be triggered to handle it?
3. Does the agent receive enough durable knowledge and current context to
   choose well?

If all three answers are yes, add no runtime feature. Improve the goal context,
prompt, or operational documentation when useful, then let the agent do the
work. If an answer is no, fix the smallest missing foundation: capability,
trigger, or knowledge. Promote a behavior into code only when it recurs, is
unsafe or materially unreliable as judgment, wastes meaningful resources, or
has another clear general benefit.

Put behavior in code only when it is:

- common to many goals rather than one observed incident;
- deterministic identity, persistence, scheduling, or effect execution;
- unsafe or unreliable to reproduce through ordinary model judgment; and
- small enough to state as an invariant and prove with focused tests.

Keep behavior in prompts, operational guidance, or the goal's own context when
the model can inspect current facts and choose a safe action. One missing pane,
one provider quirk, or imperfect reconstruction after restart does not justify
a new recovery subsystem. Prefer a visible failure and a fresh model decision;
some repeated work or model cost is acceptable when the final result remains
correct.

The foundation is therefore limited to portable goal contracts, exact worker
identity, atomic current checkpoints, event wakeups with bounded health checks,
validated effects, and clear current evidence. Provider integrations are
optional observation adapters, not new workflow engines. A larger mechanism
needs repeated live evidence that these primitives and ordinary agent reasoning
cannot handle the problem cleanly.

## Mental model

There are three roles:

- The human states and refines outcomes and makes decisions that require human
  authority.
- A worker pursues one durable goal in one exact native agent session.
- The supervisor observes evidence, judges progress, and helps the same worker
  continue.

Herdr owns panes, processes, native sessions, status, and events. The worker
owns implementation and detailed evidence. The supervisor owns the goal
contract, its latest review checkpoint, and the judgment about what to do next.
One native agent session can belong to only one unfinished goal, regardless of
which pane currently routes to it.

A supervised goal is not a second task. It is one portable outcome contract
bound to one exact worker. One worker may use several repositories or
worktrees without creating more supervisor goals.

## Normal flow

1. The human describes an outcome.
2. The model compares it with active goals.
3. The model updates a fitting goal or defines one new goal with objective,
   stable context, acceptance criteria, and constraints.
4. Code validates that contract, creates or selects one worker space, starts
   Codex, records its exact native session, and gives it the native `/goal`.
5. The worker keeps working without supervisor model turns.
6. A Herdr event or bounded deadline asks the supervisor to review that goal.
7. Code supplies the goal, fresh Herdr state, and bounded new worker evidence.
8. The model chooses one review decision. Code validates and applies it.
9. Supervision ends only when evidence proves the complete outcome or the human
   explicitly stops it.

The supervisor is normally asleep. Events improve response time; a single
nearest-deadline timer ensures missed events or long waits do not lose a goal.
Its default one-hour interval is a safety net, not a polling cadence; deployments
can tune it when their event reliability or recovery needs differ.

## Decisions

An automatic focused review has exactly four semantic decisions:

- `leave`: current work is healthy, or a settled worker has one concrete wait
  condition. Recheck on its next event or bounded deadline.
- `steer`: the same worker can take one useful next action now.
- `ask_human`: one missing decision or fact genuinely requires the human.
- `accept`: current evidence proves the entire objective and every acceptance
  criterion at the declared scope and time horizon.

`stop` is a separate operator action. It ends supervision when the human asks;
it is not a model review decision.

Resuming a native Goal is also not a model decision. If `steer` is chosen for
an exact settled Codex worker, code resumes its native Goal before sending the
instruction into the active turn. If the process exited while its pane and
native session remain recoverable, code resumes that same session first. An
empty pane restored with a new terminal refreshes that transient checkpoint. A
missing pane may be replaced as a routing location only when the recorded
session supports exact resume and code verifies that saved identity. A changed
or unsupported session fails closed.

The model never chooses transport, invents worker identity, or directly edits
checkpoint files. Code never infers semantic intent from keywords or a growing
set of workflow-specific branches.

## Goal data

Each goal keeps three files in one stable directory:

```text
goals/g_<id>/
├── goal.json
├── current.json
└── journal.jsonl
```

`goal.json` is the portable contract. It contains only:

- objective;
- stable context needed to pursue it;
- acceptance criteria;
- lasting constraints.

Copying `goal.json` is enough to start fresh on another instance. It contains
no pane, session, progress, wait, cursor, or history.

`current.json` is the latest local checkpoint. It contains the exact worker
binding, concise progress, retained evidence, observation cursor, last
decision, optional wait, optional unresolved external change, and optional
terminal result. It does not copy live worker status; that always comes from
Herdr.

Polling schedules remain disposable memory. If a watched PR or build changes,
only that unresolved fact is saved in `current.json`. It survives restart and
cannot be cleared by merely sending a prompt or receiving a worker reply. After
the reread delivery attempt, the supervisor saves the current transcript cursor
or terminal fingerprint. A later native final response, or a later settled
Herdr transition with a changed fixed terminal fingerprint, establishes only a
fresh result candidate. The model decides whether that result actually proves
the authoritative reread and acknowledges the exact pending revision in its
ordinary `leave`, `steer`, `ask_human`, or `accept` decision. Code then clears
the matching revision atomically with that decision. This keeps semantic
judgment in the model while code rejects stale revisions and old output. If the
post-delivery observation itself fails, the supervisor saves a fail-closed
boundary that cannot produce a candidate; a later bounded review may steer the
same worker again and replace it with a real boundary.

Tool arguments keep the same boundary explicit. An optional value that does not
apply is `null`; the model never invents a placeholder identity, revision,
watch, wait, or deadline merely to fill a field. Code validates real values and
executes the decision, while `null` carries no semantic claim.

A decision that can change a watch briefly holds its exact external subject:
it drains any in-flight read and prevents another one from starting until the
state change commits. An unrelated slow provider does not delay it. The final
state write also compares the exact external revision, so polling cannot race
with steering, clearing, or acceptance and lose a newer change.

The v1 reader still accepts the retired `recover` decision in an existing
checkpoint. New reviews never produce it; recovery is now transport inside
`steer`. This keeps restart compatibility without restoring a fifth model
decision.

`journal.jsonl` is append-only audit history. It is useful for inspection but
is never replayed to rebuild the current goal. A missing journal cannot stop
recovery; an invalid goal or checkpoint fails closed.

In-memory runtime data holds only disposable scheduling details such as the
next review time, coalesced signal, and one-turn observation fence. Durable
bindings and transient runtime state stay separate in code and storage.

## Review context

Each focused review receives only what is needed to decide one goal:

- the complete portable contract;
- latest progress, evidence, wait, and last decision;
- exact current Herdr identity and status;
- why the review was triggered and the current UTC time;
- bounded new assistant messages since the saved cursor;
- relevant recorded peer progress when coordination requires it.

The supervisor may use its human conversation history, but correctness does
not depend on replaying that history. `goal.json`, `current.json`, fresh Herdr
state, and bounded new evidence are sufficient after restart.

Only the focused worker's evidence can prove its goal complete. Peer status can
help coordination but cannot satisfy another worker's acceptance criteria.

## Progress and waits

A worker remains responsible for its native Goal. The supervisor does not
prompt it merely because one turn ended. A final response, pull request, test
run, report, cleared backlog, or raised threshold is evidence, not automatic
completion.

Before leaving settled work, the model checks whether safe independent work,
alternative proof, mitigation, or preparation can still proceed. A wait is a
promise to reconsider, not permission to forget the goal:

- a direct peer wait resolves the selected pane to the peer's durable goal ID;
  when a peer review proves that condition materially changed, the model
  selects the exact affected waits for early review, and a terminal peer wakes
  all remaining dependents after either worker is relocated;
- a wait on one exact GitHub PR or ADO build may register a disposable external
  watch chosen by the model;
- every wait has a bounded recheck;
- the model chooses an evidence-appropriate safety time; a selected peer effect
  or external watch still wakes the goal earlier, avoiding repeated short
  reviews of unchanged state;
- when a wait expires, current evidence must confirm it before waiting again.

A human question follows the same rule. It is concrete, asks for the minimum
input that changes the work, and receives a bounded reconsideration so
unrelated useful work can continue.

External watches run as small deterministic reads inside the existing Pi
extension process. They share the nearest-deadline timer and the per-goal
review signal map. An unchanged revision schedules another read without a
model turn. A changed revision queues the ordinary focused review, where the
model asks the same worker to reread provider authority before judging it.
When that external condition is the worker's only remaining blocker, the
worker reports it once and lets its native Goal block. It does not sleep or
poll; the watch or bounded review resumes the same session.
Watch registration is process-local in the first version: after restart, the
ordinary bounded goal review can register it again. This keeps provider polling
an optimization rather than another durable task or event system.

## Concurrency

Workers run concurrently. The one supervisor session makes one semantic
decision at a time.

- Each worker has at most one pending in-memory review signal.
- Repeated signals coalesce because the review rereads authoritative state.
- Pending workers retain first-observed order.
- One review fence owns preparation, observation, decision, and settlement for
  the focused pane.
- The fence allows one successful observation and one decision in a turn.
- Events arriving during a review remain pending for a later turn.
- A low-frequency compact global review sees every unfinished goal, including
  saved contracts that have no local worker. It reports cross-goal or unstarted
  work and may schedule ordinary focused reviews only for goals that have a
  worker; it never acts on workers itself.
- Its small local checkpoint supplies the last bounded active finding to the
  next review. The model returns the complete set still supported by current
  evidence; code suppresses an identical set and clears resolved findings so a
  later recurrence is visible again.

This is event-loop coordination, not a durable queue, workflow engine, or task
graph.

## Failure behavior

- Subscription loss reconnects with bounded backoff, then rereads Herdr state.
- A missed event is covered by the nearest review deadline.
- An interrupted supervisor reloads every unfinished goal from its contract and
  checkpoint and compares it with fresh Herdr state.
- A saved contract with no checkpoint remains visible as unstarted work in the
  global safety review. It cannot be silently treated as healthy or routed to a
  worker review that does not exist.
- A stopped supported Codex process can resume only its exact native session.
- A changed or missing identity fails closed and receives no prompt.
- Once Herdr may have accepted a prompt or resume, the turn closes before
  checkpointing so bookkeeping failure cannot duplicate the worker action.
- A model turn without one valid decision applies nothing and gets one bounded
  retry; it does not create a retry subsystem.
- Audit failure is visible but cannot change authoritative state.

The design favors a safe retry or some repeated model cost over elaborate
perfect reconstruction. Simplicity and robust eventual progress come first.

## Human experience

The supervisor speaks in plain language. It explains:

- what is true now;
- why it matters;
- what is happening next;
- what the human needs to do, if anything.

It preserves exact IDs and evidence only where they help verification. Runtime
events and internal metadata do not compete with the useful outcome.

## Implementation boundary

- `extension.ts` wires Pi tools, Herdr events, timers, and validated effects.
- `prompts.ts` contains readable model and worker policy.
- `types.ts` distinguishes durable goal bindings from transient runtime state.
- `identity.ts` owns exact native-session equality shared across boundaries.
- `goal-store.ts` validates and atomically persists contracts, checkpoints, and
  audit entries.
- `goal-registry.ts` maps stored goal records to active bindings.
- `supervision.ts` contains small pure identity, scheduling, display, and
  recovery helpers.
- `review-turn.ts` owns the single focused-review phase and tool fence.
- `observation.ts` reads bounded worker evidence.
- `global-review.ts` owns the compact low-frequency safety review.

New abstractions must remove real duplication or clarify an authority boundary.
Do not add a generic reducer, workflow engine, retry service, task graph, or
keyword router unless measured evidence proves the simpler event-driven design
cannot meet the goal.

An uncertain routing recovery never causes a same-turn retry. The existing
bounded review rereads runtime truth and safely adopts or retries the recovery;
no separate recovery workflow or durable retry state is needed.
