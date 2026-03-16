import { StorageManager } from "../storage/db.js";
import type { SyncResult, ProviderName } from "./types.js";

export abstract class HealthProvider {
  abstract readonly name: ProviderName;
  abstract readonly displayName: string;

  constructor(protected storage: StorageManager) {}

  abstract isConfigured(): boolean;
  abstract connect(config?: Record<string, string>): Promise<void>;
  abstract sync(startDate?: string, endDate?: string): Promise<SyncResult>;

  getLastSync(): string | null {
    const device = this.storage.getDevice(this.name);
    return device ? (device.last_sync as string) : null;
  }

  protected updateSyncTime(): void {
    this.storage.updateDeviceSync(this.name);
  }
}

export class ProviderRegistry {
  private providers = new Map<ProviderName, HealthProvider>();

  constructor(private storage: StorageManager) {}

  register(provider: HealthProvider): void {
    this.providers.set(provider.name, provider);
  }

  get(name: ProviderName): HealthProvider | undefined {
    return this.providers.get(name);
  }

  getAll(): HealthProvider[] {
    return [...this.providers.values()];
  }

  getConfigured(): HealthProvider[] {
    return this.getAll().filter((p) => p.isConfigured());
  }

  async syncAll(startDate?: string, endDate?: string): Promise<SyncResult[]> {
    const results: SyncResult[] = [];
    for (const provider of this.getConfigured()) {
      try {
        results.push(await provider.sync(startDate, endDate));
      } catch (err) {
        results.push({
          provider: provider.name,
          success: false,
          recordsSynced: 0,
          errors: [err instanceof Error ? err.message : String(err)],
          categories: [],
        });
      }
    }
    return results;
  }
}
