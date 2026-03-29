/**
 * @module privacy
 *
 * Simplified privacy layer for the stateless proxy server.
 * Only performs PII redaction — no consent gates or audit logging
 * since there's no persistent storage.
 */
import { PIIRedactor } from "./redactor.js";

export class PrivacyLayer {
  readonly redactor: PIIRedactor;

  constructor() {
    this.redactor = new PIIRedactor();
  }

  /**
   * Redacts PII from health data before sending to the LLM.
   * Returns the redacted data and a flag indicating if redaction occurred.
   */
  redact<T>(data: T): { data: T; wasRedacted: boolean } {
    const { data: redacted, fieldsRedacted } = this.redactor.redact(data);
    return { data: redacted as T, wasRedacted: fieldsRedacted.length > 0 };
  }
}

export { PIIRedactor } from "./redactor.js";
