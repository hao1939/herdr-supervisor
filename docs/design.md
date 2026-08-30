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

Resuming an exited process is also not a model decision. If `steer` is chosen
and the exact registered Codex process has exited while its pane and native
session remain recoverable, code resumes that same session and paused native
Goal before sending the instruction. A missing pane or changed session fails
closed.

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
cannot be cleared by merely sending a prompt. After the reread delivery attempt,
the supervisor saves the current transcript cursor or terminal fingerprint.
This conservative boundary may ignore output produced during delivery, but it
cannot mistake earlier output for the reread. The change clears only after a
later native final response advances that cursor. A worker without a native
transcript instead requires a later settled Herdr transition and a changed
terminal fingerprint. That fingerprint covers a fixed terminal suffix, so
changing the number of displayed lines does not manufacture progress. If the
post-delivery observation itself fails, the supervisor saves a fail-closed
boundary that cannot clear automatically; a later bounded review may steer the
same worker again and replace it with a real boundary.

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

- a direct peer wait records that exact peer so its next event wakes the goal;
- a wait on one exact GitHub PR or ADO build may register a disposable external
  watch chosen by the model;
- every wait has a bounded recheck;
- an exact later time is used only when evidence provides one;
- when a wait expires, current evidence must confirm it before waiting again.

A human question follows the same rule. It is concrete, asks for the minimum
input that changes the work, and receives a bounded reconsideration so
unrelated useful work can continue.

External watches run as small deterministic reads inside the existing Pi
extension process. They share the nearest-deadline timer and the per-goal
review signal map. An unchanged revision schedules another read without a
model turn. A changed revision queues the ordinary focused review, where the
model asks the same worker to reread provider authority before judging it.
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
- A low-frequency compact global review can notice cross-goal problems, but it
  reports or schedules ordinary focused reviews; it never acts on workers.

This is event-loop coordination, not a durable queue, workflow engine, or task
graph.

## Failure behavior

- Subscription loss reconnects with bounded backoff, then rereads Herdr state.
- A missed event is covered by the nearest review deadline.
- An interrupted supervisor reloads every unfinished goal from its contract and
  checkpoint and compares it with fresh Herdr state.
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
