# Shared external event watcher

**Status:** Live PoC design
**Reviewed:** 2026-08-31

This is a candidate replacement for the supervisor's current in-process
external polling. It is not the current production design and this PoC does
not run both paths together.

## Decision

Use one small `event-watchd` process to observe external resources for every
worker in one Herdr environment. A worker registers the next revision it cares
about and immediately returns to useful work. When the revision changes, the
daemon sends a wake hint directly to that exact worker. The supervisor is
involved only when observation, credentials, worker identity, or delivery fail.

The watcher is a reusable local service. Herdr is one delivery adapter, not the
watcher's identity or workflow model.

```text
worker -> event-watch CLI -> event-watchd -> GitHub or ADO
   ^                             |
   |                             | next revision
   +------ Herdr delivery -------+

source or delivery failure -> supervisor diagnostic destination
```

This is an optimization for external waits. It does not replace Herdr worker
events, supervisor reviews, Codex's native Goal, or good goal design.

## What problem it solves

This is a good way to release a worker from one narrow kind of blocking wait:
an external PR or build whose state can change without any local activity. It
is not a way to make every idle worker productive.

The worker should first continue any safe independent work. Only when the
external condition is the remaining useful trigger does it register a watch
and settle. The watcher then removes repeated provider polling and model turns;
it does not decide whether the external result is good, complete the Goal, or
invent more work.

For the current private MLVM deployment, a shared local daemon is the smallest
complete path from external change to exact worker wake. At larger scale, the
more mature observation transport is GitHub webhooks or Azure DevOps service
hooks. Those can replace a polling source adapter later while retaining the
same one-shot watch and exact-destination contract. A workflow engine or
message broker is not justified by the current problem.

## User scenarios

### A pull request or build is pending

1. The worker creates or finds the exact PR or build.
2. It runs `event-watch watch ...`.
3. Registration reads the source once and returns only after saving that
   baseline and the worker's exact native session identity.
4. The worker continues independent work. It does not run a polling command or
   wait for the watcher.
5. If that external condition eventually becomes the only remaining path, the
   worker lets its native Goal reach its ordinary blocked state instead of
   repeating status or polling.
6. Unchanged polls do nothing and use no model turn.
7. The next changed revision is saved, then delivered directly to the same
   native worker session through Herdr.
8. Delivery resumes the native Goal before adding the wake hint when the worker
   is settled. The worker rereads GitHub or ADO directly, or uses
   `event-watch read` to make a fresh authenticated read through the same source
   adapter. It decides what the change means and either continues or registers
   another one-shot watch.

The notification is only a hint. Its payload can help explain why the worker
woke, but it never proves that a check passed, a review was resolved, or the
goal finished.

Codex Goals are the continuation owner. Official documentation describes them
as persistent thread objectives that may stop on success, pause, budget, or a
real blocker and can later resume:
<https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex>.
The watcher does not reproduce that lifecycle. Registering a one-shot watch
authorizes one automatic resume for that exact external change. A human who
intentionally pauses the work should cancel the watch too.

### The worker is busy when the change arrives

Herdr submits the wake to the exact live agent. Herdr owns whether that input is
steered into a running turn or starts the next turn. The watcher neither reads
terminal output nor waits for the worker to finish.

### Something goes wrong

The daemon retains the latest undelivered revision and emits one coalesced
diagnostic for the failure identity. A small Pi extension registers the
supervisor's exact native session as the diagnostic destination and displays
watcher health. The supervisor diagnoses the problem through its ordinary
tools; it is not on the successful delivery path.

The goal's bounded review remains the safety net. A dead watcher may delay a
wake, but it cannot make the goal disappear.

## Why this shape

| Option | Strength | Why it is not the first MLVM implementation |
| --- | --- | --- |
| GitHub webhooks and ADO service hooks | Mature, low-latency, no polling | Need reachable ingress, provider setup, signature validation, and replay handling. Add later as source adapters. |
| `gh ... --watch`, Azure CLI loops, or worker shell polling | Already available | Block one worker/process per wait, duplicate reads, and recover poorly. Keep as a fallback. |
| Codex hooks or `notify` | Good outward lifecycle integration | They report Codex activity; they do not observe a later PR/build change and resume an exact idle thread. |
| MCP tools or resource subscriptions | Useful standard tool surface | They do not currently give this deployment a proven background change-to-exact-Codex-turn delivery path. The watcher can expose MCP later without changing its core. |
| Polling inside the Pi supervisor extension | One fewer process | Ties observation to one interactive model session, duplicates work with multiple Pi sessions, and puts successful events through the supervisor. |
| Temporal, NATS, Redis Streams, or another workflow/broker | Rich durable orchestration | Adds a second workflow system and much more state than one-shot wake hints require. |
| Shared local daemon | Shared reads, no model cost while unchanged, direct targeted wake | One small process and a tiny local protocol. Best fit for the current private container. |

