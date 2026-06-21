import type { StorageBackend } from "./backend.js";

async function load(name: string): Promise<any> {
  return import(name);
}

/**
 * Azure Blob Storage backend. Auth uses `DefaultAzureCredential` (OAuth via
 * `az login`, managed identity, env, etc.) — no keys stored by GitManager.
 * Requires the optional `@azure/storage-blob` and `@azure/identity` deps.
 */
export class AzureBackend implements StorageBackend {
  readonly id = "azure";
  readonly label: string;
  private container: any = null;

  constructor(
    private account: string,
    private containerName: string,
  ) {
    this.label = `Azure Blob (${account}/${containerName})`;
  }

  private async client(): Promise<any> {
    if (!this.container) {
      const blob = await load("@azure/storage-blob");
      const identity = await load("@azure/identity");
      const svc = new blob.BlobServiceClient(
        `https://${this.account}.blob.core.windows.net`,
        new identity.DefaultAzureCredential(),
      );
      this.container = svc.getContainerClient(this.containerName);
    }
    return this.container;
  }

  async isReady(): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      const c = await this.client();
      await c.createIfNotExists();
      return { ok: true };
    } catch (e) {
      return {
        ok: false,
        reason: `Azure not reachable — run \`az login\` (and check the account/container): ${(e as Error).message}`,
      };
    }
  }

  async put(key: string, data: Buffer): Promise<void> {
    const c = await this.client();
    await c.getBlockBlobClient(key).uploadData(data);
  }

  async get(key: string): Promise<Buffer | null> {
    const c = await this.client();
    try {
      return (await c.getBlockBlobClient(key).downloadToBuffer()) as Buffer;
    } catch {
      return null;
    }
  }

  async del(key: string): Promise<void> {
    const c = await this.client();
    try {
      await c.getBlockBlobClient(key).deleteIfExists();
    } catch {
      // already gone
    }
  }
}
