import { StorageManager } from "../storage/db.js";
import { ConsentGate, type DataCategory, type Granularity } from "./consent.js";
import { PIIRedactor } from "./redactor.js";
import { DataAggregator } from "./aggregator.js";
import { AuditLogger, type AuditEntry } from "./audit.js";

export interface FilterResult<T = unknown> {
  data: T;
  denied: DataCategory[];
  wasAggregated: boolean;
  wasRedacted: boolean;
  recordCount: number;
}

export class PrivacyLayer {
  readonly consent: ConsentGate;
  readonly redactor: PIIRedactor;
  readonly aggregator: DataAggregator;
  readonly audit: AuditLogger;

  constructor(storage: StorageManager) {
    this.consent = new ConsentGate(storage);
    this.redactor = new PIIRedactor();
    this.aggregator = new DataAggregator();
    this.audit = new AuditLogger(storage);
  }

  filter<T>(
    data: T,
    toolName: string,
    categories: DataCategory[],
  ): FilterResult<T> {
    // 1. Check consent
    const { allowed, denied } = this.consent.checkAccess(categories);

    if (allowed.length === 0) {
      this.audit.log({
        tool_name: toolName,
        data_categories: categories,
        record_count: 0,
        was_aggregated: false,
        was_redacted: false,
      });
      return {
        data: null as T,
        denied,
        wasAggregated: false,
        wasRedacted: false,
        recordCount: 0,
      };
    }

    // 2. Apply PII redaction
    const { data: redacted, fieldsRedacted } = this.redactor.redact(data);
    const wasRedacted = fieldsRedacted.length > 0;

    // 3. Apply aggregation based on granularity
    let result = redacted;
    let wasAggregated = false;
    let recordCount = 1;

    if (Array.isArray(redacted)) {
      recordCount = redacted.length;
      // Use the most restrictive granularity among the allowed categories
      const granularity = this.getMostRestrictive(allowed);
      if (granularity !== "raw") {
        result = this.aggregator.aggregate(
          redacted as Record<string, unknown>[],
          granularity,
        ) as T;
        wasAggregated = true;
      }
    }

    // 4. Log the access
    this.audit.log({
      tool_name: toolName,
      data_categories: categories,
      record_count: recordCount,
      was_aggregated: wasAggregated,
      was_redacted: wasRedacted,
    });

    return {
      data: result as T,
      denied,
      wasAggregated,
      wasRedacted,
      recordCount,
    };
  }

  private getMostRestrictive(categories: DataCategory[]): Granularity {
    const order: Granularity[] = ["summary", "aggregated", "raw"];

    let mostRestrictive: Granularity = "raw";
    for (const cat of categories) {
      const g = this.consent.getGranularity(cat);
      if (order.indexOf(g) < order.indexOf(mostRestrictive)) {
        mostRestrictive = g;
      }
    }
    return mostRestrictive;
  }

  formatDeniedMessage(denied: DataCategory[]): string {
    if (denied.length === 0) return "";
    const list = denied.join(", ");
    return `Data sharing is disabled for: ${list}. Use the set_privacy_scope tool to change this.`;
  }
}

export { ConsentGate, type DataCategory, type Granularity } from "./consent.js";
export { PIIRedactor } from "./redactor.js";
export { DataAggregator } from "./aggregator.js";
export { AuditLogger } from "./audit.js";
