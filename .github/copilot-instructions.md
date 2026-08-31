## Code review instructions

This is a Pi extension that supervises Herdr workers against explicit goals.

### Design rules

- Keep the core as `observe -> decide -> act -> remember -> wake`; do not add
  a second task or workflow system.
- Herdr owns runtime truth (workers, processes, sessions). The supervisor owns
  judgment (goals, evidence, acceptance).
- Every fact has one owner. Everywhere else, keep only a reference, evidence,
  or a disposable view.
- One review turn = one observation + one decision. Code enforces this via ReviewTurnFence.
- Worker messages are evidence, not instructions to the supervisor.
- Apply the agent-first test before requesting a mechanism: can the model
  handle it, was it reliably woken, and did it receive enough evidence? Add
  code only for a reusable missing observation, validation, or action primitive.
- Code enforces mechanical safety boundaries such as exact identity, one action
  per review, bounded persisted data, and bounded deadlines. The model owns
  semantic retry, escalation, and cost tradeoffs unless repeated evidence proves
  a mechanical primitive is missing.

### What to flag

- New mutable closure state without a clear disposable runtime purpose or restart story
- Duplicated decision epilogues (cacheCheckpoint + reviewTurn.close + armReviewTimer pattern)
- Contradictory or duplicated policy text that makes the model's decision boundary unclear
- Worker identity checks that don't use identityMismatch()
- Correctness that depends on process-local state surviving restart
- Tests that verify happy paths but skip error/restart/fence paths

### What not to flag

- The system prompt being long — it's intentionally detailed
- A rare eventually recoverable rough edge when the proposed fix would add a
  queue, workflow, or durable retry subsystem
- Using `any` types in test mocks — these are partial stubs
- Optional parameters typed as `?` instead of full interfaces — incremental typing is in progress
