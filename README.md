# Herdr Supervisor

One Pi agent that supervises existing Herdr workers against explicit goals,
without replacing Herdr or introducing another task system.

1. You describe an outcome to the supervisor.
2. The supervisor forms the goal and acceptance criteria, starts one Codex worker
   with a native `/goal` for it, and sleeps.
3. A changed external watch wakes its exact worker directly; a meaningful
   worker event wakes the supervisor.
4. The supervisor reads the worker's evidence and either leaves it alone,
   continues it, asks you, or accepts the result.

Herdr owns runtime truth. The supervisor owns judgment.

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

In the Herdr UI, open a pane and type `pi`. The extension loads automatically.
Talk to the supervisor — describe what you want done and it handles the rest.

**Working on host files:** mount your project directory into the container:

```sh
HERDR_WORKSPACE=/path/to/your/project docker compose up -d --build
```

Use `/supervised` inside the supervisor pane to inspect active goals and worker
state at any time.

### Container environment

| Variable | Default | Purpose |
|---|---|---|
| `HERDR_SUPERVISOR_MODE` | `live` | `observe`, `dry-run`, or `live` |
| `HERDR_SUPERVISOR_CODEX_FULL_ACCESS` | `0` | Set to `1` for unattended operation (see Security below) |
| `HERDR_SUPERVISOR_DIRECTORY` | `/app` | Supervisor's stable infrastructure directory |
| `HERDR_WORKSPACE` | Docker volume | Project directory mounted at `/app` in the container |
| `ANTHROPIC_API_KEY` | — | Required for Pi |
| `OPENAI_API_KEY` | — | Required for Codex workers |
| `GITHUB_TOKEN` | — | Required for private GitHub PR watches; optional for public PRs to avoid the 60/hour unauthenticated limit. `GH_TOKEN` also works |
| `AZURE_DEVOPS_EXT_PAT` | — | Required for Azure DevOps build watch (the `az` CLI is not in the image) |
| `HERDR_SUPERVISOR_REVIEW_MS` | `3600000` | Time without a review before a stale-progress check |
| `HERDR_SUPERVISOR_GLOBAL_REVIEW_MS` | `3600000` | Interval for the compact review across all goals |
| `HERDR_SUPERVISOR_EXTERNAL_WATCH_MS` | `300000` | Interval for PR and build observations |

Codex runs sandboxed with its normal approval prompts by default. Set
`HERDR_SUPERVISOR_CODEX_FULL_ACCESS=1` to pass `--dangerously-bypass-approvals-and-sandbox`
for unattended operation, when you have decided the container is an adequate
security boundary.

> **Security:** full-access mode lets Codex modify every writable path visible
> in the container, including a bind-mounted host workspace. Mount only the
> workspace you intend agents to change. Keep API keys in your local environment
> or a secret store; never commit them to this repository.

Detaching from the Herdr client does not stop the server, supervisor, or workers.
Reattach with `docker compose exec herdr herdr`. Compose restarts the service
after an unexpected failure; an explicit operator stop remains stopped.

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
pi --no-builtin-tools -e "$supervisor_extension" --supervisor-mode live
```

After passive behavior is verified, use `--supervisor-mode dry-run` to let the
supervisor review events without applying decisions. `--no-builtin-tools` ensures
the supervisor cannot become a second worker.

## How it works

The supervisor creates goals conversationally. It forms explicit completion
criteria, places a Codex worker in a new or related tab, records the binding,
and projects the canonical contract into that worker's native Codex Goal.
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

For a settled goal waiting on one exact GitHub pull request or Azure DevOps
build, the supervisor can observe that resource between model turns. Unchanged
reads stay quiet. A changed revision wakes the exact worker directly with the
resource, provider summary, and its previous wait context. That summary stays
with the pending revision if the worker is busy. The worker rereads the provider
and handles the change; its later result follows the ordinary focused-review path.
When that condition is the worker's only blocker, it reports the wait once and
yields instead of sleeping or polling. This uses the existing timer and worker
session; it is not another daemon or task system. The normal bounded review is
the fail-closed fallback after restart, delivery uncertainty, or provider
failure.

Each goal gets one directory: `goal.json` (portable contract), `current.json`
(execution checkpoint), and `journal.jsonl` (audit). Copying `goal.json` is
enough to start that goal with a new worker elsewhere.

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

- **Codex only.** Worker startup, message-level observation, and exact-session
  recovery are Codex-specific. Other Herdr CLIs fall back to terminal scraping.
- **One agent per goal.** Multi-agent execution (relay, reviewer pair) is
  designed but not implemented. See `docs/multi-agent-design.md`.

## Development

```sh
npm install
npm run check    # tsc --noEmit + shell syntax
npm test         # node:test suite
```

## Documents

- [Changelog](CHANGELOG.md)
- [Current design](docs/design.md)
- [Research landscape](docs/research.md)
- [Deferred multi-worker exploration](docs/multi-agent-design.md)
- [Proof-of-concept validation record](docs/poc-design.md)
- [Code review, 2026-08-29](docs/review-2026-08-29.md) — historical snapshot

## Design rule

Herdr owns runtime truth. The supervisor owns judgment about whether a
registered worker is still moving toward its stated goal. It must not copy
Herdr's lifecycle into a parallel queue, task graph, or status database.

Implement only the small deterministic foundation shared by most goals. Keep
uncommon recovery and workflow choices in model guidance until repeated live
evidence proves a generic code primitive is necessary.

For each new feature or failure, first ask whether the agent can handle it with
current primitives, whether an event or bounded check will wake the agent, and
whether it has enough knowledge and context. If so, teach the behavior rather
than coding another mechanism. Add code only for a proven missing primitive or
a recurring problem with clear general benefit.
