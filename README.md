# Herdr Supervisor

One supervisor helps several workers finish explicit goals without introducing
another task system.

1. You define or refine an outcome.
2. One worker owns that goal and keeps pursuing it.
3. The supervisor watches progress and helps the same worker when needed.
4. An optional external watcher wakes the worker when a pull request or build
   changes or stays unchanged too long.

The model decides what current evidence means. Small deterministic code records
goals, observes events, validates identity, and applies the chosen action.
Herdr hosts the sessions and events; it is runtime plumbing for this model.

The extension contract is **event for fact, knowledge for action**. Adapters
add bounded observations and reliable wakes. Plain-language, version-controlled
guidance teaches the responsible agent how to assess those facts and what useful
result to produce. Events never become instructions, and guidance never becomes
an executable workflow.

The supervisor brings those pieces together for its portfolio: it ensures the
shared observer is configured, the fixed recipient has the needed guidance,
and one end-to-end change is proven. It does not sit between the watcher and a
worker afterward, and setup is shared rather than repeated for every goal.

## Quick start (container)

The recommended way to run the supervisor. The container bundles Herdr, Pi, and
Codex in one runtime — no local installation needed.

**Pull the image:**

```sh
docker pull ghcr.io/hao1939/herdr-supervisor:latest
```

**Or build from source:**

```sh
git clone https://github.com/hao1939/herdr-supervisor.git
cd herdr-supervisor
docker compose up -d --build
```

**Connect and start supervising:**

```sh
docker compose exec herdr herdr
```

In the Herdr UI, open the one dedicated supervisor pane and start Pi with an
explicit mode:

```sh
pi --supervisor-mode live
```

The extension is available to other Pi sessions in the container but remains
inert unless they also select a mode. Talk to the supervisor — describe what
you want done and it handles the rest.

After starting or restarting that agent, name it so external diagnostics and
optional management panes can address it without relying on a recyclable pane
ID. Herdr clears the name when the agent exits or is replaced:

```sh
herdr agent rename <pi-pane-id> supervisor
```

For a larger portfolio, you may open a separate Codex pane for longer goal
discussion and name it `goal-manager` after each start or restart:

```sh
herdr agent rename <codex-pane-id> goal-manager
```

The image supplies the `herdr-goals` Codex skill. The management pane is only an
interactive client: it reads goal and runtime state, discusses or refines
outcomes, and relays authorized complete actions to the named Pi supervisor. It
owns no goal state and can be closed without affecting workers. You can still
talk directly to the Pi supervisor for simpler use.

**Working on host files:** mount your project directory into the container:

```sh
HERDR_WORKSPACE=/path/to/your/project docker compose up -d --build
```

Use `/supervised` inside the supervisor pane to inspect active goals and worker
state at any time.

### Container environment

| Variable | Default | Purpose |
|---|---|---|
| `HERDR_SUPERVISOR_MODE` | `off` | `off`, `observe`, `dry-run`, or `live`; prefer the per-Pi flag when only one pane should supervise |
| `HERDR_SUPERVISOR_CODEX_FULL_ACCESS` | `0` | Set to `1` for unattended operation (see Security below) |
| `HERDR_SUPERVISOR_DIRECTORY` | `/app` | Supervisor's stable infrastructure directory |
| `HERDR_WORKSPACE` | Docker volume | Project directory mounted at `/app` in the container |
| `ANTHROPIC_API_KEY` | — | Required for Pi |
| `OPENAI_API_KEY` | — | Required for Codex workers |
| `GITHUB_TOKEN` | — | GitHub API token for configured metadata discovery. `GH_TOKEN` also works |
| `AZURE_DEVOPS_EXT_PAT` | — | Azure DevOps token for build or PR discovery; required in the stock image unless the deployment supplies Azure CLI and its login state |
| `AZURE_CLI` | `az` | Optional Azure CLI executable used when no ADO token is configured |
| `HERDR_SUPERVISOR_REVIEW_MS` | `3600000` | Time without a review before a stale-progress check |
| `HERDR_SUPERVISOR_GLOBAL_REVIEW_MS` | `3600000` | Interval for the compact review across all goals |
| `HERDR_WATCH_GITHUB_REPOSITORIES` | — | Up to ten comma-separated trusted `owner/repository` scopes; requires a GitHub token and enables the shared watcher |
| `HERDR_WATCH_ADO_DEFINITIONS` | — | Up to ten comma-separated `organization/project/definition-id` scopes; enables the shared watcher |
| `HERDR_WATCH_ADO_REPOSITORIES` | — | Up to ten comma-separated `organization/project/repository` scopes; observes annotated ADO PRs |
| `HERDR_WATCH_ADO_CREATOR_ID` | — | Optional Azure DevOps identity UUID; narrows ADO PR discovery to PRs created by that identity before checking supervision metadata |
| `HERDR_WATCH_INTERVAL_MS` | `60000` | Interval between bounded provider scans |
| `HERDR_WATCH_STALE_AFTER_MS` | `86400000` | Time an unchanged linked resource waits before one goal-batched stale notification; `0` disables it |
| `HERDR_WATCH_STATE_HOME` | user state directory | Directory for the bounded revision checkpoint |

