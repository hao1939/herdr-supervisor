# Proof-of-concept validation record

**Status:** Historical design evolution and validation evidence. The current
design is [design.md](design.md).
**Date:** 2026-08-29

## 1. Purpose

Prove that one sleeping supervisor agent can keep a small set of existing
Herdr workers moving toward explicit goals with low idle overhead and without
building another task system.

The PoC is successful only if it works smoothly with workers that finish,
pause, ask questions, stall, crash, or produce an incomplete result.

## 2. User scenario

1. The human talks to the supervisor in one persistent Herdr pane and describes
   the outcome they want.
2. The supervisor uses the conversation to form one explicit goal and concrete
   acceptance evidence. It asks one focused question only when a missing answer
   would materially change the work.
3. The supervisor decides whether the goal belongs with active related work.
   It either adds a pane to that worker tab or creates a new unfocused tab,
   starts one Codex worker in an explicit absolute project directory, records
   the exact worker binding, and gives it the goal. The supervisor stays in
   its own tab and stable infrastructure directory; a worker never inherits
   the supervisor's directory. A human may still attach an
   already-running worker explicitly when needed.
4. The worker inspects that project root and owns the execution layout. For
   change-producing Git work it uses isolated worktrees when concurrent work
   or branch safety requires them. One goal may use several worktrees or
   repositories; this does not create more supervisor goals.
5. The worker runs the contract as a native Codex Goal and continues its own
   work-check loop. The supervisor is not the worker's continuation engine and
   consumes no model turns while nothing meaningful is happening.
6. Herdr events wake the supervisor when review is useful.
7. The supervisor explains important progress, asks only necessary human
   questions, and steers the same worker when more work is possible.
8. The supervisor stops supervising only after it verifies the acceptance
   evidence or the human explicitly stops it.

## 3. Mental model

There are only three active roles:

| Role       | Responsibility                                                |
| ---------- | ------------------------------------------------------------- |
| Human      | States goals, provides decisions, and retains final authority |
| Worker     | Pursues one contract as a native Codex Goal in a Herdr pane   |
| Supervisor | Reviews evidence and helps that worker continue               |

Herdr remains the runtime:

- Herdr owns panes, processes, sessions, live state, identity, and events.
- The worker owns implementation work and its evidence.
- The supervisor owns the judgment about whether the registered goal is
  progressing or accepted.

A goal binding is not another task. It does not have its own pending/running/
waiting lifecycle. It only attaches human intent and acceptance criteria to one
worker identity. The worker receives that canonical contract through its native
Codex Goal and never calls Herdr or Supervisor APIs.

## 4. Boundary

### In scope

- turn a direct human request into one goal with acceptance criteria;
- create and start one Codex worker for that goal, or explicitly attach an
  existing worker;
- observe multiple registered workers;
- react to Herdr state changes and native worker messages;
- perform a stale-progress review at a configured deadline;
- read bounded current output or structured history;
- steer the same worker;
- notify or ask the human;
- resume an exact stopped worker process conservatively when its pane remains;
- verify completion evidence;
- show a concise supervision view.

### Out of scope

- task trees, dependencies, queues, priorities, or project planning;
- automatically decomposing one goal into a worker tree;
- supervisor-owned worktree creation, merging, deployment, or CI ownership;
- replacing Herdr status detection;
- parsing every terminal update with an LLM;
- automatically approving permissions or destructive actions;
- supervising workers that were not explicitly registered;
- a web UI, Telegram bridge, or May integration;
- a public HTTP API or remote socket proxy; container access uses Herdr's
  existing terminal client boundary.

## 5. Initial deployment

The first supervisor is one persistent Pi session in a normal Herdr pane. Its small
extension connects directly to Herdr's local socket for snapshots, lifecycle
events, bounded reads, and identity-fenced prompts. This is enough on the
installed Herdr 0.8.0 protocol, so Bellwether is not a required dependency.
It remains useful prior art and may be reconsidered only if later stages reveal
a capability that the direct contract cannot provide simply.

The supervisor's model is configurable. Workers can use any agent Herdr can
observe. An optional Herdr plugin may later display supervisor metadata, but it
must not own reasoning or duplicate the watch loop.

No standalone daemon is required for the first PoC. The Pi session is both the
human-facing supervisor conversation and its long-lived judgment context; its
watches are dormant while workers run.

The same boundary can run inside one container: the Herdr server, worker panes,
and supervisor Pi share the private local socket, while the goal/session home
and workspace are separate mounts. The operator attaches through
`docker compose exec`; remote hosts use Herdr's existing SSH client. Herdr
0.8.x has no native HTTP or browser UI, so the container exposes no network port
and does not turn the local socket into a public API.

The dedicated container starts the supervisor from
`HERDR_SUPERVISOR_DIRECTORY`, which defaults to `/app`. Worker creation always
requires its own absolute starting directory. This keeps supervisor conversation
state independent of whichever project a worker edits without adding project
registries or directory inference. The starting directory is a discovery root;
the worker remains responsible for inspecting the checkout and creating any
isolated Git worktrees its goal needs.

### Creating or continuing work

There is no separate Task object or task-creation API. For each human request,
the supervisor model first compares the intended outcome with the active goals.
If one already represents the outcome, it continues that exact goal and worker.
Otherwise one `supervisor_start_goal` call mechanically creates a pane, starts
Codex, captures its native session, records the goal contract and binding, and
sets a native `/goal` that points to that canonical contract. The model decides
reuse, objective, relevant context, acceptance criteria, constraints, starting
directory, and placement; code only validates and executes that decision. When
the repository has concurrent workers, that fact and the isolated-worktree
requirement belong in the goal contract so Codex does not have to infer unseen
collaboration.

The same rule applies when the human changes an active goal. The model first
identifies the fitting existing goal, constructs its complete revised contract,
and calls one `supervisor_update_goal` operation. Code validates and atomically
replaces `goal.json`, refreshes the active projection, journals the material
change, checks the exact worker identity, and tells that same worker to re-read
the contract. The native Goal keeps the stable contract path; it is an execution
projection, not another authority. A refinement never creates a sibling goal
and durable requirements are never represented only by a transient steering
message.

Workflow policy is contract data, not keyword logic in the extension. If a
project requires code changes to use isolated worktrees, focused clean PRs,
overlap reconciliation, and an ADO pipeline run against the exact proposed
commit, the model writes those facts into constraints and acceptance criteria.
Capacity throttling can delay such a criterion but cannot waive it unless the
human later refines the contract.

Communication style is a small global behavior rather than goal-specific
workflow policy. Both initial and refined worker prompts request plain-language
progress and results while preserving exact evidence. The supervisor translates
worker evidence for the human, explains impact and next action, and defines
uncommon acronyms instead of exposing internal process jargon.

