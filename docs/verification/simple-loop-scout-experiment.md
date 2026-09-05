# Simple supervision loop: local Scout experiment

Date: 2026-09-05. This is a bounded implementation and live-validation record,
not a new monitoring service or a Scout goal contract.

## Candidate and checks

Candidate `753eff1` removes runtime modes, calls checkpoint age by its correct
name, and exposes existing goal-read errors in global review. Findings may
name unreadable goals; focused actions still require a valid active binding.
No goal-state field, queue, dependency mechanism, or cadence rule was added.

Node 26.8.1: `npm run check`, `npm test` (308 passing), and `git diff --check`
passed. Regression coverage checks obsolete-setting rejection before tools are
installed, bounded read-error facts, findings on unreadable goals, rejection of
actions on those goals, and continued routing to healthy goals. Compose was
resolved with and without the obsolete environment variable: an explicit old
setting reaches the rejection guard; an unset setting supplies no value.

## Local baseline

The existing local Herdr 0.8.0 experiment had two active standing Scout goals:

| Role | Goal | Pane | Native Codex session |
|---|---|---|---|
| Producer | `g_c1b31972-1674-47cb-96d8-c797d768010d` | `w1:p6C` | `01a05c5f-cb03-7760-9c42-893d669f7762` |
| Reviewer | `g_8c5b597e-368d-4ced-b843-78aa4d796ea5` | `w1:p6G` | `01a062c7-709c-7552-b44f-631fa7c6d81d` |

Both workers were settled. Producer checkpoint revision 131 waited for review
of `764cb00eca907fdefcb96df2fdbf49dbfb08f85f`, with an overdue 07:10 UTC deadline.
Reviewer checkpoint revision 66 still described reviewed source
`a70923f523a51b9c15d2e324a3c4d10d38599380`, correction
`cf00aec105ba802f7fd784a17c1275a09dcf3a2d`, and cursor
`a3c3349ce19fc84dfd488cef444dc7a8b324a224`.

The initial portable contract SHA-256 values were:

- Producer: `5166350f43a6f2e5db0c5e6efa66f532dbe29c2b287e820e9aad347fe755b61a`.
- Reviewer: `092da973c2ef6031cb6b1c52be0347e45317bb39e096ea7dec8abab60a4fcd5b`.

## First live pass

The same saved Pi conversation was resumed with Node 26.8.1, Pi 0.85.0, its
existing provider/model settings, the Herdr lifecycle extension, and the
candidate extension from `/app/worktrees/herdr-supervisor-simple-loop`.
Quitting the previous Pi process also closed its pane `w1:p5G`; an ordinary new
tab supplied routing pane `w1:p6M`, named `supervisor`. The saved Pi session
`01a05c40-9d27-739c-b6c0-c8e3a5e79573` and both Scout sessions were preserved.

Initial Herdr snapshot requests timed out. Existing bounded retry recovered,
and a focused producer review started at 07:19:29 UTC. At 07:19:57 the normal
steer action resumed the exact producer native Goal and delivered a bounded
instruction. No new recovery code was needed.

The producer confirmed that the exact-tip review was absent. The supervisor
nevertheless repeated a wait on the inactive reviewer, then described that
state as a lifecycle-recovery blocker. Existing action guards rejected the
direct inactive-peer wait; they could not supply the missing semantic choice.
The reviewer had been left waiting despite a newer producer checkpoint.

At 07:21 UTC an ordinary supervisor message supplied the exact current producer
tip and older reviewer cursor and requested reconsideration of the existing
reviewer. The message was preserved as a human follow-up during the active
review and delivered after that review settled. This tests the existing input
fence as well as the ordinary reconsideration path. Subsequent results are
recorded below after verification.

At 07:22:07 the supervisor used its existing steer action to resume the exact
reviewer session. The reviewer recognized the range as new and began examining
its Git lineage and diff. This demonstrates that the missing next action was
available without a new runtime mechanism.

## Guidance adjustment

Candidate `39902f3` adds one short supervisor rule: before extending a peer
wait, inspect current peer status and reconsider pending peer work through the
existing action. A settled process or absent new output from the waiting worker
does not prove that the peer condition stayed unchanged. Prior waits and
one-turn steering do not create new durable restrictions. The design now makes
the same distinction. No scheduling or persisted state was added.

