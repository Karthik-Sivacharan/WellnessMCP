import { StorageManager } from "../storage/db.js";

export type DataCategory = "sleep" | "activity" | "vitals" | "body_composition" | "glucose" | "health_metrics" | "devices";
export type Granularity = "raw" | "aggregated" | "summary";

export interface ConsentScope {
  category: DataCategory;
  enabled: boolean;
  granularity: Granularity;
}

export class ConsentGate {
  constructor(private storage: StorageManager) {}

  getScopes(): ConsentScope[] {
    const rows = this.storage.getConsentScopes();
    return rows.map((r) => ({
      category: r.category as DataCategory,
      enabled: Boolean(r.enabled),
      granularity: (r.granularity as Granularity) ?? "aggregated",
    }));
  }

  getScope(category: DataCategory): ConsentScope {
    const scopes = this.getScopes();
    return scopes.find((s) => s.category === category) ?? {
      category,
      enabled: true,
      granularity: "aggregated",
    };
  }

  isAllowed(category: DataCategory): boolean {
    return this.getScope(category).enabled;
  }

  getGranularity(category: DataCategory): Granularity {
    return this.getScope(category).granularity;
  }

  setScope(category: DataCategory, enabled: boolean, granularity: Granularity): void {
    this.storage.setConsentScope(category, enabled, granularity);
  }

  checkAccess(categories: DataCategory[]): { allowed: DataCategory[]; denied: DataCategory[] } {
    const allowed: DataCategory[] = [];
    const denied: DataCategory[] = [];

    for (const cat of categories) {
      if (this.isAllowed(cat)) {
        allowed.push(cat);
      } else {
        denied.push(cat);
      }
    }

    return { allowed, denied };
  }
}