Git topology stays below this boundary. After receiving the goal, Codex may use
one or several worktrees or repositories. The supervisor reminds it to protect
shared checkouts, but it neither assumes one worktree per goal nor persists a
workspace registry.

## 6. Minimal durable state: contract, checkpoint, audit

Each goal has one stable directory. It is never moved merely because the goal
finishes:

```text
goals/
└── g_8f12ac90/
    ├── goal.json
    ├── current.json
    └── journal.jsonl
```

`goal.json` is the portable semantic contract. It contains only the objective,
context required to pursue it, acceptance criteria, and constraints. It has no
local goal ID, worker, native session, progress, status, cursor, or history.
Copying this one file to another instance is enough to start a fresh local
execution of the same goal.

```json
{
  "schema": "herdr.goal/v1",
  "objective": "Make the requested behavior true.",
  "context": ["The affected project is /work/project."],
  "acceptance": ["The focused test passes.", "The user-visible behavior is demonstrated."],
  "constraints": ["Do not deploy without approval."]
}
```

`current.json` is the local execution checkpoint. Together with `goal.json`, it
contains what the supervisor needs after a restart: the exact worker and native
session, evidence references, observation cursor, latest
progress and decision, and an optional accepted or stopped result. It does not
copy current worker status; Herdr remains the only authority for panes,
processes, identities, and status. Native worker transcripts remain the
detailed execution evidence.

```json
{
  "version": 1,
  "goalId": "g_8f12ac90",
  "revision": 4,
  "createdAt": "2026-08-28T10:00:00Z",
  "updatedAt": "2026-08-28T10:08:00Z",
  "worker": {
    "paneId": "w1:p2",
    "terminalId": "term_abc123",
    "agentSession": {"source":"herdr:codex","agent":"codex","kind":"id","value":"native-session-id"}
  },
  "evidence": ["Focused test: 12/12 passed"],
  "progress": "Live behavior still needs verification.",
  "lastDecision": {
    "decision": "steer",
    "at": "2026-08-28T10:08:00Z",
    "action": "Asked the worker to verify the live behavior."
  },
  "observationCursor": {"kind":"codex-jsonl","path":"/exact/native/session.jsonl","offset":12345}
}
```

`journal.jsonl` is only a chronological audit: what materially changed, what
the supervisor reviewed, what it decided or did, and why the goal was accepted
or stopped. It is not replayed to discover either the goal or current execution.
A missing or malformed journal makes history unavailable but cannot prevent the
goal from continuing. A missing or malformed `goal.json` or `current.json` fails
closed; the supervisor must not guess semantic or execution state from history.

Contract and checkpoint writes sync the new file, atomically replace their
respective file, and sync the parent directory so the rename survives a host
crash. Audit
entries carry the local goal ID and checkpoint revision they describe. One
supervisor process owns writes; commands reach that process instead of editing
goal files concurrently. This avoids a lock service or database. If an update
is interrupted, recovery reloads `goal.json` and `current.json`, then rechecks
fresh worker facts. It never applies an audit entry as state. An audit write
failure is visible and retryable but cannot change the goal or checkpoint.

The effective review context is `goal.json` plus `current.json`, a fresh Herdr
snapshot, and newly observed native worker evidence. Both JSON files stay
compact even when a goal runs for years. `progress` replaces the previous local
summary, while evidence retains only what is still needed
to pursue or verify the goal. A discovery that changes required future context
is deliberately written to `goal.json`; ordinary progress remains local in
`current.json`. Superseded detail remains in the audit or native transcript.
Independent size bounds reject unbounded context instead of silently growing
every review prompt.

A goal describes a durable outcome, not one attempt, command, pipeline run,
approval, or preferred route. Its acceptance criteria say what must ultimately
be true without unnecessarily making one implementation path the whole goal.
The objective and criteria cover the same scope and time horizon. A finite
review cycle may be a goal when that is what the human requested; it must not be
used as a quiet substitute for an ongoing or broader improvement outcome. An
ongoing outcome is recorded as a standing learn-and-improve loop: each review,
fixed backlog, PR, merge, or raised threshold is a checkpoint that feeds the
next cycle. The supervisor does not invent a finite convergence boundary to
make it finishable; only an explicit human instruction stops or replaces it.
When progress becomes stale, the LLM reassesses both the execution and the
contract: whether the outcome is still coherent, useful, current, and
achievable, and whether the observed blocker stops the outcome or only one
path. It continues independent work, alternative proof, mitigation, or useful
preparation when those remain in scope. If the contract itself has become
obsolete, contradictory, or impractical, the supervisor asks the human one
concrete question; it does not silently rewrite the goal or repeatedly preserve
an impossible wait. Code supplies the compact current facts and executes the
decision. It does not infer goal quality or alternatives from keywords.

Execution ownership follows the goal, not the repository. A worker may create
and use one or more worktrees for its goal, but the starting checkout and every
other goal's worktree are read-only discovery sources. This includes commands
described as tests, generators, formatters, installers, or baseline checks,
because their write behavior cannot be inferred safely from their names. A
worker that needs a clean baseline creates another goal-owned worktree. This is
a semantic worker contract, not command keyword matching in the infrastructure.

Human attention is also an authority boundary, not a generic failure path. A
worker and supervisor exhaust safe in-scope alternatives before asking the
human, and distinguish missing convenience tooling or default credential
wiring from genuinely missing capability, authority, or information. The LLM
makes that semantic judgment; execution code does not infer it from command
names or error keywords.

The live supervisor scans goal directories once at startup, reports malformed
entries without hiding healthy ones, and keeps only active goal projections in
memory. Events and deadlines therefore scale with active workers, not years of
completed history. Restart simply rebuilds this disposable cache from the goal
directories; it is not another durable index.

An unfinished goal always resumes the same worker and native session. Worker
identity is the native agent session; the Herdr pane is its routing slot and
the terminal ID is a transient location checkpoint. When Herdr restores the
same native session in the same pane after a restart, the supervisor refreshes
that checkpoint instead of treating the new terminal process as a replacement.
If that pane disappeared and the recorded session supports exact resume, one
`steer` decision may create a new routing pane, resume that saved native session
there, and update the local location checkpoint. Recovery reuses the goal's
deterministically named empty tab after an interrupted creation response, so
retry does not multiply panes. A pane is
not the durable worker identity.
Supervised Codex processes keep native Goals enabled. `goal.json` remains the
single portable authority; the native Goal is the worker's persisted execution
loop and points back to that file. Codex therefore owns ordinary
work-check-continue behavior, while the Supervisor owns cross-worker judgment,
stale recovery, human escalation, and independent acceptance. An automatic
Herdr restore reopens the exact session and explicitly resumes its paused
native Goal; unattended workers never stop at Codex's interactive
`Resume paused goal?` choice. One Supervisor `steer` decision first resumes a
settled Codex Goal, then sends the evidence-backed instruction into its active
turn on the same exact session. If the process has exited, the same action
recovers that exact session first. Transport is not a model decision.
Resume also selects the native session's saved directory when no caller has
made an explicit choice. Goal-owned worktrees therefore survive process or
container recovery without an interactive directory-confirmation gate. The
empty routing pane may start in the supervisor's stable directory; that is not
the worker's resumed directory and does not become goal state.
The last recorded `ask_human` decision restores the goal's human-wait state and
its bounded reconsideration time.
Until the human answers, ordinary restart noise and worker events remain quiet.
The stored deadline still wakes a bounded reconsideration of alternatives.
The native identity is immutable within that local execution. To run a goal
elsewhere or again, copy its `goal.json` into a new goal directory and explicitly
select a new worker. Old checkpoints and logs are neither required nor moved.
Exact recovery of the original execution is a separate local operation that
requires its original runtime and native session.

