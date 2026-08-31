# Proposal: Let Workers Own External Waiting

**Status:** Live proof passed; ready for the bounded removal described below.

**Date:** 2026-08-31.

## Decision in one sentence

Remove GitHub and Azure DevOps polling from the supervisor. The worker decides
which external result matters, reads it, waits when useful, and reacts to it.
Reuse that practice as worker guidance and ordinary commands, not as another
supervisor feature.

The supervisor should supervise outcomes. It should not become the place where
workers register provider-specific background jobs.

## Why reconsider PR 19

PR 19 solved a real delay: GitHub and Azure DevOps do not naturally produce a
Herdr pane event, so a worker that stopped after saying “I am waiting” might not
be reconsidered until the supervisor's next bounded review.

The implementation put polling in the already-running Pi supervisor. That
looked small at first, but it gave the supervisor responsibility for:

- GitHub and Azure DevOps identities and authentication;
- provider API requests, pagination, rate limits, retries, and stable hashing;
- poll timers, single-flight protection, and shared-subject deduplication;
- associating each watched subject with the correct goal and pane;
- preserving a change seen while a review or prompt was in flight;
- proving that the worker reread the changed source after being prompted; and
- acknowledging the exact revision before clearing durable state.

The follow-up fixes were reasonable. They were also evidence that the
responsibility was in the wrong place. Through PR 21, the feature added 315
lines of provider code, 599 added lines in the main extension, and 2,825 added
lines across the repository. Much of that growth protects coordination among
the poller, prompt delivery, goal storage, and review decisions.

None of that helps the supervisor answer its real question: has the worker
produced enough evidence to satisfy the goal?

## What happens without the supervisor watcher

Work is not lost without PR 19.

The worker can already:

1. start a pull request or pipeline;
2. inspect its current state with `gh`, `az`, or another project command;
3. wait or inspect it again;
4. react to the result; and
5. continue its native Codex Goal until the outcome is proved.

If the worker ends its turn instead of waiting, Herdr reports that it settled.
The supervisor can review it normally and later steer the same worker to
recheck current provider state. The bounded goal review remains the safety net.
This baseline needs no new watcher or tool. It may react later and spend one
more model turn, but it does not lose the goal.

The useful optimization is to make step 3 easy and reusable for the worker,
without changing who owns the work.

## Proposed ownership

| Question | Owner |
| --- | --- |
| Which external result blocks the next execution step? | Worker |
| How is that result read and interpreted? | Worker, using provider or project tooling |
| How does the worker wait without spending model turns? | A foreground worker command |
| Is the worker process alive, working, blocked, or settled? | Herdr |
| Is the durable goal complete? | Supervisor |
| What protects against a missed event or abandoned wait? | Existing bounded supervisor review |

Provider credentials stay with the worker that already uses them. The goal
checkpoint does not gain a GitHub or Azure DevOps lifecycle. The existing
plain-language wait may still say what condition blocks progress; that is
useful goal evidence, not a polling registration.

If the worker chooses the wrong PR or an incomplete condition, that is an
ordinary execution mistake. The supervisor can notice weak evidence at its
bounded review and steer the same worker to correct it. Preventing every such
mistake in supervisor code would duplicate worker reasoning and recreate the
coupling this proposal removes.

## Two levels of behavior

Start with the behavior that already works:

```text
worker records the exact external condition and settles
  -> Herdr reports the ordinary worker state
  -> the next event or bounded review wakes the supervisor
  -> the supervisor tells the same worker to recheck and continue
  -> the worker reads current provider truth
```

This is slower, but simple and safe. It should remain the recovery path.

Use a foreground wait as the fast path only after proving that the worker
runtime supports it:

```text
worker starts PR or pipeline
  -> worker finishes all independent work
  -> worker reads the exact external state
  -> worker calls a blocking wait command
  -> no LLM turn runs while the command waits
  -> the command returns when the condition changes or times out
  -> the same worker rereads authoritative state
  -> the worker reacts and continues its native Goal
  -> ordinary Herdr events let the supervisor judge progress
```