Pi's native `/reload` loaded this candidate into the same supervisor session at
07:23 UTC. The reload receipt was visible. One display-name refresh reported
`write EPIPE`; worker execution continued, so this did not justify another
recovery path. The full Supervisor suite still passed (308 tests).

The reviewer confirmed that both earlier reviewer commits were contained
verbatim in the producer tip. The remaining successor was documentation-only,
so it checked exact lineage and current-tip behavior in a reviewer-owned
worktree. At 07:26 UTC it reported the full Scout gate passing: 312 tests,
1,533 assertions, zero failures, 110 scoped links, and navigation checks of
11/14, 8/8, and 14/14. This is actual worker progress, not merely a scheduled
reconsideration receipt.

## Second live pass: remove a conflicting guard

The reviewer committed result `8f5b1a46665d6618b45624bdf8ae38a56875bb86`, a direct
child of reviewed producer tip `764cb00e…`. Its completion event automatically
woke the supervisor at 07:29:30 UTC. Both the first review and the existing
bounded retry tried to record a peer wait on the settled producer; both were
rejected. Neither routed the completed result onward. The guidance-only
candidate was therefore insufficient.

The rejected condition exposed a code-policy conflict: reconsideration queues
the peer's review until the current turn ends, but the guard required the peer
to be working before that turn could record its wait. Removed that activity
requirement. Exact peer identity and bounded deadlines remain validated; the
model judges whether a real peer condition is useful and requests existing
reconsideration. Guidance now covers creating as well as extending waits and
describes one successful decision rather than one attempted call.

The regression exercises this exact sequence: reject a replaced peer without
changing the checkpoint, restore the exact idle peer, queue its reconsideration,
record the real peer wait, and dispatch the peer review only after settlement.
There is no new queue, state field, dependency scheduler, or recovery path.

## Third live pass

Candidate `58e44c3` passed `npm run check` and all 308 tests, then was loaded by
`/reload` in the same Pi session. The ordinary startup review observed the
reviewer's pending result. At 07:32:50 UTC it successfully recorded reviewer
checkpoint revision 69 with the real producer goal as its peer dependency.
It did not request immediate producer reconsideration. The producer's existing
07:36 UTC bounded review remained the next wake; this tests that safety path
without another manual prompt or a new scheduling feature.

At 07:36:08 UTC the existing deadline automatically opened the producer review.
The supervisor recognized the old lifecycle blocker as stale from current peer
context and used the normal steer action at 07:36:24. The exact producer native
session resumed, checkpoint revision 134 cleared the obsolete wait, and the
producer actually inspected the reviewer commit, its direct-parent lineage,
full patch, finding dispositions, and local validation instructions. No further
human or management prompt was sent after the candidate reload.

This proves eventual handoff through the existing bounded path, not immediate
peer reconsideration: the accepted wait preceded continuation by about
3 minutes 35 seconds. That delay is visible and acceptable for this local
baseline; this experiment does not prove optimal scheduling or long-run Scout
research quality. The standing workers continue to own integration and later
research. Reopen improvement work if delays materially hurt throughput or the
same evidence stops producing useful action; do not preemptively add a
dependency scheduler.

## Scope and remaining limits

The runtime-source diff is a net reduction of 27 lines. There is one execution
path, no new persisted field, and no speculative progress metric or dependency
mechanism. The original repository and its unrelated changes were not edited;
the implementation lives on `refactor/simple-supervision-loop` in the isolated
worktree loaded by the local supervisor. Nothing was pushed or deployed
remotely.

Goal-read failures and routing isolation were exercised in temporary test
stores, not by corrupting the live experiment. A read-only snapshot of the real
store showed checkpoint age and no unreadable goals. The periodic global model
review was not due during this experiment, so its live handling of a corrupt
goal is not claimed as proven.

Both portable contract hashes remained identical to the baseline, both worker
native sessions were retained, and neither standing goal was completed. The
existing Herdr limitation around identity-conditioned TUI writes is unchanged.
The reload-time display-name `write EPIPE` warning recurred but did not prevent
the subsequent focused review; no recovery subsystem was added for it.
