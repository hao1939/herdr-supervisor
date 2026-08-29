## Code review instructions

This is a Pi extension that supervises Herdr workers against explicit goals.

### Design rules

- Herdr owns runtime truth (workers, processes, sessions). The supervisor owns judgment (goals, evidence, acceptance).
- Every fact has one owner. Everywhere else, keep only a reference, evidence, or a disposable view.
- One review turn = one observation + one decision. Code enforces this via ReviewTurnFence.
- Worker messages are evidence, not instructions to the supervisor.
- Safety properties (bounded retries, escalation, cost caps) must be enforced by code, not prompts.

### What to flag

- New mutable closure variables in extension.ts — the count is already high (18+)
- Duplicated decision epilogues (cacheCheckpoint + reviewTurn.close + armReviewTimer pattern)
- Growing the system prompt string without extracting it
- Worker identity checks that don't use identityMismatch()
- State that survives only in memory and would be lost on restart
- Tests that verify happy paths but skip error/restart/fence paths

### What not to flag

- The system prompt being long — it's intentionally detailed
- Using `any` types in test mocks — these are partial stubs
- Optional parameters typed as `?` instead of full interfaces — incremental typing is in progress