Codex runs sandboxed with its normal approval prompts by default. Set
`HERDR_SUPERVISOR_CODEX_FULL_ACCESS=1` to pass `--dangerously-bypass-approvals-and-sandbox`
for unattended operation, when you have decided the container is an adequate
security boundary.

> **Security:** the Pi supervisor has ordinary process and file tools, and
> full-access mode lets Codex modify every writable path visible in the
> container, including a bind-mounted host workspace. Mount only the workspace
> you intend agents to change. Keep API keys in your local environment or a
> secret store; never commit them to this repository. Use Pi's
> `--no-builtin-tools` only when you intentionally prefer a restricted
> supervisor over direct infrastructure operation.

Detaching from the Herdr client does not stop the server, supervisor, or workers.
Reattach with `docker compose exec herdr herdr`. Compose restarts the service
after an unexpected failure; an explicit operator stop remains stopped.
The image pins the Codex CLI version, and its wrapper disables Codex's startup
update check so a restored worker cannot stop at an interactive upgrade prompt.
Upgrade Codex by rebuilding the image with the intended version.
Container restoration resumes the native Goal only when exactly one active
goal owns that native session and it names the restoring pane. Completed,
stopped, unknown, and ambiguously bound sessions remain available but parked.

### Before recreating the container

Container replacement is safe only when its external contract is preserved.
Check the resolved Compose configuration with `docker compose config`, then
confirm that the replacement has:

- the same Compose project name and volume namespace as the running instance
  (find the current name with `docker compose ls`, then reuse it with `-p` or
  `COMPOSE_PROJECT_NAME`);
- the intended source checkout as its resolved build context;
- the intended project workspace mounted at `/app`;
- persistent home storage for Herdr and native agent sessions;
- the configured model credentials or gateway settings;
- network access to that gateway and any required source-control provider; and
- the same supervisor mode and full-access choice.

After replacement, open Herdr, run `/supervised`, and verify one existing goal's
exact pane and native session before trusting unattended work. Provider login
is scoped to the environment where the worker runs; logging in on a different
host or container does not refresh it. Keep machine-specific endpoints, tokens,
and Compose overrides outside this repository.

## Local use (without container)

If you have Herdr and Pi installed locally, you can load the extension directly.
This is a development convenience rather than the supported deployment path.
CI checks this Node-level path on macOS once a week, while every pull request
must pass the Linux container tests that match the released image.

**Prerequisites:** Node.js >= 26, Herdr running, Pi installed.

```sh
git clone https://github.com/hao1939/herdr-supervisor.git
cd herdr-supervisor
npm install
```

Start Pi in a Herdr pane from a stable directory separate from any worker project:

```sh
supervisor_extension=/path/to/herdr-supervisor/src/extension.ts
cd "${HERDR_SUPERVISOR_DIRECTORY:-/app}"
pi -e "$supervisor_extension" --supervisor-mode live
```