The wait is part of the worker's current attempt, like running tests or waiting
for a build command. It is not a registered task, detached daemon, supervisor
goal, or durable subscription. The supervisor does not select the PR or build
on the worker's behalf.

There is still polling somewhere when a provider offers no event stream. The
important simplification is its lifetime and ownership: one worker command
polls one condition for one current attempt, then exits. It does not coordinate
goals, route events, or survive as supervisor state.

## Reuse existing tools first

Use a provider's own blocking command when it expresses the real condition.
For example, GitHub already supports waiting for checks:

```sh
gh pr checks <pr> --watch --interval 30
```

That command covers checks, not every PR change. After it returns, the worker
should reread the pull request, review comments, merge state, and checks before
deciding what the result means.

Azure DevOps does not provide the same convenient blocking command for every
case. A worker can currently use a small bounded loop around:

```sh
az pipelines runs show --id <build-id> --org <organization> --project <project>
```

The first proof should put these tested recipes in worker-facing guidance or a
small skill. The skill tells the worker when to wait, how to choose a stable
read, and when it must reread authority. It does not own a process or any
state.

## Make manual work reusable at the right level

Do not turn the whole workflow into one large tool. Reuse each part at its
natural level:

| Repeated knowledge | Reuse as |
| --- | --- |
| When waiting is appropriate and what must be reread | Worker skill or prompt rule |
| How this repository reads one PR or build correctly | Existing provider CLI or a small project script |
| Repeating a stable read without model turns | A tiny foreground command, only if provider tooling lacks it |
| What the new state means and what to do next | Worker reasoning in the existing Goal |

An ordinary executable is already a worker tool. There is no need to register
an LLM-native tool schema, teach the supervisor its arguments, or create a new
service. If a repository has special PR or pipeline rules, keep the stable read
there so it can also be used by humans and CI.

## Add only a proven missing primitive

If repeated shell loops are the remaining friction, add one small executable
for workers:

```text
wait-for-change --interval <seconds> --timeout <seconds> -- <command> <args...>
```

Its contract is deliberately small:

1. Run the command directly, without a shell. Its first successful output is
   the baseline; an initial command failure is an error.
2. Run it again at the bounded interval.
3. Exit successfully when successful output changes.
4. Print the latest result, but make no claim about what the change means.
5. Exit distinctly on timeout, cancellation, or any later command failure.
6. Keep all state in that foreground process. Write no files and start no
   background process.

The worker chooses a narrow, stable command projection. Examples include a
GitHub JSON view of checks and reviews or an Azure DevOps JSON view of build
status and result. The worker rereads the provider after the helper returns;
the changed output is only a wake hint.

The projection must omit changing observation timestamps and sort unordered
lists. A noisy projection may wake the worker early, which is harmless because
the worker rereads authority. A projection that omits a relevant fact can miss
a wake, so project-specific reads need focused tests.

This executable does not need to be an LLM-native tool. Codex can call it
through its ordinary shell tool. A short worker skill plus a normal executable
is easier to inspect, reuse, and debug. Do not add it until a real trial shows
that provider-native commands and a simple project script are insufficient.

Do not add source names, goal IDs, pane IDs, provider tokens, revision hashes,
or acknowledgement state to this helper. If a provider already has a correct
blocking command, use that instead.

## Worker rule

The native Goal prompt or worker skill should say, in plain language:

> When an external result is the only remaining blocker, finish all independent
> work, identify the exact condition, and wait for it with a foreground command.
> When the command returns, reread the authoritative source and continue. Do
> not end the goal merely because you started a PR, pipeline, or wait.

The worker may still stop and explain a genuine credential, approval, or human
decision boundary. It should not ask the supervisor to poll on its behalf. A
semantic failure reported by a provider command, such as failed checks, is a
result to investigate rather than a reason to keep waiting.

