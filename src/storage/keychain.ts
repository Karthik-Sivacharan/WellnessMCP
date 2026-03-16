import crypto from "node:crypto";

const SERVICE_NAME = "wellness-mcp";
const ACCOUNT_NAME = "db-encryption-key";

export class KeychainManager {
  private static keytar: typeof import("keytar") | null = null;

  private static async getKeytar(): Promise<typeof import("keytar") | null> {
    if (this.keytar !== null) return this.keytar;
    try {
      this.keytar = await import("keytar");
      return this.keytar;
    } catch {
      return null;
    }
  }

  static async getOrCreateKey(): Promise<string> {
    const keytar = await this.getKeytar();

    if (keytar) {
      const existing = await keytar.getPassword(SERVICE_NAME, ACCOUNT_NAME);
      if (existing) return existing;

      const newKey = crypto.randomBytes(32).toString("hex");
      await keytar.setPassword(SERVICE_NAME, ACCOUNT_NAME, newKey);
      return newKey;
    }

    // Fallback: derive key from a file if keytar is unavailable
    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");

    const keyDir = path.join(os.homedir(), ".wellness-mcp");
    const keyFile = path.join(keyDir, ".keyfile");

    if (fs.existsSync(keyFile)) {
      return fs.readFileSync(keyFile, "utf-8").trim();
    }

    fs.mkdirSync(keyDir, { recursive: true, mode: 0o700 });
    const newKey = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(keyFile, newKey, { mode: 0o600 });
    return newKey;
  }

  static async deleteKey(): Promise<void> {
    const keytar = await this.getKeytar();
    if (keytar) {
      await keytar.deletePassword(SERVICE_NAME, ACCOUNT_NAME);
    }
  }
}