OpenAI's Codex configuration documentation says `notify` currently receives
`agent-turn-complete` events and describes hooks as lifecycle integrations. They
can help instrument or register a watch, but external observation and inward
delivery remain separate concerns:
<https://learn.chatgpt.com/docs/config-file/config-advanced>.

## Small contract

The core has four nouns:

- **source**: an adapter such as `github-pr` or `ado-build`;
- **subject**: the provider's stable resource identity;
- **revision**: a compact identity derived from current authoritative metadata;
- **destination**: an adapter name plus opaque exact target data.

A watch means only:

> Notify this destination once when this source and subject no longer have the
> registered baseline revision.

There are no task states, keywords, predicates, workflow steps, success rules,
or model decisions in the daemon.

## Identity and delivery

The Herdr CLI adapter discovers the calling worker from `HERDR_PANE_ID` and
records its complete native agent-session identity. Pane ID is only a current
routing hint.

Before delivery, the Herdr adapter reads the current session snapshot and finds
the unique agent with that native identity. It rechecks after a Goal resume and
sends the hint to that current pane. A missing or ambiguous identity fails
closed and goes to diagnostics; it never guesses from focus, tab order, agent
kind, or an old pane.

The current Herdr `agent.prompt` API accepts only a pane-like string target. It
does not accept an exact native-session precondition. Therefore a final,
unavoidable race remains between the last snapshot and prompt submission: the
pane could be reused in that gap. Another client-side read cannot remove it.
Production adoption requires one small Herdr primitive: resolve and submit a
prompt atomically by exact `agent_session`, or reject the prompt when that
precondition no longer matches. Keep the current recheck as PoC risk reduction,
not as proof that the race is closed.

If that exact worker is settled, the adapter first submits `/goal resume` and
uses Herdr's atomic wait to confirm that the worker started. Only then does it
submit the wake hint. This ordering prevents two terminal inputs from merging
into one malformed slash command. If the worker is already working, it submits
only the hint. This uses Codex's existing Goal lifecycle instead of adding
watcher-owned worker states.

The daemon persists the newest pending revision before delivery. A successful
Herdr prompt submission counts as delivery and consumes the one-shot watch. If
the process crashes between submission and clearing state, the worker may
receive the same hint twice. That bounded duplicate is cheaper and safer than a
worker acknowledgement protocol because the worker always rereads authority.

Fast revisions coalesce to the latest pending revision. This is safe because
the watcher is not an audit log.

## Process ownership

Do not run polling inside a Pi extension. The provisioned environment owns one
daemon, and its service manager owns singleton process enforcement:

- the container image installs `event-watch` and `event-watchd`;
- the container/service manager starts one daemon with the Herdr environment;
- worker worktrees inherit only the CLI and socket location;
- the supervisor Pi extension registers diagnostics and exposes health;
- credentials stay in the environment and are never written into watch state.

The PoC process lock fails closed when its lock already exists; it does not try
to reclaim a possibly replaced lock. A production service should use an OS
lock, such as `flock`, or a service manager that serializes startup and removes
only its own stale runtime files. Singleton recovery does not belong in the
watch protocol.

The daemon also exposes a fresh `read` operation over its existing source
adapters. This lets a woken worker verify authority without copying provider
credentials into every worker process. `read` never returns the cached event;
it calls the source adapter again. Provider write actions and repository-local
commands remain worker-owned and are not executed by the daemon.

The worktree provisioner may ensure that the CLI is available in a new worker
environment, but it is a one-shot worktree hook and must not become the owner of
a long-running service.

In the Herdr image, natural integration therefore means:

1. the image installs the generic client and daemon;
2. the container entrypoint or service manager starts one daemon;
3. the provisioner gives every worker the socket location and short usage
   guidance;
4. a thin Pi extension registers the supervisor diagnostic destination and
   may display health.

Pi is neither the polling host nor a required hop for successful events.

## Minimal persisted state

One atomically replaced local JSON snapshot is sufficient for the PoC:

- each exact source/subject and its baseline or latest observed revision;
- one or more one-shot destinations sharing that subject read;
- the latest pending revision for each destination;
- one diagnostic destination and visible source or delivery errors.

Polling schedules, live sockets, and retry timers are disposable. On restart,
the daemon reloads watches, immediately rereads each subject, and retries
pending delivery. Credentials and Herdr runtime state are always reread from
their owners.

## First implementation boundary

Implement only:

1. a generic in-memory/persisted one-shot watch core;
2. a bounded newline-JSON Unix-socket API;
3. one GitHub PR source adapter;
4. one exact-session Herdr delivery adapter;
5. a CLI that registers the calling Herdr worker and can reread a source;
6. health/list/unwatch operations;
7. focused tests and one MLVM end-to-end experiment.

