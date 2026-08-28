# Research landscape

**Reviewed:** 2026-08-28

## Question

Does an existing Herdr extension or adjacent project already let one agent
observe multiple interactive workers, steer the same sessions, recover stalls,
ask a human when necessary, and keep working until each goal is accepted?

## Conclusion

The supervisor pattern is common and increasingly mature, but no reviewed
Herdr extension supplies the complete behavior as a small, generic component.

The closest complete analogue is `aoaoe`, which supervises Agent of Empires
sessions. Its policy ideas are useful, but its standalone implementation polls
tmux, captures terminal text, and applies status heuristics. Herdr already
provides better event and identity primitives, so that mechanism should not be
copied.

The strongest Herdr-native prior art is Pi Bellwether. It provides direct Herdr
control, non-blocking watches, one-time Pi wakeups, exact watch lifecycles, and
lightweight crash detection. It deliberately does not own durable workflow
meaning. The installed Herdr 0.8.0 socket already exposes the smaller set of
primitives needed by this PoC, and Bellwether is not installed locally, so the
first implementation uses the direct contract without adding a dependency.

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
  to Herdr core.
- [Issue #2871: pane lineage and prompt-flow observability](https://github.com/herdrdev/herdr/issues/2871)
  documents interest in external orchestrator topologies. It also states a
  useful boundary: expose facts, but do not put DAG or routing semantics in
  Herdr.
- [Issue #1778: external ownership state](https://github.com/herdrdev/herdr/issues/1778)
  shows that integrations sometimes need a small amount of identity/ownership
  state outside Herdr. Explicit worker registration avoids guessing lineage.

No Herdr core change is required for the first proof of concept.

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

Decision: use its public behavior as prior art, but keep the PoC on Herdr's
direct socket while that remains smaller. Reconsider Bellwether only if later
stages need its output matching, crash probe, or watch lifecycle as a cohesive
public capability.

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

## Lessons carried into the PoC

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
