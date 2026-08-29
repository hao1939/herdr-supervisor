# Herdr Supervisor

Herdr Supervisor is an experiment in letting one agent supervise existing
Herdr workers without replacing Herdr or introducing another task system.

The intended behavior is simple:

1. A human describes an outcome to the supervisor.
2. The supervisor clarifies only what matters, forms the goal and acceptance
   criteria, and starts one worker for it.
3. Herdr owns the worker pane, process, live state, and events.
4. The supervisor sleeps while the worker is making progress.
5. A meaningful worker event wakes the supervisor.
6. The supervisor reads current evidence and either leaves the worker alone,
   continues the same worker, asks the human, or accepts the result. Continuing
   automatically resumes the exact session when its process has exited.

The supervisor and its workers prefer plain language for progress and results:
they retain exact technical evidence, but explain what happened, why it matters,
and what comes next.

The proof of concept uses one Pi session as the supervisor and talks directly
to Herdr's local socket. Workers are ordinary Herdr agents. This implementation
starts, observes, and recovers **Codex** workers specifically: worker startup,
message-level evidence, and exact-session recovery are all Codex-aware today.
Other Herdr-supported CLIs are a planned extension, not a current capability.

The next refinement gives every goal one stable directory with three small,
separate files. `goal.json` is the portable goal contract, `current.json` is the
local execution checkpoint, and `journal.jsonl` is optional audit history. On
failure, the supervisor resumes the same Pi and worker sessions when possible,
loads the contract and checkpoint directly, rereads fresh Herdr state and
bounded worker evidence, and continues. It never rebuilds a goal by replaying
history. Copying only `goal.json` is enough to start that goal with a new worker
in another instance. The storage model is integrated into the live supervisor
and has passed concurrent-worker, restart, portability, and idle smoke trials.

## Current status

The supervisor can bind goals to Codex workers, observe their progress through
native session messages, make bounded review decisions (leave, steer, ask_human,
recover, accept, stop), and survive Pi and worker restarts by reloading durable
goal checkpoints. Goals are created conversationally or via `/supervise`.
A low-frequency global review catches failures visible only across goals.

See [CHANGELOG.md](CHANGELOG.md) for the full development history.

## Try it

Start Pi in a Herdr pane from a stable supervisor directory, separate from any
worker project:

```sh
supervisor_extension=/path/to/herdr-supervisor/src/extension.ts
cd "${HERDR_SUPERVISOR_DIRECTORY:-/app}"
pi --no-builtin-tools -e "$supervisor_extension" --supervisor-mode live
```

Then describe the outcome normally. The supervisor forms explicit completion
criteria, chooses a related worker tab or creates a new unfocused one, starts
Codex there, gives it the goal, and supervises it. It asks a focused question
first only when the missing answer would materially change the work. Use
`/supervised` to inspect active goals.

This is also how new work is created: the supervisor first reuses an active goal
with the same outcome; otherwise it creates one new goal and worker. There is no
second task system. The worker starts at the selected project root and owns any
Git worktree layout the outcome requires, including using several worktrees for
one goal. The starting checkout and worktrees owned by other goals are read-only
discovery sources. A worker creates another goal-owned worktree for baseline
tests or generators rather than risking writes in somebody else's worktree.
Likewise, a missing command or default credential helper is not automatically a
human blocker. The worker first exhausts safe environment capabilities and
separates missing convenience tooling from genuinely missing authority or
information. A reported access blocker names the exact failed operation, where
it ran, the effective identity or authority, the target service, and the
observed error. A login or permission in another host, container, identity, or
service is not treated as evidence that the blocked boundary is authorized.

The human may refine an active goal in ordinary conversation. The supervisor
replaces that same goal's complete portable contract, records the change in its
journal, and informs the same worker; it does not create a sibling goal or rely
on temporary steering. Project-specific requirements remain explicit contract
content. For example, a code-changing AKS goal can require an isolated branch
and worktree, one focused clean PR with overlaps reconciled, and an appropriate
ADO pipeline pass tied to the exact proposed commit before acceptance.

A new execution fact is different from a goal refinement. A login, throttle,
peer update, resolved wait, or request to recheck current work does not rewrite
portable goal files. The supervisor selects the affected existing goals once;
the runtime queues one ordinary focused review for each after the human turn.
Each review still observes one worker and makes one decision, so several goals
can react without one oversized cross-worker turn or accidental contract churn.
Human input that arrives during a focused worker review is retained for the
other affected goals and drained afterward; it is not rejected or reduced to a
text-only acknowledgement.

Accepting a goal delegates authority for its normal reversible in-scope steps.
The supervisor does not ask again before a step required by the accepted
outcome, unless the human explicitly reserved that decision, forbade the
action, or the step materially expands the outcome or risk.

