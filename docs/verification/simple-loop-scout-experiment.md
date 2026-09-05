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

The next candidate adds one short supervisor rule: before extending a peer
wait, inspect current peer status and reconsider pending peer work through the
existing action. A settled process or absent new output from the waiting worker
does not prove that the peer condition stayed unchanged. Prior waits and
one-turn steering do not create new durable restrictions. The design now makes
the same distinction. No scheduling or persisted state was added.
