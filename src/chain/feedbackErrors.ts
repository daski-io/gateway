export type FeedbackSubmissionFailure =
  | "reverted"
  | "succeeded_without_event"
  | "malformed_event";

/**
 * A definitive on-chain outcome that cannot be repaired by retrying the same
 * feedback transaction.
 */
export class FeedbackSubmissionError extends Error {
  constructor(
    readonly failure: FeedbackSubmissionFailure,
    message: string,
  ) {
    super(message);
    this.name = "FeedbackSubmissionError";
  }
}

export class FeedbackAlreadyRevokedError extends Error {
  constructor() {
    super("feedback is already revoked");
    this.name = "FeedbackAlreadyRevokedError";
  }
}
