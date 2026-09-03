# Changelog

All notable changes to Herdr Supervisor are documented here. This project
uses [Semantic Versioning](https://semver.org/).

## [0.4.0](https://github.com/hao1939/herdr-supervisor/compare/herdr-supervisor-v0.3.0...herdr-supervisor-v0.4.0) (2026-09-03)


### Features

* add explicit saved-goal discard ([06ba7a5](https://github.com/hao1939/herdr-supervisor/commit/06ba7a5dc82c2c942d7822c6a27c24f04ab23b4a))


### Bug Fixes

* make saved-goal discard fail closed ([06ba7a5](https://github.com/hao1939/herdr-supervisor/commit/06ba7a5dc82c2c942d7822c6a27c24f04ab23b4a))

## [0.2.2](https://github.com/hao1939/herdr-supervisor/compare/herdr-supervisor-v0.2.1...herdr-supervisor-v0.2.2) (2026-08-29)


### Bug Fixes

* keep active workers out of waiting state ([4567fac](https://github.com/hao1939/herdr-supervisor/commit/4567fac9a679f46d74b61f83779bfe09147622b7))
* preserve standing improvement goals ([880e7f7](https://github.com/hao1939/herdr-supervisor/commit/880e7f7f86ec7162af54ca9a01ead19c29f5529f))
* separate global findings from review routing ([7277f46](https://github.com/hao1939/herdr-supervisor/commit/7277f46a40498a8d9c3c599acd224182edc164b6))

## [0.2.1](https://github.com/hao1939/herdr-supervisor/compare/herdr-supervisor-v0.2.0...herdr-supervisor-v0.2.1) (2026-08-29)


### Performance Improvements

* skip evidence-free working reviews ([73ba044](https://github.com/hao1939/herdr-supervisor/commit/73ba044397ee63d6c49a071fa2662edee0fdb819))

## [0.2.0](https://github.com/hao1939/herdr-supervisor/compare/herdr-supervisor-v0.1.0...herdr-supervisor-v0.2.0) (2026-08-29)


### Features

* add compact global supervision review ([9d0b900](https://github.com/hao1939/herdr-supervisor/commit/9d0b90054dc4012f4bd2bf8f2790693a84c57a1f))
* reassess goals when progress stalls ([0017998](https://github.com/hao1939/herdr-supervisor/commit/0017998eaad71ea9f3e431e6c64de97ed6e92090))
* refine active goals durably ([a9c4416](https://github.com/hao1939/herdr-supervisor/commit/a9c441695ee40dffed2b3622bb57a09d6b2ee9ad))


### Bug Fixes

* allow peer status during reviews ([99b7416](https://github.com/hao1939/herdr-supervisor/commit/99b74160598edf264f6fe3a9ad26542d192922fb))
* bind workers before delivering goals ([62a29d9](https://github.com/hao1939/herdr-supervisor/commit/62a29d9942f94da60155a16489e9914ad4e11299))
* bootstrap native Codex identity safely ([1111b36](https://github.com/hao1939/herdr-supervisor/commit/1111b3617f37ad14e722f36e2b27f81c47ead382))
* bound all preserved decision evidence ([228f8e8](https://github.com/hao1939/herdr-supervisor/commit/228f8e8a21ce41c5a78d618036ad20fc79f71911))
* bound restart-safe worker names ([0172998](https://github.com/hao1939/herdr-supervisor/commit/0172998f8ba9d948267243e6ee3268219ca6e3a7))
* compare retries against explicit review time ([df51cf0](https://github.com/hao1939/herdr-supervisor/commit/df51cf06d8ac17d69e59818fa0afb815702b73ee))
* continue restored workers automatically ([318381f](https://github.com/hao1939/herdr-supervisor/commit/318381fcbafd90478b606d2c2fe34347ecae8988))
* coordinate shared worker waits ([9b45c55](https://github.com/hao1939/herdr-supervisor/commit/9b45c553d0574f3375444aa07da1350554b65eb1))
* distinguish goal state from worker state ([a8b1be2](https://github.com/hao1939/herdr-supervisor/commit/a8b1be28f83bfb64d834023eb0cef227ffbe79ad))
* isolate execution worktrees by goal ([14f90ce](https://github.com/hao1939/herdr-supervisor/commit/14f90cefb3372fa5e95b6e8ff623920c7c3add0e))
* keep broad goals open beyond milestones ([0a1bdc8](https://github.com/hao1939/herdr-supervisor/commit/0a1bdc8b271db1278299df5dd44c84497b31e01b))
* keep retry evidence in review context ([7965231](https://github.com/hao1939/herdr-supervisor/commit/7965231781f6426d75e06031da5f2bd8dbde9cc3))
* keep waiting goals moving ([817bfda](https://github.com/hao1939/herdr-supervisor/commit/817bfda79a450376a71e78859589330206e01b9b))
* let supervisor coordinate peer goals ([d3cf559](https://github.com/hao1939/herdr-supervisor/commit/d3cf5595b2829e3281aa29118ef2ffd5ed488fb7))
* let supervisor resume goal work selectively ([0b0f2f8](https://github.com/hao1939/herdr-supervisor/commit/0b0f2f81dcb669a010cf41c165eb364bcedaeca2))
* make Codex sandboxing the container default ([bebd8dc](https://github.com/hao1939/herdr-supervisor/commit/bebd8dc181f69f9b6e695fec2f8fd91b8a7f8fed))
* preserve bounded waits with invalid peer hints ([c6370f4](https://github.com/hao1939/herdr-supervisor/commit/c6370f43f064f38c1b9c8f61b84b1fdb4f967fd7))
* preserve current evidence for supervisor decisions ([6cdb13c](https://github.com/hao1939/herdr-supervisor/commit/6cdb13cbff6d73b632450725838d62e99814eda8))
* preserve pending human decisions on restart ([e5d6147](https://github.com/hao1939/herdr-supervisor/commit/e5d6147b09ec2c7d882b018f359053f711998d2e))
* preserve supervision across runtime restart ([2e73138](https://github.com/hao1939/herdr-supervisor/commit/2e73138287b66635499fa61ce7a9238fe6cbce4e))
* prioritize worker identity in status ([598eda5](https://github.com/hao1939/herdr-supervisor/commit/598eda57ac06556bb3b0cb7afaf3f2f21154f833))
* reconsider all workers affected by new evidence ([a6b8204](https://github.com/hao1939/herdr-supervisor/commit/a6b8204a5d5510ed1a3e327246be0ea29db20162))
* refuse to leave idle workers working ([fc6f272](https://github.com/hao1939/herdr-supervisor/commit/fc6f272b700215ffbeee48731a13de519d360664))
* remove $schema from release-please manifest ([08e55c4](https://github.com/hao1939/herdr-supervisor/commit/08e55c4ad85241aa7c8aeddfcdee63814505f8ae))
* require deadlines for settled worker waits ([f6d2c3d](https://github.com/hao1939/herdr-supervisor/commit/f6d2c3ddd690e78f08976e46166af91ff0be5d26))
* require fresh evidence at expired waits ([b455ca3](https://github.com/hao1939/herdr-supervisor/commit/b455ca333b12664651fbc64d121764b5b4d9a290))
* reserve human input for real authority gaps ([17133a1](https://github.com/hao1939/herdr-supervisor/commit/17133a1499ddd143ea3409632506aa55ae579e53))
* restart the supervisor after runtime failure ([14cdda9](https://github.com/hao1939/herdr-supervisor/commit/14cdda9bc506917f587f0e62bd53219c42254cb5))
* restore waits and continue workers reliably ([e130683](https://github.com/hao1939/herdr-supervisor/commit/e130683fc48c4aeee0a883584b451cbebbe5f8d7))
* resume supervised workers unattended ([f9d0d33](https://github.com/hao1939/herdr-supervisor/commit/f9d0d338bfcefd47a9d108985a971f18cdcabf11))
* resume workers in their session directory ([944d12c](https://github.com/hao1939/herdr-supervisor/commit/944d12c29791426952a492fc91139ee783f240af))
* retain human steering during worker reviews ([788a3b5](https://github.com/hao1939/herdr-supervisor/commit/788a3b5d629462409be9bf9a6310eac47c29a657))
* review restored idle workers once ([5a118a4](https://github.com/hao1939/herdr-supervisor/commit/5a118a4cd4fdda81b25a8ce1a420429d95bf86b2))
* show and resolve persisted human waits ([95161e7](https://github.com/hao1939/herdr-supervisor/commit/95161e7de10d9e552acb3b03580e85c6b082c1ab))
* show concrete waits in worker status ([1100463](https://github.com/hao1939/herdr-supervisor/commit/1100463450610c84a31276801b9299e1fd6c64c6))


### Performance Improvements

* bound all-worker status context ([1c02362](https://github.com/hao1939/herdr-supervisor/commit/1c0236211dcf907584a330c1d8c183cbe0cdb614))
* bound automated review context ([dbec2b9](https://github.com/hao1939/herdr-supervisor/commit/dbec2b943696003604927592e5417da6975c547b))
* keep healthy workers quiet on restart ([dfc5783](https://github.com/hao1939/herdr-supervisor/commit/dfc578317b778e07cf0504678b35b7a3efa081cf))

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