Pending signals and the one armed timer stay in memory. A concrete wait's
condition and absolute review deadline live in `current.json`, as does a human
wait through its last decision and wait record, so restart does not lose either.
When a watched external revision changes, that one unresolved change also lives
in `current.json` until a later native final response advances the delivery-time
cursor, or a transcript-free worker settles with a changed delivery-time
terminal fingerprint and a newer Herdr sequence.
Polling schedules remain disposable and are not rebuilt as durable workflow.
None of these files contains raw events, terminal output, reconnects, or copied
Herdr status.
The PoC needs no task store, replay framework, export command, archive
operation, or status database.

## 7. Event flow

```text
register worker
  -> read and fence exact Herdr identity
  -> save goal binding
  -> arm state/result watches
  -> review immediately when the worker is already settled or blocked
  -> return immediately

For a worker created by the supervisor, its launch includes one neutral first
turn that initializes the native Codex session without inspecting or changing
files. Supplying that turn as a launch argument avoids racing terminal input
against Codex startup. Identity capture and the durable goal binding then happen
before the goal prompt is delivered. If the native session hook does not report
an identity, the new worker remains unassigned and the goal is not sent.
Retrying the same goal reuses that pane instead of creating another. This makes
integration failure visible without creating orphan work. The dedicated image
includes the runtime required by Herdr's managed Codex hook.

When the operator explicitly enables unattended full-access container mode,
the same launch trusts only the worker's selected starting directory through
Codex's project trust setting. This prevents an interactive trust screen from
blocking native session creation without globally trusting unrelated paths.

Herdr event or stale deadline
  -> coalesce latest signal for that worker
  -> read a fresh Herdr snapshot
  -> reject identity mismatch
  -> start one scoped supervisor turn
  -> observe that exact worker once
  -> make and apply at most one steering or acceptance decision
  -> end the turn
  -> wait for the next Herdr event or stale deadline

Supervisor restart or resumed session
  -> load each goal.json and current.json directly
  -> fetch one fresh Herdr snapshot
  -> restore exact wait deadlines
  -> reread bounded worker evidence before waking an unchanged settled wait
  -> reconsider expired waits, recorded peer decisions, new evidence,
     and failures from current facts
  -> continue normal event-driven supervision
```

### Signals

| Signal                                   | Default behavior                                                        |
| ---------------------------------------- | ----------------------------------------------------------------------- |
| Output/activity while `working`          | No lifecycle wake; the bounded review deadline remains the safety net   |
| `blocked`                                | Review immediately and determine whether the worker or human can answer |
| `idle` or Herdr `done`                   | Review the result; never assume goal completion                         |
| Agent process exits but pane remains     | Continue the goal; code resumes the exact session                        |
| Pane disappears                          | Let `steer` relocate and resume only the exact saved native session      |
| Pane occupant changes                     | Fail closed; ask the human only when a real decision is needed           |
| Stale deadline                           | Inspect current evidence before deciding whether to steer               |
| Human message                            | Review immediately with the new authority or information                |
| Linked worker records a decision         | Reconsider only goals explicitly waiting on that worker                 |

The event means "reconsider this goal now." It never decides success by
itself.

One review turn is deliberately bounded. It may successfully observe only its
exact worker once. After steering or accepting, no more supervisor tool calls
are allowed in that turn. Worker events received while the turn is active are
coalesced; after the turn settles, the extension rereads Herdr's authoritative
state and starts another review only when the latest state warrants one. The
model never polls a worker while waiting for its instruction to run.

Recovery never blindly replays an interrupted action. It rereads current Herdr
state and recent evidence and lets the model decide again. A previous prompt may
already have reached the worker, so current facts take priority over reconstructing
the exact interrupted turn.

## 8. Worker-transparent observation

The worker is responsible only for pursuing its goal and communicating
normally through its native agent interface. It must not call a supervisor
command, emit a protocol marker, know its Herdr pane, or maintain supervision
state.

The infrastructure boundary is a small observation operation:

```text
observe(exact worker identity, previous cursor)
  -> new native assistant messages
  -> current cursor
  -> source and truncation facts
```

The adapter performs only mechanical collection. It does not classify text,
guess progress from keywords, or decide whether the goal is complete. The
supervisor model makes those semantic decisions from the goal, acceptance
criteria, and collected evidence. Worker messages are untrusted evidence for
that judgment, not instructions to the supervisor and not text to repeat as the
supervisor's own response.

The initial Codex adapter resolves the native session ID reported by Herdr and
reads only new assistant messages from that session's JSONL record. It excludes
user, developer, and reasoning records. A cursor prevents rereading the whole
session. A new goal binding begins with only the latest assistant message, so
earlier goals from a reused worker session cannot become evidence for the new
goal. Later reviews receive every new bounded assistant message after that
cursor. Other agents use a bounded terminal fallback until their native adapters
are justified and implemented.

Herdr lifecycle events answer "when should this goal be reconsidered?" Native
agent records answer "what did the worker communicate?" Neither one alone
decides success. For a settled wait whose deadline is still in the future, an
idle/done lifecycle event wakes a model turn only when bounded native evidence
changed; restart-only lifecycle noise leaves the durable timer intact.

## 9. Supervisor decision

Code collects context and applies a decision. The model makes the semantic
decision. Separate narrow tools are the execution interface; they are simpler
and safer than a generic workflow object. Every automatic review must still end
with exactly one explicit, validated decision:

```json
{
  "decision": "leave | steer | ask_human | accept",
  "progress": "Plain-language account of what is now true",
  "message": "Optional exact message for the worker or human",
  "evidence": ["Required when accepting"],
  "reviewAt": "2026-08-29T00:00:00Z"
}
```

Meaning:

- `leave`: progress is healthy; do not interfere.
- `steer`: continue the same worker with one useful instruction; code resumes
  its exact session automatically when the process has exited.
