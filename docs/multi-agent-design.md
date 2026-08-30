# Proposal — more than one worker over the life of a goal

**Status:** Design knowledge. Deferred; not an implementation plan.
**Date:** 2026-08-29
**Reviewed against:** commit `880e7f7`

## 1. Summary

A durable goal may outlive one worker. One worker may get stuck, or an
independent worker may be useful for checking the result. The Supervisor should
support those cases without becoming another worker runtime or task system.

If repeated evidence later justifies a code feature, the smallest useful scope
would contain only:

1. **Relay:** stop using one worker and let another worker continue the same
   goal.
2. **Independent verification:** pause the implementer, then let a separate
   reviewer check an exact, stable revision.

There is no race mode, cooperative splitting, concurrent writing, winner
selection, dependency graph, or general-purpose attempt scheduler.

The boundary remains:

> Herdr owns workers and runtime truth. The Supervisor owns the durable goal,
> evidence, and judgment.

## 2. Problems this could address

Today one goal is permanently bound to one worker. That is unnecessarily
restrictive:

- a worker can reach a model-specific dead end while the goal remains valid;
- a long-lived goal may need a fresh worker after context becomes too large;
- completion evidence is usually supplied by the same worker that did the
  work;
- an independent review can catch incomplete or misleading evidence.

Herdr already runs independent workers concurrently and reports their runtime
state. This proposal does not recreate that capability. It only lets the
Supervisor preserve one goal while changing who pursues it or briefly asking a
second worker to verify it.

## 3. Keep three concerns separate

Three useful changes were previously grouped together, but they do not depend
on each other:

### 3.1 Additional CLI agents

Worker startup, message-level observation, and exact recovery are currently
Codex-specific. Supporting Claude Code or another CLI requires an observation
and recovery adapter for that CLI.

This work is useful on its own, but it is not required for relay. A Codex worker
can relay to another Codex worker. The README must describe the support that
actually exists until more adapters are implemented.

### 3.2 More than one attempt over time

Relay requires the Supervisor to retain compact history about a previous worker
and bind a new worker to the same goal. This is the small, foundational change.

### 3.3 Concurrent coordination

Running multiple writers, adjudicating between results, merging work, and
cleaning up losers is a separate coordination system. It is not needed for
relay or independent verification and is outside this proposal.

## 4. Terms

- **Goal:** the durable outcome and acceptance criteria in `goal.json`.
- **Worker:** a live process or native agent session owned by Herdr.
- **Attempt:** the period in which one implementation worker pursues a goal.
- **Relay:** ending the current attempt and starting a new attempt for the same
  goal.
- **Verification:** an independent, read-only check of a stable artifact from
  the current attempt.

An attempt is local execution history. It is not a sub-goal, task, or portable
part of the contract.

## 5. Ownership

### Herdr owns

- starting, identifying, observing, resuming, and stopping workers;
- native agent-session identity;
- whether a worker process is running;
- runtime placement and isolation capabilities.

### The Supervisor owns

- the goal contract and acceptance criteria;
- which attempt currently represents the goal;
- compact attempt history and evidence;
- whether to leave, steer, relay, ask the human, verify, accept, or stop;
- the verification verdict.

The Supervisor may request a new worker or isolated workspace through Herdr. It
must not implement its own process manager, runtime registry, or worktree
allocator. If guaranteed isolation is required but Herdr cannot provide it,
that is a Herdr capability gap rather than a reason to duplicate Herdr inside
the Supervisor.

## 6. State model

`goal.json` stays unchanged and portable. `current.json` remains the one local,
authoritative checkpoint for the goal. `journal.jsonl` remains an audit trail.

Do not introduce an `attempts/` directory in the first version. Splitting live
state across goal and attempt files would make acceptance, relay, limits, and
recovery depend on several writes succeeding together.

A version 2 `current.json` should contain:

```json
{
  "version": 2,
  "goalId": "g_...",
  "revision": 12,
  "createdAt": "...",
  "updatedAt": "...",
  "attemptCount": 2,
  "activeAttempt": {
    "attemptId": "a_0002",
    "worker": {},
    "evidence": [],
    "progress": "...",
    "lastDecision": {},
    "observationCursor": {}
  },
  "closedAttempts": [
    {
      "attemptId": "a_0001",
      "startedAt": "...",
      "endedAt": "...",
      "outcome": "relayed",
      "summary": "...",
      "evidenceRefs": []
    }
  ],
  "verification": null,
  "terminal": null
}
```

This is a shape, not a final field-by-field schema. The important properties
are:

- there is exactly one active implementation attempt;
- closed attempts contain bounded summaries, not copied transcripts;
- raw decision history remains in `journal.jsonl`;
- verification is optional and belongs to the current implementation attempt;
- goal-wide facts change in one atomic file write.

All mutations remain serialized per goal. Ordinary state updates may not change
the active worker identity. Only a dedicated relay transition may close one
attempt and install a new binding.

Journal entries gain `attemptId` and, for verification events,
`verificationId`. The journal is evidence and audit history, not the source of
truth for the current state.

### Migration

The loader may present version 1 as an in-memory version 2 state with one active
attempt. On the next mutation it writes the complete version 2 checkpoint using
the existing atomic-write path. A failed write must leave the valid version 1
file intact.

Migration must have tests for interruption, retry, invalid legacy state, and
preservation of worker identity and evidence.

