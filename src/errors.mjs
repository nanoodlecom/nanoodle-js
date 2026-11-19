/** Base error for everything nanoodle throws deliberately. */
export class NanoodleError extends Error {
  /**
   * @param {string} message
   * @param {object} [props] extra fields (e.g. { code: "auth" | "blocked" | "funds" | "http", status })
   */
  constructor(message, props = {}) {
    super(message);
    this.name = "NanoodleError";
    Object.assign(this, props);
  }
}

/** A node in the graph cannot be executed by this library (browser-only media op / unknown type). */
export class UnsupportedNodeError extends NanoodleError {
  constructor(message, props = {}) {
    super(message, props);
    this.name = "UnsupportedNodeError";
  }
}

/**
 * run() rejects with this when a sink (output) node failed.
 * `.result` carries the partial RunResult (successful lanes, per-node errors, cost so far).
 */
export class RunError extends NanoodleError {
  constructor(message, result, props = {}) {
    super(message, props);
    this.name = "RunError";
    this.result = result;
  }
}