- `ask_human`: a real decision or missing fact requires the human.
- `accept`: current evidence covers the whole objective and every acceptance
  criterion at their declared horizon. A final worker message, one PR or run,
  or completion of one review cycle is only evidence unless it proves that
  entire outcome.

The corresponding tools are `supervisor_leave`, `supervisor_steer`,
`supervisor_ask_human`, and `supervisor_finish`. The
executor contains no keyword router for these judgments. It validates tool
arguments, authority, identity, evidence requirements, and the one-decision
turn boundary, performs the operation, records one concise audit entry after
the outcome is known, and atomically updates the current goal context.

`supervisor_leave` also covers a settled worker whose next step has one concrete
peer or external condition. The model supplies that condition as structured
input. A direct peer wait also supplies that worker's exact pane identity, so
code can resolve and store the peer's durable goal identity without interpreting
prose. The pane remains a last-known routing hint; relocating the peer cannot lose
the relationship. The runtime assigns the normal bounded review interval when
the model supplies no exact time. For an event-backed wait, the model may choose
a slower evidence-appropriate safety check because a peer decision or watched
external change still wakes the goal earlier. A settled worker without a
concrete condition is still rejected. When several goals share
scarce capacity, one active worker may use or probe it. That responsibility ends
when the worker becomes
idle or externally blocked: its recorded supervisor decision wakes linked peers
and the LLM decides which useful work can proceed. Raw lifecycle changes wake
only their own goal; they do not spend speculative peer reviews. This avoids
both a resource scheduler and an idle convoy.
The peer identity is only an early-wake hint: an invalid or self-referential
hint is dropped while the concrete condition and bounded deadline remain
authoritative. Events improve latency; they are never required for eventual
reconsideration.

`leave` must be explicit. Ordinary model prose is not a completed decision,
because the runtime must distinguish a deliberate choice from a malformed,
interrupted, or purely narrative response. If a turn settles without one valid
decision, no action or evidence checkpoint is committed and one bounded retry
is scheduled. If a decision was completed, settlement preserves the timer or
human wait chosen by that decision instead of replacing it with the generic
review interval.

`reviewAt` is an absolute ISO timestamp bounded to the next 24 hours. Execution
code supplies the normal review interval when the model omits it; the model
copies a later time only when current evidence provides a real exact retry
boundary. The same field can accompany a `steer` decision when a worker should
continue now but one named operation must be checked at an exact later time.
A linked peer decision may wake the goal earlier. Exact deadlines are checkpointed,
restored after restart, and never suppressed as routine activity. A bounded
native-evidence check suppresses routine working/no-change model turns; new
evidence, exact deadlines, settled workers, and real failures still wake
promptly.
Every review states its exact current UTC time so the model compares like-for-like
timestamps rather than guessing from the conversation date.

A wait is a promise to reconsider, not a terminal disposition. At the deadline
the supervisor confirms the condition from fresh evidence, reassesses whether
the goal is practical and whether the condition blocks the whole outcome or
only one route, looks for safe mitigation or alternative proof, and continues
independent useful work or preparation. It may wait again only when fresh
evidence shows that nothing meaningful can move and supplies the next exact
boundary. A linked peer's next recorded supervisor decision triggers the same
reconsideration immediately; its raw lifecycle changes wake only that peer's
own goal.

If one external or peer condition is the worker's only remaining blocker, the
worker reports the exact boundary once and lets its native Goal block. It does
not sleep, poll, or repeatedly reread unchanged state. The existing external
watch, peer-decision wake, or bounded review resumes that same session; no
second watcher or waiting workflow is needed.

`ask_human` is an explicit supervisor operation because it has different
effects from steering: it shows one question, closes the review turn, and leaves
the worker untouched. Its wait and bounded reconsideration time are stored in
the checkpoint and restored after restart. The human's answer may then steer
that same worker once. If no answer arrives, the later review checks for a
mitigation or independent work instead of forgetting the goal. No waiting task
or durable message queue is created.

## 10. Shared supervisor context

The PoC deliberately uses one persistent supervisor session. Each review is a
new, self-contained request inside that session. Completed automated review
turns remain visible in its log but leave model context when the next review
starts; their durable progress is already in the goal checkpoint. Direct human
conversation remains in context. The new request clearly re-establishes which
worker and goal the model must judge without repeatedly sending old goal,
observation, and tool blocks.

Only one registered worker is the subject of a review turn. Its request
includes:

- goal and acceptance criteria;
- the goal's current evidence, progress, and last decision;
- exact current Herdr identity and state;
- the event or deadline that caused review;
- new native assistant messages since the previous observation cursor;
- a bounded terminal fallback only when native evidence is unavailable;
- new human steering, if any;
- allowed decisions and safety limits.

The model may use relevant human conversation history and current goal state,
including relationships the human established between goals and the recorded
previous action for this worker. If
the worker depends on a peer, the model may read the existing all-worker status
and use recorded peer progress for coordination. It must not treat another
worker's evidence as proof that the current worker is complete. We first trust
the model to make that semantic distinction from the explicit review request;
no relay service or cross-goal state is added. Acceptance criteria are
explicitly labeled as worker criteria; the supervisor's own response cannot
satisfy them.

The supervisor normally resumes the same Pi session after failure so useful
conversation history remains available. `goal.json` and `current.json` make
correctness depend on explicit goal context and fresh facts rather than perfect
session history. A new supervisor session can therefore continue at some
additional review cost.

Separate model sessions, generated summaries, retry counters, and retrieval
machinery are deferred unless a controlled trial shows a real failure that they
would solve.

## 11. Concurrency and coalescing

- Workers run concurrently, while the one supervisor session makes one semantic
  judgment at a time.
- Each worker has at most one pending review signal. Repeated signals coalesce;
  the eventual review always rereads authoritative Herdr state.
- Pending workers are reviewed in first-observed order, so a noisy worker cannot
  continually displace another worker.
- Events received during a worker review cause at most one later review of that
  worker.
- A review fence rejects another pane, a repeated successful observation, and
  every tool call after steering or acceptance until the model turn settles.
- The goal checkpoint exposes its previous steering decision to the next
  bounded review; code does not guess whether semantic actions are duplicates.
- No durable work queue is introduced. On restart, every unfinished current goal
  is restored and checked against fresh Herdr state. Healthy working goals get a
  fresh bounded deadline without a model turn; idle, blocked, missing, or
  identity-changed workers are reviewed immediately.

The small in-memory set of workers needing reconsideration is coordination for
the shared model session, not another work queue. Human commands and Herdr
workers remain responsive while the model reviews one worker.

## 12. Stale progress

The stale-progress deadline means a registered goal has gone too long without
a supervisor review. It is a recovery safety net, not a claim that the worker
made no progress and not merely an idle terminal.