The GitHub PoC applies a coarse adapter budget: authenticated observation is at
least one minute apart with at most ten distinct PR subjects; anonymous
observation is at least five minutes apart and limited to one subject. Multiple
destinations for one PR still share a read, and provider retry/reset guidance
postpones the next source read. This avoids pretending that each watch owns the
provider quota. Webhooks remain the better transport when lower latency or
larger scale is required.

Defer ADO, webhooks, action wrappers that auto-register created PRs/builds, MCP,
and automatic production rollout until the first path is useful in a real goal.
They should become adapters or thin CLI conveniences, not changes to the core.

Before production replacement, answer only these operational questions:

- Who starts and restarts the one environment daemon?
- How are GitHub and ADO credentials supplied to that process?
- Can Herdr preserve exact native-session delivery while a worker relocates or
  resumes?
- Is a bounded duplicate hint acceptable to every worker? The current answer
  is yes because workers reread authority.
- What is the ordinary cleanup path for a watch whose external subject never
  changes? For the PoC, explicit `unwatch`, the watch limit, and supervisor
  health are enough; do not add leases until live use proves they are needed.

## Live acceptance

The PoC is convincing only when MLVM proves all of the following:

- registration establishes a quiet baseline and returns promptly;
- the worker does other useful work instead of blocking;
- one controlled GitHub PR revision wakes the exact worker directly;
- the worker rereads GitHub authority;
- no supervisor model turn occurs on the successful path;
- two watches on one PR share one source poll;
- daemon restart preserves an undelivered change or safely rediscovers it;
- a wrong native identity sends no worker prompt and surfaces one diagnostic;
- idle CPU is negligible and memory cost is measured.

After that evidence, decide whether the daemon replaces the current in-process
supervisor watch. Do not maintain both production paths.

## MLVM result

The PoC was exercised against draft pull request 42 in the live MLVM Herdr
environment.

What worked:

- registration established a quiet baseline and returned to the worker;
- the worker reviewed the watcher while the daemon alone polled GitHub;
- that review found a real shared-interval scheduling bug, which was fixed and
  covered by a regression test;
- restarting the daemon preserved the registered watch;
- the worker followed Codex's native blocked audit and settled after the same
  external blocker occurred three times;
- a real check-state revision resumed the same native Goal and delivered the
  hint directly to its exact session;
- the one-shot watch disappeared after successful delivery;
- `event-watch read` made a fresh authenticated read and showed the current PR
  head and five successful checks.

The experiment also found two integration failures:

1. Sending `/goal resume` and the hint without waiting allowed terminal input
   to merge into one malformed Goal command. Herdr's atomic prompt wait now
   proves the Goal is working before the hint is sent.
2. Unauthenticated two-second polling exhausted GitHub's public rate limit.
   The watch stayed pending and diagnostics woke the supervisor as designed.
   Restarting the daemon with an ambient credential recovered without changing
   watch state. Production intervals must be much slower and credentials must
   be provisioned for the daemon.

Follow-up review found four more deterministic edges before another live run:

- a second daemon could replace a live socket;
- a resumed session could relocate before the wake hint was delivered;
- a closed daemon connection could leave the worker CLI waiting forever; and
- re-registration, pagination, interval removal, or a crash during persistence
  could lose or delay a wake.

The PoC now has focused coverage for those invariants. Unauthenticated GitHub
watches are also clamped to a five-minute interval.

The hardened revision was then repeated on MLVM in two real Goal states:

- while the worker was active, a newly dispatched E2E check delivered directly
  to the same session, the worker made a fresh authenticated read, and the watch
  was consumed;
- after the worker had reached the native blocked threshold, another E2E
  revision resumed that exact Goal, revalidated the same session, delivered the
  hint, and was consumed.

The first registration attempt also proved an important deployment boundary:
the container did not automatically inherit the host's GitHub credential. The
watch was not created and the error stayed visible. Restarting the environment
daemon with a credential and retrying the same registration succeeded. A real
deployment must pass provider credentials to the daemon through its container
or service configuration; a worker login elsewhere is not enough.

Two adoption gaps remain explicit: Herdr lacks an atomic exact-session prompt,
and the PoC lock deliberately requires service-manager cleanup after an
unclean daemon exit. They are infrastructure contracts, not reasons to add
workflow state to the watcher.

The live daemon used negligible idle CPU. It was about 56 MB RSS before its
first GitHub read and about 70–73 MB afterward. That is reasonable for this
Node-based PoC, but production adoption should retain the daemon only when
shared observation and released worker turns justify that fixed cost.

One unrelated provisioning issue interrupted the first disposable worker:
Codex showed its interactive update prompt, Herdr considered the process ready,
and the first submitted Goal selected “update now.” The container could not
replace its root-owned global package. A centrally versioned image should start
workers with `check_for_update_on_startup=false`; image rebuilds, not workers,
should update Codex.
