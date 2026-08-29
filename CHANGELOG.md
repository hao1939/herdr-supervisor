# Changelog

All notable changes to Herdr Supervisor are documented here. This project
uses [Semantic Versioning](https://semver.org/).

## [0.1.0] — 2026-08-29

Initial public release.

### Added

- **Goal lifecycle.** Install, start, observe, leave, steer, ask_human, recover,
  accept, stop, and refine. Each decision is recorded in `current.json` and
  audited in `journal.jsonl`.
- **Durable per-goal storage.** One directory per goal: `goal.json` (portable
  contract), `current.json` (local execution checkpoint), and `journal.jsonl`
  (audit history). Copying only `goal.json` is enough to start that goal with a
  new worker in another instance.
- **Event-driven review.** Herdr events wake the supervisor when review is
  useful. One nearest-deadline timer across all bindings serves as a recovery
  safety net, not a polling loop. Only due workers wake; signals received during
  a review coalesce until that review settles.
- **Bounded review turns.** Each signal starts one bounded review turn: observe
  the exact worker once, then call exactly one decision tool. A later worker
  event starts a fresh turn.
- **Codex worker startup and observation.** Start Codex workers in new or related
  tabs, observe through native Codex session JSONL (terminal output is a bounded
  fallback), and recover exact sessions when the process has exited but the
  terminal remains.
- **Shared Pi supervisor session.** One persistent Pi session receives one
  explicitly scoped worker-review at a time. Workers run concurrently; signals
  for other workers coalesce in memory until the current review settles.
- **Global safety-net review.** Low-frequency compact snapshot of all goal
  checkpoints, worker states, and runtime health. Identifies affected goals and
  queues each through the existing focused review path.
- **Human decisions.** One review can ask a concrete question while leaving the
  worker untouched. The human's reply steers the worker once. Pending questions
  survive restart.
- **Conversational goal creation.** Describe an outcome; the supervisor forms
  criteria, places workers in tabs, starts Codex, records the binding, and
  delivers the goal. Existing `/supervise` retained for operator control.
- **Goal refinement.** The human may refine an active goal in conversation. The
  supervisor replaces the portable contract and informs the same worker; it does
  not create a sibling goal.
- **Peer coordination.** Workers can record a concrete wait on another supervised
  worker; that worker's next change immediately wakes the dependent goal.
- **Restart resilience.** Resuming the same Pi session reloads binding
  checkpoints, restores review deadlines, and immediately reviews only workers
  whose fresh state needs attention. With no active goal the supervisor remains
  idle.
- **Worker identity fencing.** Registration captures exact pane, terminal, and
  native agent-session identity. A replaced occupant, changed session, or missing
  pane fails closed.
- **Container packaging.** Docker Compose with Herdr, Pi, and Codex. Codex runs
  sandboxed by default; full-access mode is opt-in. Automatic restart on
  unexpected failure. Extension installed via entrypoint; no special resume
  command needed.
- **Standalone CLI.** `herdr-supervisor workers` (read-only Herdr view) and
  `herdr-supervisor status` (supervised goals against live state).
- **Test suite.** 93 tests covering goal storage, registry, Herdr client,
  observation, supervision logic, review turns, and the full extension.
- **Type checking.** `tsc --noEmit` via tsconfig.json; syntax checking for all
  JS modules and shell scripts.

### Development history

The implementation progressed through five stages during August 2026:

1. **Binding and observation.** Bind goals to existing workers, show live state,
   fence worker identity, observe lifecycle transitions without model calls.
2. **Review evidence and scheduling.** Native Codex session messages as evidence
   (2a), nearest-deadline review timer (2b), shared supervisor session with
   coalesced signals (2c), global safety-net review (2d).
3. **Live decisions.** Observe-then-decide review turns exercised end to end:
   steer, finish, ask_human, recover. Human decisions without a separate queue.
   Peer wait coordination.
4. **Restart and recovery.** Resume exact Pi and Codex sessions. Restore binding
   checkpoints, review deadlines, and pending human questions. Identity-mismatch
   and missing-pane fail-closed.
5. **Durable goal directories.** One directory per goal replaces the shared
   binding file. Conversational goal creation and refinement. Container
   packaging with automatic extension installation and Codex session hooks.

A live three-worker trial confirmed that the shared session kept concurrent
workers' evidence separate, reviewed every worker, and removed all bindings
after acceptance. Multi-worker restart, recovery, and idle trials all pass.