A live worker that is still working remains working. Its next useful checkpoint
belongs in progress, not in a wait condition. If current evidence gives an
exact retry boundary, the decision also records `reviewAt`; this is scheduling,
not a claim that the whole worker is waiting. A wait is recorded only after the
worker settles on a concrete external or peer condition that can resume it.
This keeps the human view truthful and lets routine quiet-working checks remain
cheap without losing known retry boundaries.

Use one nearest-deadline timer for all registered workers. Deadlines are
temporary scheduling hints, not durable goal truth:

1. Compute the earliest `nextReviewAt`.
2. Sleep until it or an event arrives.
3. Review only the workers whose deadline elapsed.
4. Let the explicit review decision choose the bounded next interval.
5. Recompute the nearest deadline.

Do not continuously poll workers or replay their logs globally. Focused stale
reviews still read current Herdr state and bounded native messages because an
event may have been missed or delayed. In addition, one deliberately
low-frequency global review receives only the compact current projection across
goals. That projection includes saved unstarted contracts as `workerState:
"unstarted"`, so a failed launch or copied contract cannot disappear merely
because it has no checkpoint or worker. It catches circular waits, several
goals affected by one runtime fault, and a stuck supervision path that no single
goal can explain. A finding names the goals it concerns for a human-readable
report. Only the separate `reconsider` decision queues an ordinary focused
review, and only for a goal with a worker, so reporting a shared condition does
not itself spend one model turn per affected goal. The next
focused deadline starts after its review turn settles, so a slow model turn
cannot enqueue another review behind itself.

The global signal coalesces to one pending review and runs after human and
focused work. It uses the same Pi session and must end with one structured
`supervisor_global_result`. Its checkpoint stores the last and next review
times, snapshot and finding hashes, and the last bounded human-visible finding
under `goals/.supervisor/`; it is not a Task or portable goal state. The next
review receives that finding and returns the complete set of findings still
proven by current evidence. Code suppresses an identical set, while an empty
set clears the remembered finding so a later recurrence is visible. Restart
runs an overdue review immediately. A failed or incomplete global turn receives
one bounded retry and never partially routes unknown goal IDs.

A goal waiting for the human keeps a bounded deadline. When it expires, the
supervisor checks whether the answer is still necessary, whether the blocker can
be mitigated, and whether independent useful work can proceed. Ordinary worker
events do not repeat the question before that review.

## 13. Failure handling

| Failure                       | Behavior                                                                                           |
| ----------------------------- | -------------------------------------------------------------------------------------------------- |
| Supervisor or Herdr reconnect | Resume the same Pi session when available, load unfinished goals directly, fetch one snapshot, and re-arm watches |
| Worker occupant changed       | Stop and ask the human; never prompt the replacement automatically                                 |
| Exact worker process stopped  | Refresh an empty restored pane's terminal when needed, resume only the exact native session, then continue |
| Worker pane disappeared       | On `steer`, resume a supported exact saved session in a new routing pane; otherwise ask the human    |
| Malformed or missing decision | Apply no action or checkpoint, record a visible diagnostic, and schedule one bounded retry         |
| Prompt/send failure           | Re-read current identity and state before one bounded retry                                        |
| Herdr reports blocked         | Read new native evidence and determine whether existing context can unblock it before asking the human |
| Worker repeatedly stalls      | Improve the steer from shared history, then ask the human when further steering is not useful      |
| Completion claim lacks proof  | Steer the same worker to verify; do not accept or spawn another worker                             |
| Supervisor session disappears | Workers continue unaffected; a resumed or new Pi session loads current goals and reconciles fresh facts |

## 14. Safety

The same extension has three explicit authority modes:

- `observe` displays meaningful signals but starts no model turn and cannot
  mutate a worker;
- `dry-run` wakes the model and displays its proposed action but cannot mutate
  a worker or accept a goal;
- `live` may prompt an identity-matching registered worker and accept its goal.

The PoC starts in `observe`, followed by `dry-run`.

Live mode permits only:

- creating one Codex worker for a direct human goal;
- prompting a registered, identity-matching worker;
- starting or resuming that exact worker when the recovery policy allows it;
- notifying the human;
- marking the local goal binding accepted or stopped.

Starting or attaching a goal and explicitly stopping a binding are human-driven
control-plane operations handled by the supervisor process. The LLM may start a
goal while fulfilling a direct human turn, but the executor rejects that tool
during an event-driven worker review. The standalone CLI is read-only. This
preserves one writer and prevents a review wakeup from changing the goal it is
supposed to judge.

The PoC may not close panes, delete worktrees, approve permissions, merge, push,
or deploy. An event-driven review may not create another goal or worker. Those
capabilities require separate evidence and authorization.

## 15. Human view

The default view should answer four questions without exposing internal
machinery:

```text
Worker     Goal                         Now               Next
codex-api  Fix request cancellation     testing fix       review on settle
claude-ui  Simplify task presentation   needs your input   choose layout A/B
```

Opening one row shows:

- current progress and evidence;
- why the supervisor last acted or chose not to act;
- what the worker is doing next;
- what the human needs to do, if anything;
- the exact worker pane and goal acceptance criteria.

The default and detail views read `goal.json` and `current.json`, never the
journal. An explicit history view reads the audit lazily in bounded newest-first
pages, so years of history do not affect routine status or review latency.

Progress and result notifications are delivered at most once per meaningful
event. Transport metadata remains secondary.

This view combines the portable goal contract, local checkpoint, and a fresh
Herdr snapshot. Audit history is shown only when requested. The view never
stores or displays copied live status as goal truth.

## 16. PoC stages

### Stage 1: passive observation

- **Implemented:** register existing workers and update one binding per pane.
- **Implemented:** arm non-blocking Herdr lifecycle subscriptions.
- **Implemented:** show fresh state and meaningful transitions.
- **Implemented:** immutable native agent-session fencing, with the Herdr pane
  as its routing slot and the current terminal as a refreshable local checkpoint.
- **Verified:** passive mode starts no model calls and performs no worker
  mutation.

### Stage 2a: event-driven dry-run review

- **Implemented:** collect new native Codex assistant messages without worker
  participation.
- **Implemented:** invoke the model on blocked, settled, and exited signals.
- **Implemented:** display proposed steering or acceptance without applying it.
- Compare dry-run decisions with human judgment on controlled workers.

### Stage 2b: stale-progress review

- **Implemented:** use one nearest-deadline timer across all registered workers.
- **Implemented:** wake only workers whose review deadline elapsed.
- **Implemented:** re-read live state and bounded native evidence before
  proposing an action.
- **Verified:** a legacy binding without a deadline received one recovery
  review, then moved to the configured next deadline.
- **Verified:** a short-interval test exposed and fixed overlapping review
  wakeups; signals now coalesce while a worker review is in flight.

### Stage 2c: shared-session context switching

- **Implemented:** one persistent Pi session serializes semantic reviews while
  workers continue concurrently.