## 7. Relay

Relay is sequential. The old attempt must no longer be doing work before the new
attempt is instructed to proceed.

A relay should:

1. observe the current worker and record why relay is useful;
2. ask Herdr to stop or settle that worker;
3. close the attempt with a compact factual summary and evidence references;
4. choose the next deterministic attempt ID;
5. ask Herdr to start the replacement worker;
6. atomically install the new worker binding in `current.json`;
7. give the new worker the goal plus a compact handoff.

The handoff should contain:

- the unchanged goal and acceptance criteria;
- artifacts already produced, such as commits, diffs, PRs, or reports;
- checks already run and their results;
- current blockers and failed approaches that should not be repeated;
- links or identifiers for raw evidence when useful.

It should not copy a previous model's hidden reasoning or entire transcript.

Starting a replacement worker must be retry-safe. Use the exact `goalId`, a
deterministic `attemptId`, and an idempotency key. Do not infer identity from
objective text or role. If Herdr cannot accept an idempotency key, use a
deterministic Herdr worker name and reconcile it from a Herdr snapshot before
starting another worker.

Relay is a Supervisor judgment, not the automatic result of a steer counter.
A steer limit may bound cost, but reaching it does not prove that the worker is
ineffective. At the configured limit, the Supervisor must reassess whether to
relay, wait, change approach, or ask the human.

## 8. Independent verification

Verification should be added only after relay is working reliably.

The implementer must first produce an immutable review target: preferably an
exact commit, otherwise a captured diff, PR revision, or equivalent artifact.
The implementer is then paused while a separate worker checks that exact target
against the goal's acceptance criteria.

The reviewer:

- receives the original goal and acceptance criteria;
- receives the exact artifact identity;
- works in isolation supplied by Herdr where available;
- does not modify the implementation;
- reports findings with reproducible evidence.

Prompting a reviewer to be read-only is useful but is not enforcement. When the
runtime supports it, use a read-only sandbox or a separate worktree pinned to
the exact revision.

If verification passes, the Supervisor may accept the goal when all other
criteria are also covered. If it fails, the Supervisor sends the concrete
findings back to the same implementation attempt and resumes it. The human is
asked only when the findings reveal a real choice, missing authority, unsafe
action, contradictory requirement, or exhausted retry policy.

Verification is not a competing attempt and does not select a winner. Only the
Supervisor decides whether the evidence satisfies the goal.

The existing serialized review pump should remain serialized. Workers can run
without concurrent Supervisor model turns. Queueing review signals is simpler
and keeps goal decisions consistent. Change this only if measurements show that
the review queue itself has become a bottleneck.

## 9. Limits and policy

Local policy may define a small `maxAttemptsPerGoal`. This bounds retries but is
not part of portable `goal.json`.

Global worker or token limits belong to Herdr or operator configuration because
they describe runtime capacity, not one goal. With sequential relay, a global
concurrent-attempt budget is unnecessary.

Reaching a limit means the Supervisor must make a fresh judgment. It does not
mean the goal failed, and it does not always require human input.

## 10. Explicit non-goals

- two implementation workers writing concurrently;
- race mode and winner selection;
- cooperative splitting;
- sub-goals, dependencies, or a task graph;
- merge or conflict-resolution orchestration;
- a second worker runtime or status database;
- support claims for agent CLIs that cannot yet be observed and recovered.

If future evidence shows a need for one of these, it should receive a separate
proposal based on observed failures of the simpler design.

## 11. Possible delivery order if promoted

This is not an active roadmap. If live evidence promotes part of this proposal,
Stage A and Stage B are independent work streams. Relay must not wait for a
second CLI adapter; only the documentation correction is required first.

### Stage A — truthful CLI support

Correct the README to describe current support. Add other agent adapters as
independent features when their observation, identity fencing, and recovery can
be tested.

### Stage B — sequential relay

Add attempt identity, the version 2 single-file checkpoint, per-goal serialized
relay, compact handoff, retry-safe worker start, migration tests, and end-to-end
relay tests.

Success means a goal can move from one worker to another without changing the
goal ID, losing useful evidence, duplicating workers after retry, or allowing
the old worker to continue writing.

### Stage C — independent verification

Add exact-artifact verification with a paused implementer and an isolated,
read-only reviewer. Send failed findings back to the implementer and accept only
when the combined evidence covers the goal.

Success means the reviewer always checks the declared immutable revision, cannot
silently review moving work, and cannot become a second implementation owner.

### Then stop and evaluate

Measure whether relay is used, why it is used, whether handoffs lose important
context, how often independent review changes the result, and whether review
signals queue for too long. Do not add concurrency in anticipation of problems
that have not occurred.

## 12. Decision

Do not implement relay or verification yet. Exact identity, durable goal state,
event-driven review, and bounded health checks are the foundation. When a worker
cannot continue, the supervisor can currently explain the evidence and let the
model or operator choose a replacement using the existing goal contract.

Keep this proposal as design knowledge for that choice. Reconsider the smallest
sequential relay primitive only after repeated live cases show that ordinary
agent-led replacement is a common source of lost goals, unsafe duplication, or
material operator cost. A missing pane or one difficult recovery is not enough.
Independent verification remains a later, separate decision that also requires
measured demand. Keep concurrent implementation, races, and general coordination
out of scope.