Always choose the mode explicitly. Without `--supervisor-mode` or
`HERDR_SUPERVISOR_MODE`, the extension is inert. Do not copy or link it into
Pi's user-wide `~/.pi/agent/extensions` directory: every ordinary Pi session
would discover it even though only the dedicated supervisor should own this
goal store.

After passive behavior is verified, use `--supervisor-mode dry-run` to let the
supervisor review events without applying decisions. Ordinary Pi tools remain
available for direct human requests and infrastructure operations. During an
automatic focused or global review, the extension temporarily exposes only its
supervision tools and restores the ordinary tools afterward. An operator may
still pass `--no-builtin-tools` for a deliberately restricted deployment,
accepting that such a session cannot operate `event-watchd` itself.

## How it works

The supervisor creates goals conversationally. It first turns the human's
intent into a concrete outcome and completion proof, then compares that
candidate with existing goals. Related subjects or tools are not enough to
merge outcomes. It places a Codex worker in a new or related tab, records the
binding, gives its pane a short goal-based label, and projects the canonical
contract into that worker's native Codex Goal.
Codex owns the ordinary work-check-continue loop. The supervisor sleeps until a
Herdr event or review deadline wakes it, then observes the worker once and makes
exactly one decision:

- **leave** — healthy progress, sleep until the next event
- **steer** — send one goal-aware instruction to the same worker, optionally
  preserving an exact time when that instruction must be checked again
- **ask_human** — a concrete question when your authority or information is needed
- **accept** — goal met with convincing evidence

Two operations sit outside those review decisions. **stop** is explicit operator
control that ends supervision without stopping the worker. Exact-session resume
is transport inside **steer**: for a stopped Codex process, the executor resumes
that same session and paused native Goal before delivering the instruction. If
its pane disappeared and the recorded session supports exact resume, the
executor may create a new routing pane, but only for that saved session.
For a settled worker whose process is still present, the executor submits the
native `/goal resume` TUI command to the exact pane and verifies that the same
worker becomes active. Sending that text as an ordinary model prompt does not
operate the native Goal.
Herdr preserves a native Codex session when a human closes its settled pane.
The supervisor does not automatically close panes because Herdr's current close
operation cannot atomically require the expected terminal and native session.
An explicitly selected saved goal that has never started can also be discarded;
the action refuses any goal with execution state, history, or unknown files.

For GitHub and Azure DevOps, one shared external event watcher (`event-watchd`)
observes configured provider scopes without model turns. Workers attach their
durable goal ID when they create a PR or build; they never register or renew a
watch. A changed revision resolves that goal's current exact worker and sends a
short wake hint. One unchanged revision may also send a single goal-batched
stale hint after the configured threshold.
The worker rereads provider authority, continues useful work, and its normal
Herdr event wakes the supervisor. Further unchanged reads stay quiet, and the
bounded goal review remains the safety net after a missed signal or provider
failure.
One short per-goal execution lock prevents a notification from crossing an
accept or stop decision; it contains no workflow state.

ADO discovery uses `AZURE_DEVOPS_EXT_PAT` when configured. A custom deployment
may instead supply Azure CLI, its login state, and `AZURE_CLI` when the executable
is not on the service `PATH`. The stock image does not bundle Azure CLI.
Credentials are never copied into goal or watcher state.

Warnings and failures follow the same path. The component reports the observed
condition, affected goals, and remaining automatic behavior. A warning may
preserve valid bounded results; a failure rejects an invalid scan. The
supervisor uses the existing goal actions and stable operating guidance to
decide what to do. A diagnostic never creates a goal or recovery workflow by
itself.

Any agent with ordinary shell access can inspect and start the watcher directly
by passing provider scopes to `npm run watch`. The container can also start it
automatically when a provider-scope variable is injected at boot; that is an
optional restart convenience, not a required control path. Configure only
scopes where supervision metadata is written by trusted workers or maintainers.