## Supervisor after simplification

The supervisor continues to:

- form and refine the durable goal;
- bind it to one exact Herdr worker and native session;
- react to ordinary Herdr worker events;
- review bounded current evidence;
- steer, ask the human, or accept the goal; and
- run a bounded deadline review when progress may have been missed.

The supervisor no longer knows GitHub PR syntax, Azure DevOps build syntax,
provider credentials, polling intervals, or external revisions.

If a worker settles with “waiting for CI” instead of actually waiting, the next
ordinary review can steer it to recheck current state and continue useful work.
It should use a foreground wait only after that path is proved. No new
supervisor mechanism is required.

## Failure and recovery

| Situation | Expected behavior |
| --- | --- |
| External state is unchanged | The worker command sleeps; no model or supervisor turn runs |
| External state changes | The command returns and the same worker rereads authority |
| Provider read fails | The worker can refresh credentials, retry with backoff, or report the exact boundary |
| Wait times out | The worker reassesses the condition and useful alternatives |
| Supervisor restarts | The worker and its foreground wait continue independently |
| Worker process exits | Its child wait ends; exact-session recovery rereads current provider state and waits again only if still needed |
| Herdr or the host restarts | Recovery starts from the Goal and current provider truth, not a saved poll cursor |
| Two workers wait on one subject | They may perform two bounded reads; share polling only if real measurements later show this is a problem |

The design intentionally accepts an occasional repeated provider read after a
crash. Reconstructing an exact long-running poll is more complex than rereading
current truth.

## Proof before removal

Run a proof of concept in a real Herdr worker, not only unit tests.

