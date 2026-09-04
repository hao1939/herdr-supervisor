# Research landscape

**Reviewed:** 2026-09-04

This is a dated review of related work, not a claim that every linked project
or discussion still has the same behavior. Recheck a source before using it to
justify a new design decision.

## Question

Does an existing Herdr extension or adjacent project already let one agent
observe multiple interactive workers, steer the same sessions, recover stalls,
ask a human when necessary, and keep working until each goal is accepted?

## Conclusion

The supervisor pattern is common and increasingly mature, but no reviewed
Herdr extension supplied the complete behavior as a small, generic component
at the review date. Herdr Supervisor now implements that experiment as a Pi
extension and container companion. It is not a native Herdr plugin, a Kanban
board, or a replacement runtime.

The closest complete analogue is `aoaoe`, which supervises Agent of Empires
sessions. Its policy ideas are useful, but its standalone implementation polls
tmux, captures terminal text, and applies status heuristics. Herdr already
provides better event and identity primitives, so that mechanism should not be
copied.

The strongest Herdr-native prior art is Pi Bellwether. It provides direct Herdr
control, non-blocking watches, one-time Pi wakeups, exact watch lifecycles, and
lightweight crash detection. It deliberately does not own durable workflow
meaning. Herdr's socket exposes the smaller set of primitives currently needed
by this project, so the implementation uses that direct contract without adding
a Bellwether dependency.

## Herdr itself

### Relevant capabilities

