# Contributor guidance

Read `docs/design.md` and `.github/copilot-instructions.md` before changing the
supervisor. They define the current architecture and review rules.

Before changing `src/event-watcher/`, also read its colocated `README.md`. It
defines the one-way source-adapter and worker-notification boundary.

Keep one core loop:

`observe -> decide -> act -> remember -> wake`

Herdr owns runtime truth. Code gathers facts, validates identity and effects,
and records the latest checkpoint. The model decides what those facts mean for
the goal.

Before adding runtime behavior, answer these questions from current evidence:

1. Can the agent handle the case with existing observation and action tools?
2. Will an existing event or bounded health check reliably wake the agent?
3. Does the agent receive enough goal context, current evidence, and durable
   knowledge to decide well?

If all three answers are yes, do not add code. Improve the goal, prompt, or
documentation when needed and use the existing path. If the proposal is only a
cost optimization, measure the live frequency and cost first, then compare that
benefit with every new state, action path, recovery case, and race it creates.

Add only the smallest reusable missing deterministic primitive. Do not add a
task graph, durable queue, keyword router, parallel source of runtime truth, or
a second action path for behavior the ordinary focused review already handles.
Prefer occasional repeated work after restart over complex perfect recovery.

Keep changes focused. Review the final diff, add tests for the actual invariant,
run `npm run check` and `npm test`, use plain language in documentation and pull
requests, and validate material runtime behavior in the live experiment before
calling it proven.
