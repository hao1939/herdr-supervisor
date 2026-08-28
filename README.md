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
   steers the same worker, asks the human, recovers the worker, or accepts the
   result.

The proof of concept uses one Pi session as the supervisor and talks directly
to Herdr's local socket. Workers remain ordinary Herdr agents and may use Codex,
Claude Code, Pi, OpenCode, or another supported CLI.

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

Stage 1 is implemented. It can bind goals to existing workers, show their live
state, fence worker identity, and observe lifecycle transitions without model
calls or worker mutation.

Stage 2a uses the worker's ordinary native agent messages as review evidence.
The worker does not know about Herdr or the supervisor. A small observation
adapter resolves the exact native session supplied by Herdr and returns only
new assistant messages; terminal output is a bounded fallback, not the normal
contract. The Pi session exposes only supervisor tools, so it cannot become a
second worker by reading or modifying the worker's workspace.

Stage 2b adds one nearest-deadline timer across all bindings. It is a recovery
safety net, not a polling loop: only due workers wake, and signals received
during a review coalesce until that review settles.

Stage 2c keeps the model side equally simple: one persistent Pi supervisor
session receives one explicitly scoped worker-review request at a time. Workers
still run concurrently. Signals for other workers coalesce in memory until the
current review settles; no separate model session, context store, or durable
review queue is introduced unless testing proves it necessary.

A live three-worker trial confirmed that this shared session kept Alpha, Beta,
and Gamma evidence separate, reviewed every worker, and removed all three goal
bindings after acceptance. Worker messages are evidence, not supervisor
instructions; the supervisor keeps its own voice when reporting a decision.

Stage 3 has now been exercised in live mode. Each Herdr signal starts one
bounded review turn: observe the exact worker once, then leave it alone or apply
one decision. Steering ends the turn. A later worker event starts a fresh turn,
so the supervisor cannot poll while waiting for the worker. A controlled run
verified `observe -> steer`, followed by a later `observe -> finish` with exact
result evidence.

The same session also supports a genuine human decision without another task or
queue: one review can observe and ask a concrete question while leaving the
worker untouched; the human's reply steers that worker once, and its next Herdr
event resumes normal review.

Restart and failure-edge trials are also passing. If Pi stops while a steered
worker runs, resuming the same Pi session reloads the binding checkpoint,
observes only new evidence, and accepts without repeating the steer. A replaced
pane occupant fails closed, and repeated ineffective steering causes the
supervisor to ask the human instead of looping forever.

The recovery path has also been verified end to end. When an exact Codex
process stopped but its original Herdr pane remained, the supervisor resumed
that native Codex session, sent one continuation, observed its new result, and
accepted the goal. A missing pane or changed identity still fails closed. Herdr
does not emit an event when a newly started agent becomes interactive, so this
explicit recovery operation uses Herdr's bounded readiness handshake; normal
supervision remains event-driven and performs no readiness polling.

Stage 5 removes the old shared binding file. The live extension now loads one
directory per goal once at startup, keeps active projections and scheduling hints
only in memory, and records every
completed `leave`, `steer`, `ask_human`, `recover`, `accept`, or explicit stop in
the local checkpoint and audit. A live two-worker trial accepted independent
Alpha and Beta results, and a restart trial resumed the same Pi conversation,
same goal, same worker, and same Codex session without replaying its journal.
With no active goal, the supervisor remained idle with no state transition or
model turn during the observation window. A separate trial restarted while a
human choice was pending, regenerated the concrete question, delivered the
answer to the same worker once, and accepted its resulting evidence.

The supervisor can now accept a goal conversationally as well: it forms
completion criteria, keeps its own tab focused, chooses whether the goal joins
an active related-work tab or starts a new unfocused tab, starts Codex there,
records the exact binding, and sends the goal. Multiple related workers may
share one tab. Manual pane creation and `/supervise` are retained only as
explicit operator controls.

## Try it

Start Pi in a Herdr pane from a stable supervisor directory, separate from any
worker project:

```sh
supervisor_extension=/path/to/herdr-supervisor/extension.ts
cd "${HERDR_SUPERVISOR_DIRECTORY:-/app}"
pi --no-builtin-tools -e "$supervisor_extension" --supervisor-mode live
```

Then describe the outcome normally. The supervisor forms explicit completion
criteria, chooses a related worker tab or creates a new unfocused one, starts
Codex there, gives it the goal, and supervises it. It asks a focused question
first only when the missing answer would materially change the work. Use
`/supervised` to inspect active goals.

For exact operator control, `/supervise <pane> <goal>` still attaches an
existing worker, and `/supervise <pane> --goal-id <id>` starts a copied portable
contract on an existing worker. The standalone CLI can list workers with
`node bin/herdr-supervisor.js workers`.

After passive behavior is verified, use `--supervisor-mode dry-run` to let the
supervisor model review events without applying its decisions. The extension
also disables non-supervisor tools itself; `--no-builtin-tools` makes that
boundary explicit at launch. `live` is the only mode that may prompt a
registered worker.

The standalone CLI is read-only:

```sh
node bin/herdr-supervisor.js status
```

## Run in a container

The container keeps Herdr, its workers, and the supervisor in one runtime so
they can share Herdr's local socket and observe the same processes. Goal state
and agent sessions live in the `herdr-home` volume; the working directory is a
separate `herdr-workspace` volume by default.

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
and groups related Codex workers in other tabs as goals are accepted. Container
launches pass Codex `--dangerously-bypass-approvals-and-sandbox` and
`--dangerously-bypass-hook-trust`, because the container is the security
boundary. Set `HERDR_SUPERVISOR_CODEX_FULL_ACCESS=0` before starting Compose to
restore Codex prompts and sandboxing. Detaching from the container's Herdr
client does not stop the server, supervisor, or workers. Reattach with
`docker compose exec herdr herdr`. API keys present in the shell that starts
Compose are passed into the container; mounting an existing agent home is an
optional operator choice and is intentionally not part of the default setup.

> **Security:** full-access mode lets Codex modify every writable path visible
> in the container, including a bind-mounted host workspace. Mount only the
> workspace you intend agents to change, do not expose the Herdr socket, and
> use `HERDR_SUPERVISOR_CODEX_FULL_ACCESS=0` when the container is not an
> adequate trust boundary. Keep API keys in the local environment or another
> secret store; never commit them to this repository.

Herdr 0.8.x does not expose a web UI or HTTP server. Its supported remote
interface is the terminal UI over SSH (`herdr --remote <ssh-host>`), while its
automation API is newline-delimited JSON over a local Unix socket. A browser
front end therefore requires a separate bridge such as Herdr Remote; it should
not be built into this supervisor. For this container, `docker compose exec`
is the smallest control path. If remote access is needed, expose SSH at the
host or cluster boundary and keep the Herdr socket private.

## Documents

- [Research landscape](docs/research.md)
- [Proof-of-concept design](docs/poc-design.md)

## Design rule

Herdr owns runtime truth. The supervisor owns judgment about whether a
registered worker is still moving toward its stated goal. It must not copy
Herdr's lifecycle into a parallel queue, task graph, or status database.
