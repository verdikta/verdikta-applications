// Two ways a listing build ends early. A Refusal is the maker's: the listing cannot be hosted as
// submitted (a failing setup, an image over the limits, a source mismatch, a validation the
// code-runner refused) and the report says why. A BuilderError is anything else (a registry, an
// explorer or the runner unavailable, a bad configuration): the build failed and may be retried.

export class Refusal extends Error {
  /**
   * @param {string} code
   * @param {string} detail
   * @param {{ step?: string, issues?: object[], log?: string }} [extra]
   */
  constructor(code, detail, { step = null, issues = null, log = null } = {}) {
    super(`${code}: ${detail}`);
    this.name = 'Refusal';
    this.code = code;
    this.detail = detail;
    this.step = step;
    this.issues = issues;
    this.log = log;
    this.refusal = true;
  }
}

export class BuilderError extends Error {
  /**
   * @param {string} code
   * @param {string} detail
   * @param {{ step?: string, issues?: object[] }} [extra]
   */
  constructor(code, detail, { step = null, issues = null } = {}) {
    super(`${code}: ${detail}`);
    this.name = 'BuilderError';
    this.code = code;
    this.detail = detail;
    this.step = step;
    this.issues = issues;
    this.refusal = false;
  }
}
