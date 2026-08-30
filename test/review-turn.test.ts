import assert from "node:assert/strict";
import test from "node:test";
import { ReviewTurnFence } from "../src/review-turn.ts";

test("one fence owns both review preparation and the active turn", () => {
  const turn = new ReviewTurnFence();
  turn.prepare("w1:p2");
  assert.equal(turn.isPreparing("w1:p2"), true);
  assert.equal(turn.isBusy("w1:p2"), true);

  turn.begin("w1:p2", "the watched build changed");
  assert.equal(turn.isPreparing(), false);
  assert.equal(turn.isActive("w1:p2"), true);
  assert.equal(turn.reason, "the watched build changed");
  turn.finishPreparing();
  assert.equal(turn.isActive("w1:p2"), true);

  turn.end();
  assert.equal(turn.isBusy(), false);
  assert.equal(turn.reason, undefined);
});

test("an automated review can observe only its exact worker once", () => {
  const turn = new ReviewTurnFence();
  turn.begin("w1:p2");

  assert.match(turn.beginObservation("w1:p3"), /scoped to w1:p2/);
  assert.equal(turn.beginObservation("w1:p2"), undefined);
  turn.finishObservation(true);
  assert.match(turn.beginObservation("w1:p2"), /already observed once/);
});

test("a failed observation may be retried in the same review", () => {
  const turn = new ReviewTurnFence();
  turn.begin("w1:p2");
  assert.equal(turn.beginObservation("w1:p2"), undefined);
  turn.finishObservation(false);
  assert.equal(turn.beginObservation("w1:p2"), undefined);
});

test("steering or accepting requires evidence and closes tool use", () => {
  const turn = new ReviewTurnFence();
  turn.begin("w1:p2");
  assert.match(turn.guardDecision("w1:p2"), /Observe w1:p2 once/);
  assert.equal(turn.beginObservation("w1:p2"), undefined);
  turn.finishObservation(true);
  assert.equal(turn.isClosed(), false);
  assert.equal(turn.guardDecision("w1:p2"), undefined);
  turn.close();
  assert.equal(turn.isClosed(), true);
  assert.match(turn.guard("w1:p2"), /already applied/);
  assert.match(turn.beginObservation("w1:p2"), /already applied/);
  assert.match(turn.guardDecision("w1:p2"), /already applied/);
});

test("settlement resets the fence for the next event-driven review", () => {
  const turn = new ReviewTurnFence();
  turn.begin("w1:p2");
  assert.equal(turn.beginObservation("w1:p2"), undefined);
  turn.finishObservation(true);
  turn.close();
  turn.end();
  turn.begin("w1:p2");
  assert.equal(turn.beginObservation("w1:p2"), undefined);
});

test("a human-initiated steering decision also closes its turn", () => {
  const turn = new ReviewTurnFence();
  assert.equal(turn.guardDecision("w1:p2"), undefined);
  turn.close("w1:p2");
  assert.match(turn.guard("w1:p2"), /already applied/);
});
