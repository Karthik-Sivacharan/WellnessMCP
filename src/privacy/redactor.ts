const DEFAULT_PII_FIELDS = new Set([
  "name", "email", "phone", "dob", "date_of_birth", "birth_date",
  "address", "gps", "latitude", "longitude", "serial_number",
  "device_id", "mac_address", "ssn", "social_security",
  "first_name", "last_name", "full_name",
]);

const PII_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // Email
  { pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, replacement: "[EMAIL_REDACTED]" },
  // Phone (US formats)
  { pattern: /(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g, replacement: "[PHONE_REDACTED]" },
  // SSN
  { pattern: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: "[SSN_REDACTED]" },
  // GPS coordinates
  { pattern: /-?\d{1,3}\.\d{4,},\s*-?\d{1,3}\.\d{4,}/g, replacement: "[GPS_REDACTED]" },
  // MAC address
  { pattern: /([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}/g, replacement: "[MAC_REDACTED]" },
];

export class PIIRedactor {
  private piiFields: Set<string>;

  constructor(extraFields?: string[]) {
    this.piiFields = new Set([...DEFAULT_PII_FIELDS, ...(extraFields ?? [])]);
  }

  redact<T>(data: T): { data: T; fieldsRedacted: string[] } {
    const fieldsRedacted: string[] = [];
    const redacted = this.redactValue(data, "", fieldsRedacted);
    return { data: redacted as T, fieldsRedacted };
  }

  private redactValue(value: unknown, path: string, fieldsRedacted: string[]): unknown {
    if (value === null || value === undefined) return value;

    if (typeof value === "string") {
      return this.redactString(value);
    }

    if (Array.isArray(value)) {
      return value.map((item, i) => this.redactValue(item, `${path}[${i}]`, fieldsRedacted));
    }

    if (typeof value === "object") {
      const obj = value as Record<string, unknown>;
      const result: Record<string, unknown> = {};

      for (const [key, val] of Object.entries(obj)) {
        const lowerKey = key.toLowerCase();
        if (this.piiFields.has(lowerKey)) {
          result[key] = "[REDACTED]";
          fieldsRedacted.push(path ? `${path}.${key}` : key);
        } else {
          result[key] = this.redactValue(val, path ? `${path}.${key}` : key, fieldsRedacted);
        }
      }

      return result;
    }

    return value;
  }

  private redactString(value: string): string {
    let result = value;
    for (const { pattern, replacement } of PII_PATTERNS) {
      result = result.replace(new RegExp(pattern.source, pattern.flags), replacement);
    }
    return result;
  }
}
