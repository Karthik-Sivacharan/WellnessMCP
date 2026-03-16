import { StorageManager } from "../storage/db.js";

export interface AuditEntry {
  tool_name: string;
  data_categories: string[];
  record_count: number;
  was_aggregated: boolean;
  was_redacted: boolean;
  client_info?: string;
}

export class AuditLogger {
  constructor(private storage: StorageManager) {}

  log(entry: AuditEntry): void {
    this.storage.logAccess(entry);
  }

  getLog(limit = 100): Array<{
    id: number;
    timestamp: string;
    tool_name: string;
    data_categories: string[];
    record_count: number;
    was_aggregated: boolean;
    was_redacted: boolean;
    client_info: string | null;
  }> {
    const rows = this.storage.getAuditLog(limit);
    return rows.map((r) => ({
      id: r.id as number,
      timestamp: r.timestamp as string,
      tool_name: r.tool_name as string,
      data_categories: JSON.parse(r.data_categories as string),
      record_count: r.record_count as number,
      was_aggregated: Boolean(r.was_aggregated),
      was_redacted: Boolean(r.was_redacted),
      client_info: (r.client_info as string) ?? null,
    }));
  }
}