[Herdr's socket API](https://herdr.dev/docs/socket-api/) provides:

- session snapshots;
- stable pane and terminal identities;
- native agent-session references;
- semantic agent states;
- `state_change_seq` and pane revisions;
- `events.subscribe` and one-shot event-driven waits;
- `pane.agent_status_changed`, `pane.output_matched`, and `pane.exited`;
- bounded reads and prompts to an exact agent;
- `agent.prompt` with an atomic optional wait, avoiding a send/wait race;
- display-only metadata that does not take over lifecycle authority.

[Herdr plugins](https://herdr.dev/docs/plugins/) are intentionally external
workflow packages. Herdr keeps the core focused on workspaces, panes, agents,
and a stable API. Plugins own their implementation and durable state. Startup
hooks are one-shot restoration commands, not supervised daemons.

### Product direction

- [Issue #301: Simple Kanban Task Management](https://github.com/herdrdev/herdr/issues/301)
  was closed as not planned. The maintainer explicitly preferred enabling this
  kind of specialized feature through the plugin system rather than adding it
  to Herdr core. Herdr Supervisor explores the same human problem through
  durable goals and an external companion rather than a board inside Herdr.
- [Issue #2871: pane lineage and prompt-flow observability](https://github.com/herdrdev/herdr/issues/2871)
  proposes exposing runtime facts without putting DAG or routing semantics in
  Herdr. The issue was redirected to Ideas discussions; this boundary belongs
  to the proposal and should not be presented as accepted Herdr direction.
- [Discussion #3584: sender attribution for socket-originated agent input](https://github.com/herdrdev/herdr/discussions/3584)
  identifies a boundary that directly matters here: a receiving agent cannot
  reliably distinguish a socket prompt from human keyboard input. Herdr
  Supervisor must not treat socket delivery itself as proof of human authority.
- [Discussion #3427: agents orchestrating across machines](https://github.com/herdrdev/herdr/discussions/3427)
  offers useful one-owner-per-runtime reasoning for future portability, but
  multi-machine supervision remains outside this project's current scope.

No Herdr core change is required for the currently supported behavior. Native
sender attribution could improve future authority separation, but it is not a
reason to invent identity inside the current goal model.

## Closest Herdr-native projects

### Pi Bellwether

Source: [joelhooks/pi-bellwether](https://github.com/joelhooks/pi-bellwether)

What it provides:

- structured Pi tools for Herdr layouts, panes, and agents;
- direct socket watches for agent state and pane output;
- watch lifecycle `starting -> running -> matched | timedOut | targetGone |
failed | cancelled`;
- `agent`, `notify`, and `silent` wake policies;
- immediate return after a watch is armed;
- a five-second identity probe to detect an agent that crashed back to a live
  shell without a corresponding Herdr release event;
- cancellation and suppression of late wakes.

What it does not provide:

- a goal attached to each watched worker;
- acceptance judgment;
- a policy for steering, human escalation, recovery, or completion;
- a durable multi-worker supervisor view.

Decision: use its public behavior as prior art, but keep the implementation on
Herdr's direct socket while that remains smaller. Reconsider Bellwether only if
later stages need its output matching, crash probe, or watch lifecycle as a
cohesive public capability.

### Shepherd

Source: [ryonakae/shepherd](https://github.com/ryonakae/shepherd)

What it provides:

- structured session history for Claude Code, Codex, Gemini CLI, OpenCode, and
  Pi without parsing terminal rendering;
- cached compact context;
- completed and blocked outcomes delivered to one owner Pi;
- reconnect handling and an optional Herdr UI.

Limits:

- read-only by design;
- runs a daemon and rescans running Herdr sessions every 60 seconds;
- an outcome wake is not goal acceptance or proactive steering.

Decision: keep optional. Add it only if bounded Herdr reads do not give the
supervisor enough reliable evidence.

### Herdr ORC

Source: [tamdogood/herdr-orc](https://github.com/tamdogood/herdr-orc)

What it provides:

- one restricted Pi coordinator that delegates to visible Herdr workers;
- explicit worker ownership and model selection;
- structured result envelopes;
- verification that Herdr lifecycle state is not task success;
- no daemon, database, workflow DSL, scheduler, or auto-merge system.

Limits:

- focuses on work delegated by its coordinator rather than supervising
  arbitrary existing workers;
- deliberately does not automatically retry writes;
- very new and lightly adopted at review time.

Decision: borrow its acceptance discipline, not its coordinator topology or a
worker-facing reporting protocol.

### Other useful Herdr components

| Project                                                                                      | Useful lesson                                                     | Why it is not the complete answer                        |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------- |
| [herdr-pings](https://github.com/joelhooks/herdr-pings)                                      | Durable turn-settled and crash events                             | Pi-specific reporting and spool-based waiting            |
| [herdr-janitor](https://github.com/joelhooks/herdr-janitor)                                  | Coalesced events, bounded LLM judgment, identity-fenced execution | Focused on cleanup, not goal supervision                 |
| [herdr-walkietalkie](https://github.com/jeffory/herdr-walkietalkie)                          | Cross-agent delegation and result handoff                         | Best-effort wake; no persistent supervisor               |
| [herdr-reviewr](https://github.com/persiyanov/herdr-reviewr)                                 | Human review and feedback to the same worker                      | Human-driven code review only                            |
| [herdr-approval-gate](https://github.com/Javamomma/herdr-approval-gate)                      | Independent verdict and fail-closed approval                      | One guarded command, not continuing goals                |
| [herdr-plan-code-review](https://github.com/inxx/herdr-plan-code-review)                     | Visible fixed multi-agent workflow                                | Fixed topology and partly manual handoff                 |
| [Collie](https://github.com/AltanS/collie)                                                   | Attention-first mobile view and replies                           | Human control surface, no semantic supervisor            |
| [Herdr Remote](https://github.com/dcolinmorgan/herdr-remote)                                 | Timeline, notifications, approvals, remote input                  | Human control surface; polls in some modes               |
| [herdr-trail](https://github.com/catoncat/herdr-trail)                                       | Small provenance-preserving follow-up list                        | Memo list, not worker convergence                        |
| [herdr-worker-orchestrator](https://github.com/anhnd3005-infinity/herdr-worker-orchestrator) | Worktree-isolated delegation and review                           | Claude-centered workflow rather than generic supervision |
| [herdr-conductor](https://github.com/StructuPath/herdr-conductor)                            | Explicit contracts and evidence gates                             | Deliberately attended staged workflow                    |

## Adjacent supervisor and orchestration systems

### Agent of Agent of Empires (`aoaoe`)

Source: [Talador12/agent-of-agent-of-empires](https://github.com/Talador12/agent-of-agent-of-empires)

This is the closest direct match. It observes Agent of Empires sessions, asks
OpenCode or Claude Code to decide, and can send input, start or recover
sessions, report progress, and complete tracked work. It includes dry-run and
confirmation modes, action cooldowns, identity resolution, budgets, and
persistent goal state.

Its standalone defaults and source show why it is not the right substrate for
this project:

- polls every 10 seconds;
- captures up to 100 terminal lines per session;
- runs semantic reasoning no more often than every 60 seconds;
- uses output hashes, terminal text, and regex heuristics to correct status;
- adds its own task and daemon state.

Decision: borrow its small decision vocabulary, dry-run behavior, cooldowns,
and same-session steering. Use Herdr events instead of its poller and parser.

### Larger replacements

| Project                                                                         | Strength                                                                         | Tradeoff for this project                                          |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| [Agent Orchestrator](https://github.com/Untrivial-ai/agent-orchestrator)        | Polished project orchestrator, worker isolation, CI/review feedback, live Kanban | A large replacement control plane rather than a Herdr companion    |
| [Gas Town](https://github.com/gastownhall/gastown)                              | Persistent work, Mayor coordinator, watchdog tiers, recovery, merge queue        | Powerful but introduces a much larger mental and operational model |
| [AWS CLI Agent Orchestrator](https://github.com/awslabs/cli-agent-orchestrator) | Multi-agent CLI orchestration in isolated tmux sessions                          | Own runtime and workflow system rather than existing Herdr panes   |
| [amux](https://github.com/mixpeek/amux)                                         | Durable agent control plane, recovery, scheduling, board and API                 | Replaces the simple Herdr-centered architecture                    |
| [Overstory](https://github.com/jayminwest/overstory)                            | Pluggable agent runtime adapters                                                 | Archived at review time                                            |
| [oh-my-opencode-slim](https://github.com/alvinunreal/oh-my-opencode-slim)       | Strong in-process OpenCode delegation with Herdr pane display                    | Orchestrates its own subagents, not arbitrary existing workers     |
| [Agent of Empires](https://github.com/agent-of-empires/agent-of-empires)        | Multi-agent session and worktree manager                                         | Alternative host to Herdr, not its supervisor layer                |

## Agent-runtime building blocks

- [pi-codex-goal](https://github.com/joelhooks/pi-codex-goal) reproduces
  Codex-style goal persistence and continuation inside one Pi session. Its
  hidden continuation behavior is useful for an executing worker but should
  not make an otherwise idle supervisor spin.
- [pi-workflow-os](https://github.com/joelhooks/pi-workflow-os) implements
  event-backed dynamic workflows and loop-until-done patterns. It is useful
  when a known workflow is needed, but broader than the first PoC.
- [pi-subagents](https://github.com/joelhooks/pi-subagents) supplies async Pi
  subagents, progress files, and notifications. It manages Pi-launched
  subagents rather than independent Herdr panes.
- [Codex configuration](https://learn.chatgpt.com/docs/config-file/config-reference#configtoml)
  documents native persisted goals, automatic continuation, lifecycle hooks,
  resumable state, and multi-agent collaboration. No reviewed official OpenAI
  document supplies an existing Herdr supervisor integration.

## Lessons carried into Herdr Supervisor

1. Herdr state is a wake signal, not completion proof.
2. Register workers explicitly; do not infer ownership from pane layout or
   terminal prose.
3. Read current evidence only after a meaningful event or stale deadline.
4. Keep one in-flight review per worker and coalesce later events by sequence.
5. Steer the same worker by default; do not create another worker merely
   because the current one is idle, blocked, or slow.
6. Fence every action to the exact pane, terminal, and agent-session identity
   that was reviewed.
7. Begin in observe-only and dry-run modes.
8. Persist only goal bindings and recovery checkpoints. Do not persist another
   copy of Herdr status.

## Questions for community feedback

Public discussion is most useful when it tests a concrete design choice rather
than merely announcing the repository. The current open questions are:

1. Which real long-running goals still get lost, stall silently, or need too
   much human prompting under this model?
2. Does one worker owning one durable goal remain understandable when several
   goals share a repository, cluster, or review queue?
3. Are meaningful events plus a bounded safety review enough, or is a small
   reusable observation primitive still missing?
4. Is the current Pi extension and container companion the right packaging, or
   would a native Herdr plugin improve installation without moving workflow
   meaning into Herdr?
5. Where must sender attribution exist before a management agent or watcher can
   safely relay a request that depends on human authority?

The primary venue is
[Herdr Show and tell discussion #3607](https://github.com/herdrdev/herdr/discussions/3607).
A follow-up on issue #301 links that discussion because the thread explicitly
points specialized task tracking toward extensions. Do not add promotional
links to loosely related layout, remote-runtime, or agent-catalog discussions.
