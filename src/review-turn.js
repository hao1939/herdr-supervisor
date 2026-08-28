export class ReviewTurnFence {
  constructor() {
    this.end();
  }

  begin(paneId) {
    this.paneId = paneId;
    this.observing = false;
    this.observed = false;
    this.closed = false;
  }

  end() {
    this.paneId = undefined;
    this.observing = false;
    this.observed = false;
    this.closed = false;
  }

  guard(paneId) {
    if (!this.paneId) return;
    if (this.closed) {
      return "This review decision is already applied. End this turn and wait for Herdr's next event; do not poll.";
    }
    if (paneId && paneId !== this.paneId) {
      return `This review is scoped to ${this.paneId}, not ${paneId}. End this turn without inspecting another worker.`;
    }
  }

  beginObservation(paneId) {
    const error = this.guard(paneId);
    if (error) return error;
    if (!this.paneId) return;
    if (this.observing) {
      return "The one observation for this review is still running. Wait for its result; do not start another tool call.";
    }
    if (this.observed) {
      return "Worker evidence was already observed once in this review. End this turn and wait for Herdr's next event; do not poll.";
    }
    this.observing = true;
  }

  finishObservation(success) {
    if (!this.paneId || !this.observing) return;
    this.observing = false;
    if (success) this.observed = true;
  }

  guardDecision(paneId) {
    const error = this.guard(paneId);
    if (error) return error;
    if (!this.paneId) return;
    if (this.observing) return "Wait for the worker observation to finish before deciding.";
    if (!this.observed) return `Observe ${this.paneId} once before deciding.`;
  }

  close(paneId) {
    if (!this.paneId && paneId) this.paneId = paneId;
    if (this.paneId) this.closed = true;
  }

  isClosed() {
    return this.closed;
  }
}