- **Implemented:** every review request restates the exact worker, goal,
  acceptance criteria, trigger, and next review operation.
- **Implemented:** signals for other workers coalesce in a fair in-memory set
  until the current model turn settles.
- **Verified:** one controlled dry-run reviewed two distinct Codex panes in the
  same Pi session. It accepted only the completed Alpha goal, then observed and
  proposed further work only for the active Beta goal. Each tool call used the
  correct pane and goal evidence, and dry-run mode made no worker mutation.
- **Verified:** one live trial registered three concurrently finishing Codex
  workers. The shared supervisor reviewed Alpha, Beta, and Gamma sequentially,
  used only each worker's exact native-session evidence, accepted all three,
  and left no goal binding behind. No worker was starved or reviewed twice.

- **Finding:** the first live run made correctly scoped decisions but sometimes
  echoed a bare worker completion token afterward. The ambiguous `Accept when`
  heading was replaced by explicit worker acceptance criteria, and the role
  contract now says worker messages are evidence rather than instructions.
- **Verified:** the follow-up run reported acceptance in the supervisor's own
  plain-language voice instead of presenting the worker token as its response.
- Keep testing with longer histories and related goals before enabling live
  steering broadly; add isolated model contexts only if those trials expose a
  concrete context-switch failure.

### Stage 2d: compact global recovery review

- **Implemented:** one low-frequency timer coalesces a compact review across
  current goal checkpoints, Herdr worker states, waits, and supervisor health.
  Human turns and focused reviews always drain first.
- **Implemented:** one structured global result validates every referenced goal
  before recording findings, and queues the existing focused review path only
  for explicit `reconsider` decisions. It never reads worker logs or acts on
  several workers itself.
- **Implemented:** saved contracts without workers appear in the same compact
  goal projection as `unstarted`; they may be reported as findings but cannot be
  sent through the focused worker-review path.
- **Implemented:** a small atomic checkpoint restores the next deadline after
  restart, retries one missing decision, and suppresses unchanged findings.
- **Verified:** focused tests cover compact context, priority, atomic reference
  validation, focused fan-out, persisted restart deadlines, finding coalescing,
  and in-process timer re-arming.
- **Verified live:** the first MLVM restart reconciled due idle goals before one
  global turn, which found no additional systemic fault, routed no unnecessary
  work, persisted its one-hour deadline, and left later Herdr events to normal
  focused reviews. A second restart preserved that future deadline instead of
  repeating the global model call.

### Stage 3: bounded live steering

- **Implemented:** permit `leave`, one-message `steer`, and one explicit
  plain-language question to the human without touching the worker.
- **Implemented:** enforce one exact-worker observation and at most one applied
  decision per event-driven model turn.
- **Verified:** an idle Codex worker that had created the requested file without
  verification was observed once and steered once. The supervisor turn then
  settled instead of polling while the worker ran.
- **Verified:** a missing human choice produced one direct question and no
  worker prompt. The plain answer steered the same worker once; its next event
  supplied the evidence used for acceptance.
- **Verified:** one recoverable refusal was resolved by a more concrete second
  steer. A hard-refusal worker received three distinct attempts, then the same
  supervisor session asked whether to replace or reset it; no retry counter or
  task was needed.

### Stage 4: acceptance and recovery

- **Implemented:** permit evidence-backed `accept`.
- **Implemented:** treat the subscription acknowledgement as the reconnect
  boundary, then reset retry backoff and reread current Herdr state so a
  transition during the disconnect is not lost until the stale deadline.
- **Verified:** the worker's later idle event began a new review turn; the
  supervisor observed the new byte-exact output once and accepted the binding.
  The first turn contained exactly observe/steer, and the second exactly
  observe/finish.
- **Verified:** Pi was stopped after steering while the worker remained active.
  The worker finished while the supervisor was down; resuming the same Pi
  session reloaded the binding, observed only sequence-new evidence, accepted,
  and did not repeat the steer.
- **Verified:** replacing the Codex session in the same pane produced an exact
  native-session mismatch. The replacement received no prompt. The first run
  exposed that the turn fence did not count a verified mismatch as collected
  evidence; the minimal correction now permits a safe human question or
  evidence-backed stop without exposing replacement output.
- **Verified:** the socket fixture reports readiness once and reports a dropped
  ready subscription once.
- **Verified live:** replacing the dedicated container restored the same Pi
  supervisor, goal, worker pane, and native Codex session. Herdr assigned a new
  terminal process ID; the supervisor refreshed that transient location and
  continued supervision without asking the human to repair or replace work.
- **Implemented:** distinguish a stopped agent process in an existing pane from
  a missing pane or replacement occupant. A single `steer` operation prompts a
  present process or resumes the exact session in the first case.
- **Verified:** after the registered Codex process stopped, the supervisor
  resumed its exact native session and paused Goal in the same terminal, sent
  one continuation, observed the exact `RECOVERY_POC_OK` result on the next
  event, and accepted the goal. No replacement worker or goal was created.
- **Verified:** continuing a stopped worker resumes its exact session, while
  continuing a `done` worker whose process is still present prompts it normally;
  the model cannot select the wrong transport or start a duplicate process.
- **Finding:** Herdr does not emit an event when `interactive_ready` changes.
  Its own start command polls `agent.get` during startup. The supervisor mirrors
  that bounded 200 ms readiness handshake only inside automatic exact-session
  recovery, with the continuation in the resume command. Normal supervision
  remains event-driven and idle.
- Decide from evidence whether Shepherd or any additional component is needed.

### Stage 5: goal-backed simple recovery

- **Implemented:** the shared binding file is replaced by one stable directory
  per goal containing
  portable `goal.json`, local `current.json`, and audit-only `journal.jsonl`.
- **Implemented:** keep the portable semantic contract in `goal.json` and the latest local
  execution checkpoint in `current.json`; startup must not replay history.
- **Implemented:** record completed reviews, action results, material human changes, acceptance,
  and explicit stops in the audit journal without making it runtime authority.
- **Implemented:** explicit `leave` uses bounded `reviewAt`; a turn that only narrates
  an intention is not complete.
- **Implemented:** an expired external wait cannot be extended from an unchanged
  settled-worker observation; the same worker must check the condition or take
  another concrete action.
- **Verified live:** after one required ADO reread returned unchanged, a native
  Codex Goal initially reread the same build every two minutes. It then stopped
  polling, completed independent owner-safe work, and, once the external build
  was the only remaining path for three consecutive turns, marked the exact
  recoverable boundary as blocked. The supervisor retained one ADO watch and a
  six-hour safety check without queueing a duplicate run. Shared policy was
  enough; no second scheduler, waiting workflow, or durable retry state was
  added.
- **Implemented:** advance the observation checkpoint only in the authoritative update that
  records a completed review. A crash before that point deliberately rereads
  bounded evidence; the audit never advances the cursor.