Independent workers and pipeline runs proceed concurrently by default. The
supervisor does not invent a shared-capacity reservation or make one worker a
gatekeeper for another. It coordinates or serializes work only when current
evidence shows an actual throttle, quota, service limit, resource collision, or
exact conflicting operation.

For exact operator control, `/supervise <pane> <goal>` still attaches an
existing worker, and `/supervise <pane> --goal-id <id>` starts a copied portable
contract on an existing worker.

After passive behavior is verified, use `--supervisor-mode dry-run` to let the
supervisor model review events without applying its decisions. The extension
also disables non-supervisor tools itself; `--no-builtin-tools` makes that
boundary explicit at launch. `live` is the only mode that may prompt a
registered worker. Use `/supervised` inside the supervisor pane to inspect
active goals and worker state.

## Run in a container

The container keeps Herdr, its workers, and the supervisor in one runtime so
they can share Herdr's local socket and observe the same processes. Goal state
and agent sessions live in the `herdr-home` volume; the working directory is a
separate `herdr-workspace` volume by default.

Supervised Codex workers use the Herdr goal contract as their only durable goal
authority. The container disables Codex's separate native goal feature so an
exact session restored after a container restart cannot stop at a second
"resume goal" confirmation. This does not disable session reuse: Herdr still
restores the exact native Codex session recorded by the goal checkpoint.
The restored worker opens idle and lets the supervisor decide whether another
turn is useful. A restored Codex worker also reuses the session's saved
directory, avoiding an interactive choice when it entered a goal-owned
worktree before the restart.
If the supervisor was waiting for a human decision, that wait is restored from
the goal checkpoint; worker events and restarts do not repeat the question.
Compose restarts the service after an unexpected process or Docker-daemon
failure, while an explicit operator stop remains stopped.

```sh
docker compose up -d --build
docker compose exec herdr herdr
```

To work on an existing host `/app` directory, replace the workspace volume
with that bind mount. The path remains `/app` inside the container:

```sh
HERDR_WORKSPACE=/app docker compose up -d --build
```

In the Herdr UI, open one pane for the supervisor and run:

```sh
pi
```

The dedicated container installs the extension into Pi's normal extension
directory on every start, starts plain `pi` in
`HERDR_SUPERVISOR_DIRECTORY` (`/app` by default), and selects live mode through
the environment. A worker's project directory is always an explicit absolute
path chosen for that goal; it is never inherited from the supervisor. This
image also includes the small runtime required by Herdr's managed Codex session
hook. Worker startup uses one file-safe no-op turn to initialize Codex, captures
the resulting native identity, and saves the goal binding before delivering the
goal. A failed integration therefore cannot leave assigned work running outside
supervision, and retrying the same goal reuses the pending pane. This also
survives Herdr restoring the Pi session
as plain `pi`; no special resume
command is required. Talk to that Pi session normally. It keeps the supervisor in its current tab
and groups related Codex workers in other tabs as goals are accepted. Codex runs
sandboxed with its normal approval prompts by default. Set
`HERDR_SUPERVISOR_CODEX_FULL_ACCESS=1` before starting Compose to pass
`--dangerously-bypass-approvals-and-sandbox` and `--dangerously-bypass-hook-trust`,
which lets workers run unattended when you have decided the container is an
adequate security boundary. Detaching from the container's Herdr
client does not stop the server, supervisor, or workers. Reattach with
`docker compose exec herdr herdr`. API keys present in the shell that starts
Compose are passed into the container; mounting an existing agent home is an
optional operator choice and is intentionally not part of the default setup.

> **Security:** full-access mode lets Codex modify every writable path visible
> in the container, including a bind-mounted host workspace. It is opt-in for
> that reason. Before setting `HERDR_SUPERVISOR_CODEX_FULL_ACCESS=1`, mount only
> the workspace you intend agents to change and do not expose the Herdr socket.
> Keep API keys in the local environment or another
> secret store; never commit them to this repository.

Herdr 0.8.x does not expose a web UI or HTTP server. Its supported remote
interface is the terminal UI over SSH (`herdr --remote <ssh-host>`), while its
automation API is newline-delimited JSON over a local Unix socket. A browser
front end therefore requires a separate bridge such as Herdr Remote; it should
not be built into this supervisor. For this container, `docker compose exec`
is the smallest control path. If remote access is needed, expose SSH at the
host or cluster boundary and keep the Herdr socket private.

## Documents

- [Changelog](CHANGELOG.md)
- [Research landscape](docs/research.md)
- [Proof-of-concept design](docs/poc-design.md)

## Design rule

Herdr owns runtime truth. The supervisor owns judgment about whether a
registered worker is still moving toward its stated goal. It must not copy
Herdr's lifecycle into a parallel queue, task graph, or status database.