[Official OpenAI documentation for Codex `/ps`](https://learn.chatgpt.com/docs/developer-commands#check-background-terminals-with-ps)
describes inspecting background terminals, but does not promise that
completion of a background command wakes a model turn that has already ended.
Do not assume that behavior. The fast path must keep the wait attached to an
active worker tool call, or be rejected.

Use two stages. First, wait on a controlled local command for several minutes,
change its stable output, and verify that the same Codex turn continues. Stop
there if the runtime gate fails. Then exercise real GitHub and Azure DevOps
conditions and the recovery cases below.

The removal gate covers the generic runtime primitive, not every provider
recipe:

1. a controlled wait that changes after several minutes;
2. a real provider transition;
3. a bounded timeout;
4. a full-container restart during the foreground call; and
5. exact-session resume, authoritative reread, and at most one replacement
   wait after that interruption.

Azure DevOps commands, review-comment projections, and credential recovery are
worker and project knowledge. They can be exercised as those workflows need
them, but they do not justify retaining provider ownership in the supervisor.

The most important feasibility gate is this:

> The worker's ordinary command tool can remain waiting for the required period
> without an agent-runtime timeout, Herdr truthfully reports the worker as
> active, and the same worker continues automatically after the command
> returns.

Measure:

- zero supervisor model turns while the external state is unchanged;
- reaction no later than one configured poll interval after the change;
- authoritative reread before action;
- no lost native Goal after timeout, interruption, or supervisor restart; and
- no provider-specific state written by the supervisor.

### Live results

All generic feasibility gates passed in the MLVM container on 2026-08-31:

1. A disposable supervised Codex worker kept one ordinary foreground shell
   call active for 90.073 seconds while checking for an externally created
   directory every five seconds. It detected the change on check 19, returned
   about three seconds after the signal, and continued the same native Goal
   turn automatically. The exact goal, pane, worker, and native session were
   unchanged; no supervisor review or external watch ran while it waited.
2. A second worker read GitHub Actions run `33372309721` at attempt 1, then
   kept one foreground `curl` loop active while an external actor reran that
   exact run. It observed attempt 2 start, waited until it completed
   successfully, continued the same native Goal turn, and performed a fresh
   authoritative provider read. No repository file, detached process,
   supervisor watch, or second worker was involved.
3. A third worker checked a deliberately absent path every five seconds in one
   foreground call. The command returned the expected timeout exit 124 after
   approximately 45 seconds and nine checks. Codex treated the non-success as
   evidence, continued the same native Goal turn, reread the path, and proved
   clean disposal without asking the human or entering a supervisor wait.
4. A fourth worker began a fresh 300-second foreground wait at
   `2026-08-31T09:15:58.044971884Z`. The full Herdr container was recreated at
   `09:17:02Z`, interrupting that process. The exact supervised goal, worker,
   pane, Codex session, and native Goal resumed automatically on the merged
   full-access wrapper without a trust question. The recovered turn reread the
   signal as absent at `09:17:15.306003013Z`, started one replacement wait,
   detected the externally created signal at `09:18:55.841801120Z`, and reread
   it at `09:19:09.689779568Z`. It removed the signal and disposable state and
   proved both paths and all experiment processes absent. No repository was
   accessed or changed.

The first three workers were accepted through ordinary focused review after
their turns settled; the fourth produced complete current-session evidence and
then completed its native Goal. Together, these results prove uninterrupted,
timeout, and full-restart recovery paths without supervisor-owned provider
polling.

If the foreground command cannot survive realistic waits, keep the zero-code
bounded recheck as the default and measure whether its delay and model cost are
a real problem. Only then evaluate a worker-runtime helper that wakes the exact
worker. Such a helper must remain goal-blind and provider-neutral. Do not move
provider polling back into the supervisor merely to optimize reaction time.

## Migration from PR 19

After the proof passes:

1. Stop offering `external_watch` in `supervisor_leave`.
2. Remove provider polling, its timer integration, and `external-watch.ts` from
   the Pi extension.
3. Remove process-local `externalWatch` and durable `externalChange` from new
   goal checkpoints.
4. Keep a narrow compatibility reader for existing checkpoints. Surface an old
   unresolved external change once as review evidence, tell the same worker to
   reread it, and discard the retired field on the next successful checkpoint
   write. Do not restart old polling.
5. Remove external-watch prompt policy, status output, flags, tests, and
   provider credentials from the supervisor package.
6. Install the worker guidance and, only if the proof needs it, the small
   `wait-for-change` executable in local and container worker environments.

Make this one bounded migration. Do not retain both supervisor polling and
worker waiting as permanent alternatives.

## What this proposal does not change

- The supervisor still judges whether the whole goal is complete.
- Herdr still owns pane, process, and agent-session truth.
- Codex's native Goal still owns the worker's continue-until-done loop.
- Worker final output remains evidence, not automatic acceptance.
- The bounded supervisor review remains the safety net.
- Peer-worker waits still use Herdr events because those events already exist.

## Alternatives rejected for now

### Keep the PR 19 design

It works, but it makes provider execution state part of goal supervision and
has already required substantial race, durability, and acknowledgement logic.

### Add a generic background watcher daemon

This moves the same ownership problem into another process and introduces
registration, storage, recovery, routing, and cleanup again.

### Put provider watchers into Herdr core

Herdr should expose pane and agent facts, not understand GitHub or Azure
DevOps. A provider-neutral worker wake integration may be considered only if a
foreground wait proves inadequate.

### Make model-driven rechecks the fast path

The existing bounded review is a good recovery path. Using frequent supervisor
and worker turns as the normal polling loop would spend model turns on unchanged
mechanical state. Keep it bounded unless measurements justify a worker-local
optimization.

## Recommendation

Remove the PR 19 watcher in one compatibility-safe change. Keep one plain
worker rule and existing `gh`, `az`, or project commands. Capture a provider
recipe in worker knowledge only when it is worth reusing. Add no generic
`wait-for-change` executable until repeated live evidence proves ordinary
foreground commands inadequate.

This gives the simplest stable boundary:

```text
worker executes and waits
Herdr reports worker state
supervisor judges the goal
```
