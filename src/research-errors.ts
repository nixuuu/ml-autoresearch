export class RecoverableResearcherError extends Error {
  readonly code: string;

  constructor(message: string, code = "researcher_protocol_error") {
    super(message);
    this.name = "RecoverableResearcherError";
    this.code = code;
  }
}