- **Implemented:** keep pending signals and the one armed timer in memory while
  checkpointing concrete wait deadlines and human-wait decisions.
- **Verified:** resume the same Pi session when possible; a new session can
  continue every unfinished goal from the contract, checkpoint, and fresh facts.
- **Verified:** measure the whole system, including Herdr subscription work and model-review
  frequency, rather than only the supervisor process.
- **Verified:** `goal.json` plus `current.json` contains enough semantic and
  exact-session context to continue when the audit is absent or malformed.
- **Verified:** copying only `goal.json` allows a new instance to start a fresh
  execution with its own local ID, worker, session, checkpoint, and audit.
- **Verified:** goal updates atomically replace the latest view and serialize
  concurrent in-process updates for the same goal.
- **Verified:** audit appends do not mutate goal state; accepted goals remain in
  their original stable directory.
- **Verified:** a corrupt audit fails audit reads without preventing goal
  recovery. Invalid authoritative goal state fails closed.
- **Verified live:** two ordinary Codex workers completed distinct goals under
  one Pi supervisor. Their checkpoints, cursors, evidence, journals, and terminal
  results remained separate.
- **Verified live:** Pi stopped while one Codex worker continued. Resuming the
  same Pi session loaded the unfinished goal directly, reconsidered fresh Herdr
  state, retained the exact worker and native session, and accepted the later
  `DURABLE_RESTART_DONE` result.
- **Verified live:** after all goals became terminal, five seconds of observation
  produced no Pi state transition or model turn. A copied `goal.json` started a
  fresh local execution on a different worker without copying checkpoint or audit.
- **Implemented:** normal event handling reads its in-memory active-goal
  projection rather than rescanning completed goal directories. Only startup and
  the read-only CLI perform a full directory scan.
- **Implemented:** settled per-goal write chains leave memory, and a failed
  authoritative write reloads the disposable projection from disk before the
  next review.
- **Implemented:** once Herdr confirms a worker prompt or session resume, the
  review turn closes before checkpointing. A later checkpoint failure is
  reported as bookkeeping failure and never as permission to repeat the worker
  action. Ambiguous prompt transport failures also fail closed until fresh
  worker evidence arrives.
- **Implemented:** background event and deadline failures are shown without
  crashing the event pump; a failed worker review receives one bounded retry
  deadline.
- **Verified live:** a goal asked the human to choose RED or BLUE. Pi was stopped
  while the question was open; the resumed session regenerated the concrete
  question from `current.json`, steered the same worker once with BLUE, and
  accepted its later `CHOSEN_BLUE` evidence.

### Stage 6: conversational goal start

- **Implemented:** a direct human request lets the supervisor form one explicit
  goal and concrete acceptance criteria, decide whether it joins an active
  related worker tab or needs a new unfocused tab, start Codex there, record its
  exact identity, and deliver the goal. No grouping heuristics or group registry
  are involved; the model supplies the exact related worker or the new label.
- **Implemented:** a human refinement replaces the complete portable contract
  of one active goal, journals the change, and informs the exact same worker.
  The operation cannot run inside an event review, create another goal, or
  silently steer a replacement native session.
- **Implemented:** every start requires an explicit absolute worker directory;
  it never inherits the supervisor's current directory. An active goal with the
  exact same objective is mechanically reused instead of creating another
  worker.
- **Implemented:** container startup explicitly enables Codex's approval,
  sandbox, and hook-trust bypass flags. Native Codex protections remain the
  default outside that externally isolated container boundary.
- **Implemented:** the dedicated container links the supervisor into Pi's
  normal extension directory and selects live mode through the environment.
  Herdr may therefore restore the built-in Pi session as plain `pi` without
  losing supervisor tools or requiring a special resume command.
- **Implemented:** the executor refuses to start a worker from inside an
  event-driven review. Reviews still only observe and decide about their exact
  existing worker.
- **Implemented:** uncertain initial prompt delivery leaves one visible,
  supervised worker for later reconciliation and explicitly forbids creating a
  replacement merely because transport confirmation failed.
- **Implemented:** Codex launches with a neutral, file-safe first turn so native
  session creation does not race a separate terminal injection. The goal is
  bound and delivered only after that identity exists. If identity capture
  fails, retrying the same goal reuses the pending pane instead of creating
  another.
- **Implemented:** unattended full-access launches mark the exact selected
  worker directory trusted, avoiding a project-trust gate while leaving other
  paths unchanged.
- **Implemented:** after binding, the executor sets one native Codex `/goal`
  whose objective points to the canonical `goal.json`. Native Goals remain
  enabled on new and restored sessions. Contract refinements update the same
  file and notify the same worker instead of creating or synchronizing a second
  durable goal record.
- **Implemented:** the restart-stable worker name is derived from a 108-bit
  hash of the complete goal ID and shortened to Herdr's 32-character
  agent-name limit. Names remain practical to correlate without treating a
  normalized or truncated goal prefix as ownership.
- **Verified:** the isolated extension test creates one Herdr pane, starts one
  Codex worker with native Goals enabled, persists one goal contract and
  checkpoint, sends `/goal` only after the binding exists, and keeps human
  focus on the supervisor pane.
- **Verified:** an isolated refinement test adds exact-commit ADO and focused-PR
  requirements to one running goal, preserves its worker identity and active
  goal count, updates `goal.json`, appends `goal_refined` audit history, and
  sends the complete revised contract to that same worker.
- **Verified live:** the deployed supervisor created a disposable read-only
  goal without manual pane setup or `/supervise`. Herdr automatically reported
  an exact native session identity; the worker reported the expected runtime
  version, made no workspace changes, and the supervisor observed and accepted
  the evidence.

## 17. Acceptance criteria

The PoC is successful when all of these are demonstrated:

1. Two workers with different goals can run concurrently under one supervisor.
2. Working output does not cause repeated model calls.
3. A blocked or settled worker wakes the supervisor promptly.
4. An incomplete completion claim causes useful steering of the same worker.
5. A genuine human decision is presented plainly and only once.
6. A stale worker is reviewed and either left alone with reason, steered, or
   escalated; it is never silently lost.
7. Restarting the supervisor recovers unfinished goals and watches without
   creating another goal or worker.
8. Replacing a pane occupant fails closed instead of steering the wrong agent.
9. Herdr remains the sole source of live worker state.
10. Idle operation performs no continuous scan or terminal-log read. The only
    cross-goal LLM call is a low-frequency compact health review. It reports
    cross-goal findings once and routes only explicit reconsideration through
    ordinary focused reviews.
11. Sequential reviews of two different workers remain correctly scoped while
    useful shared supervisor history remains available.
12. A live steer ends its review turn; acceptance happens only in a later turn
    triggered by fresh Herdr state.
