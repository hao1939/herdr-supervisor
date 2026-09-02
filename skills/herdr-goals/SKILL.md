---
name: herdr-goals
description: Form, inspect, compare, refine, start, or stop durable Herdr Supervisor goals. Use when a human discusses supervised goals or asks an agent to manage them; do not use for ordinary coding work inside an already assigned worker goal.
---

# Herdr Goals

Treat a goal as one durable outcome, not a task queue, one attempt, or one pull
request. The portable contract has four parts:

- `objective`: the outcome and its continuity horizon;
- `context`: stable facts needed after a fresh start;
- `acceptance`: observable evidence that proves the outcome; and
- `constraints`: lasting boundaries and reserved authority.

Write the smallest complete contract. Put each fact in one place, keep the
objective about the outcome rather than its execution plan, and add only
acceptance criteria and constraints that materially change proof or authority.
Do not fill every available array slot. Keep transient progress, waits,
credentials, provider state, and worker identity out of the contract.

## Understand the human first

Answer questions and discuss suggestions directly. Do not mutate a goal merely
because the conversation mentions one.

When durable execution is requested, form a concrete candidate contract from
the intended outcome before comparing it with stored goals. Recommend sensible
defaults. Ask one focused question only when the answer materially changes the
outcome, finite-versus-standing horizon, artifacts, proof, authority, or risk.
If execution was already authorized, do not ask for permission again after the
candidate becomes clear.

## Inspect and compare

If supervisor status actions are available, use them. Otherwise locate the goal
store from `HERDR_SUPERVISOR_GOALS`, or from
`${XDG_STATE_HOME:-$HOME/.local/state}/herdr-supervisor/goals`. Read its
`README.md`, then each relevant `goal.json`; read `current.json` for local
checkpoint state and `journal.jsonl` only for an audit question. Herdr remains
the source of live worker state. When exact goal IDs are known, inspect only
those goals; enumerate the store only when discovery is part of the request.

For a portfolio or system-health review, also read
`.supervisor/global-review.json` when it exists. It is a timestamped advisory
finding, not goal authority or current runtime truth. Verify a finding against
fresh Herdr and goal state before acting on it.

Present a portfolio compactly. For each active goal, lead with its outcome,
current state, latest material change, blocker if any, and next action. Put one
portfolio-wide finding after the goal summary rather than repeating it under
every goal. Recommend only changes that are actually needed.

Compare meaning, not words. Reuse an unfinished goal only when objective,
horizon, expected artifacts, and acceptance evidence substantially match.
Persist a complete contract update when the human changes that same durable
outcome. Start a distinct goal for a distinct outcome. Shared topics, sources,
tools, or repositories do not make goals equivalent.

## Separate durable refinement from current steering

A durable update changes what a fresh worker must pursue. Reconsideration only
wakes the existing worker to assess new transient evidence. Do not substitute
one for the other.

One-time adoption, migration, backlog transfer, or evidence reconciliation is
normally current execution, not the standing outcome. Preserve it in the
checkpoint and steer the current worker with exact references. If unfinished
handoff information must survive a portable fresh start, keep one short
reference in `context`; do not expand the objective and every acceptance rule
with migration mechanics. Remove that temporary context after the handoff is
sealed. Preserve large historical evidence by stable reference and integrity
proof instead of copying or replaying it without a concrete need.

## Apply through the validated path

Never edit goal-store files directly. Use the available supervisor actions for
start, complete-contract update, reconsideration, or explicit stop.

If this agent has no supervisor actions and the human authorized a mutation,
find the single live Herdr agent named `supervisor`, relay the requested
operation and the complete contract to it, and ask it to apply the contract as
written rather than redesign it. Do not relay a half-formed draft. If there is
no unique supervisor, report that boundary instead of guessing a pane.

Reconsider only goals materially affected by the new fact. Do not wake an
entire portfolio merely to refresh its display.

## Verify the effect

After a mutation, re-read the canonical `goal.json`, identify the exact goal and
worker, and confirm initial worker activity in fresh Herdr state. Report:

- what was created, reused, updated, reconsidered, or stopped;
- the exact goal and worker identities;
- any material difference between the authorized contract and stored result;
- whether the worker actually started or resumed; and
- any terminal or stopped pane that is now a manual cleanup candidate.

Do not claim success from a supervisor acknowledgement alone. Do not close a
pane automatically unless the runtime can atomically require the expected
terminal and native session; otherwise show the candidate and leave closure to
an explicit human action.