The [event-watchd guide](src/event-watcher/README.md) shows how an agent starts,
inspects, verifies, changes, stops, and extends it. It also defines the small
coding contract for adding another built-in provider or resource type and the
separate knowledge contract for teaching the receiving agent how to respond.
The agent uses its ordinary environment authority; no watcher-specific
management tool or dynamic plugin loader is needed.

The goal-store root includes a concise `README.md` explaining its layout,
authority, lifecycle, safe inspection, and portability. Each goal directory has
`goal.json` (portable contract) and, when relevant, `current.json` (local
execution checkpoint) and `journal.jsonl` (audit). The contract file is the
only goal data another instance needs; place it in a valid goal directory there
before starting a new worker. Store reads never generate files, and
initialization never overwrites an existing root guide.

An optional Codex management pane uses that same self-explaining store for
portfolio discussion. It summarizes active outcomes, material progress,
blockers, next actions, and the latest advisory global-review finding without
creating another registry or action path. The uniquely named Pi `supervisor`
still performs every validated goal mutation.

Run only one Pi supervisor against a goal-store root. Goal-management panes may
read that store and relay requests, but a second supervisor writer is outside
the supported deployment model. Stop the duplicate before applying more goal
actions.

The human may refine an active goal in conversation. The supervisor updates the
durable contract and informs the same worker — no sibling goals or temporary
steering. For operator control, `/supervise <pane> <goal>` attaches an existing
worker, and `/supervise <pane> --goal-id <id>` starts a copied contract.

When a worker creates or updates a pull request, its native Goal asks it to add
a small `Supervision` block to the description containing the readable goal,
exact goal ID, observed Herdr worker name, and Herdr pane ID. The worker reads
the current objective from the canonical `goal.json` whenever it creates or
updates the PR, so a refined goal does not leave stale text behind. A public native Codex
session ID is included when the binding has one. Path-backed bindings never
publish their local session path. The PR title and main summary stay about the
change; the metadata only makes the originating supervised work easy to trace.

### Current limitations

- **Full automation is Codex-specific.** Other Herdr agents can be attached and
  observed through terminal output, but native Goal delivery and exact-session
  recovery require Codex.
- **One worker per goal.** A worker may use several repositories and worktrees,
  but the supervisor does not coordinate several agents inside one goal.
- **No automatic pane retirement or parking.** Safe closure needs an atomic
  Herdr identity precondition; safe parking also needs atomic exact-session
  resume and prompt. Until then, idle is execution state rather than proof that
  a pane is disposable.

## Development

```sh
npm install
npm run check    # tsc --noEmit + shell syntax
npm test         # node:test suite
```

### Release pull requests

This repository uses release-please and squash-merges pull requests. The pull
request title becomes the squash commit title, so write it as the Conventional
Commit that should choose the changelog section and version bump.

Use a `plugin` scope for Herdr plugin-facing changes, for example
`feat(plugin): add ...`, `fix(plugin): correct ...`, or
`docs(plugin): explain ...`. Use `!` for breaking changes, such as
`feat(plugin)!: change ...`.

## Documents

- [Changelog](CHANGELOG.md)
- [Current design](docs/design.md)
- [Research landscape](docs/research.md)

## Feedback

Herdr Supervisor is still learning from real long-running work. Use
[GitHub Discussions](https://github.com/hao1939/herdr-supervisor/discussions) to
share a goal that stalled, a confusing interaction, or a case where the design
added work instead of helping. Concrete session evidence is especially useful.

## Design rule

The runtime owns process and session truth. The supervisor owns judgment about
whether a worker is still moving toward its stated goal. It must not copy the
runtime lifecycle into a parallel queue, task graph, or status database.

Implement only the small deterministic foundation shared by most goals. Keep
uncommon recovery and workflow choices in model guidance until repeated live
evidence proves a generic code primitive is necessary.

For each new feature or failure, first ask whether the agent can handle it with
current primitives, whether an event or bounded check will wake the agent, and
whether it has enough knowledge and context. If so, teach the behavior rather
than coding another mechanism. Add code only for a proven missing primitive or
a recurring problem with clear general benefit.