13. Continuing a stopped supported process refreshes an empty restored pane's
    transient terminal when needed, then resumes its exact native session and
    paused Goal without an interactive prompt; a missing pane may be relocated
    only for the exact saved session; changed native identity fails closed.
14. Every automatic review ends in one explicit decision; prose alone cannot
    advance a checkpoint or hide an incomplete review.
15. Restart recovery loads every unfinished goal directly and reconsiders it from current
    Herdr state and bounded recent evidence without reconstructing the interrupted
    turn.
16. A human question is suppressed while the process remains alive and safely
    regenerated after restart when the decision is still needed.
17. `goal.json` plus `current.json` is sufficient to continue locally without
    journal replay, and copying `goal.json` alone is sufficient to start fresh
    elsewhere; the journal contains audit records, not runtime authority, raw
    events, copied status, or transport diagnostics.
18. Five healthy workers do not create an unreasonable rate of Herdr reads or
    model reviews.
19. A human can state one durable outcome in the supervisor conversation and
    receive a started, supervised Codex worker without manually creating a pane,
    launching an agent, or supplying a Herdr ID.

## 18. Questions the PoC must answer

- Are Herdr's bounded pane reads sufficient across Codex, Claude Code, Pi, and
  OpenCode, or is Shepherd's structured history materially better?
- Which Herdr transitions are reliable enough across all worker CLIs?
- Are ordinary native assistant messages sufficient evidence across worker
  agents, or does one agent need a richer mechanical adapter?
- What stale interval catches real stalls without nagging healthy workers?
- Can one persistent Pi supervisor switch cleanly among five workers without
  confusing their evidence, and does normal session compaction keep the history
  manageable?
- Does a later stage prove Bellwether's crash probe or watch lifecycle is worth
  adding instead of retaining the direct Herdr subscription?

## 19. Stage 1 findings

- The installed runtime is Herdr 0.8.0 using protocol 19. Its direct socket API
  already provides every Stage 1 capability and the later bounded prompt path.
- Lifecycle subscription messages do not carry `state_change_seq`. The
  extension therefore treats an event only as a wakeup and immediately reads a
  fresh snapshot for the authoritative sequence, status, and identity.
- Pi Bellwether is not installed locally. Making it mandatory would add setup
  and another compatibility boundary without improving this slice.
- The standalone CLI is read-only. The Pi extension is the only active writer.
  A direct human turn may let the supervisor create and bind one worker; manual
  `/supervise` and `/unsupervise` remain available for exact operator control.
  A copied contract is started with `/supervise <pane> --goal-id <id>`; no
  cross-process mutation notification or lock service is needed.
- Stage 2a deliberately began without a stale timer so native observation,
  event wakeups, and dry-run decisions could be validated independently. Stage
  2b then added one nearest-deadline timer without adding a queue or scan loop.
- A live passive smoke test bound an idle Codex pane, loaded the Pi extension,
  emitted one review notice, and left the worker on the same Herdr state and
  `state_change_seq`. This confirms the observe path does not prompt the worker.
- Requiring a worker to call `herdr-supervisor update` would leak infrastructure
  into goal execution. Stage 2 instead introduces a supervisor-side observation
  adapter. Codex reads its canonical goal file but never calls Supervisor APIs.
- A controlled Stage 2a run exposed an important boundary failure: a normal Pi
  session could inspect the worker's repository with built-in coding tools.
  The dedicated supervisor now activates only its identity-fenced supervisor
  tools. Launching with `--no-builtin-tools` provides the same boundary before
  extension initialization.
- The repeated dry-run then used only supervisor observation, status, and
  proposed-steering tools. It made no workspace call and did not mutate the
  worker. The run also showed that an event review must not register work: it
  tried to restate the existing binding before observing it. The start tool is
  therefore available for direct human turns but mechanically rejected while a
  worker review is active.
- The first short-deadline smoke test found that a deadline could expire while
  its prior model turn was still running, repeatedly queueing review messages.
  One in-flight fence per worker now coalesces intervening signals, and the next
  deadline is measured from the settled review. A clean rerun produced one
  wakeup and one bounded observation, then returned to sleep.
- The first two-worker shared-session trial showed that a separate model session
  per worker is not presently justified. One Pi conversation handled Alpha and
  Beta sequentially, retained the useful overall history, selected the correct
  pane-specific tools, and did not use Alpha evidence to complete Beta. The
  extension now admits only one semantic review turn at a time and coalesces the
  other workers' signals until that turn settles.
- The first live steering trial exposed model-side polling: after steering, the
  supervisor repeatedly observed the worker within the same turn. Prompt wording
  alone was insufficient. A small in-memory review fence now enforces the natural
  event boundary without adding a queue or scheduler.
- The repeated live trial used one disposable Codex worker with an intentionally
  incomplete result. Its transcript contains two distinct Herdr-triggered model
  turns: `observe -> steer`, then, after the worker returned idle,
  `observe -> finish`. Each turn read the exact worker once, and the accepted
  evidence was the literal byte output `38 34 0a`.
- The first human-decision trial reached the goal, but the model unnecessarily
  told an already-waiting worker to keep waiting before it asked the human. The
  extension had described `ask_human` as a decision without providing that
  operation, so the model used the nearest available action, `steer`.
- Adding one matching `supervisor_ask_human` operation removed that ambiguity.
  The clean rerun followed `observe -> ask human`, plain human answer,
  `steer`, then a later `observe -> finish`. The worker was untouched while the
  question was open, and no human-priority queue or second session was needed.
- Reusing that Codex session for another goal exposed old assistant messages on
  the first observation. The supervisor rejected the unrelated evidence but
  spent an unnecessary correction turn. New bindings now expose only the latest
  assistant message, then advance normally from a cursor; this is a context
  collection rule rather than a semantic heuristic.
- A restart trial stopped Pi immediately after one steer while the Codex worker
  continued for roughly a minute. Herdr advanced from state sequence 372 to 374
  while Pi was absent. The resumed session read the saved cursor, observed only
  the new progress and final response, and accepted with no duplicate steer.
- A same-pane replacement trial changed only the native Codex session identity.
  Identity fencing correctly prevented all observation and prompting of the
  replacement. It also exposed a small authority dead end: the verified mismatch
  had not satisfied the review fence, so even asking the human was rejected.
  Treating that mechanical mismatch as the complete safe observation for the
  turn fixed the dead end without weakening the prompt fence.
- Two ineffective-steering trials did not justify a retry subsystem. In the
  first, a clearer second instruction resolved a contradictory worker constraint.
  In the hard-refusal case, the shared Pi history recognized three ineffective
  attempts and asked whether to replace or reset the worker. The PoC therefore
  keeps semantic retry judgment in the model and enforces only the
  one-action-per-event boundary in code.

These questions are evidence goals for the PoC, not reasons to add mechanisms
before testing.
