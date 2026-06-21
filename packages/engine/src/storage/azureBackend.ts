import type { StorageBackend } from "./backend.js";
import { loadDep, MissingDepError } from "./optionalDep.js";

/**
 * How long any single Azure operation (auth + request) may take before we give
 * up. Without this, a stalled `DefaultAzureCredential` token probe or a hung
 * upload freezes the whole backup with no error. Override with
 * GITMANAGER_AZURE_TIMEOUT_MS.
 */
const OP_TIMEOUT_MS = Number(process.env.GITMANAGER_AZURE_TIMEOUT_MS) || 120_000;

/** An abort signal that fires after `OP_TIMEOUT_MS`. */
function timeoutSignal(): AbortSignal {
  return AbortSignal.timeout(OP_TIMEOUT_MS);
}

/**
 * Normalize an Azure SDK error. A real abort/timeout becomes a clear message;
 * any other error (e.g. a 403 AuthorizationPermissionMismatch on blob write) is
 * returned with its `code`/`statusCode` intact so callers can surface it.
 */
function azureError(e: unknown): Error {
  const err = e as Error & { code?: string; statusCode?: number };
  const isTimeout =
    err?.name === "AbortError" ||
    err?.name === "TimeoutError" ||
    /\baborted\b|\btimeout\b/i.test(err?.message ?? "");
  if (isTimeout) {
    return new Error(
      `Azure operation timed out after ${OP_TIMEOUT_MS}ms. Check network/credentials ` +
        `(\`az login\`) or raise GITMANAGER_AZURE_TIMEOUT_MS.`,
    );
  }
  // Make sure a data-plane permission error is unmistakable.
  if (err?.statusCode === 403 || /AuthorizationPermissionMismatch/i.test(err?.message ?? "")) {
    err.message =
      `Azure denied the write (403). The signed-in identity can reach the container but ` +
      `lacks data-plane write access — assign the "Storage Blob Data Contributor" role on ` +
      `the storage account/container. (${err.message})`;
  }
  return err;
}

/**
 * Azure Blob Storage backend. Auth uses `DefaultAzureCredential` (OAuth via
 * `az login`, managed identity, env, etc.) — no keys stored by GitManager.
 * Uses `@azure/storage-blob` and `@azure/identity` (regular deps, loaded lazily).
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
      const blob = await loadDep("@azure/storage-blob");
      const identity = await loadDep("@azure/identity");
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
      await c.createIfNotExists({ abortSignal: timeoutSignal() });
      return { ok: true };
    } catch (e) {
      if (e instanceof MissingDepError) return { ok: false, reason: e.message };
      return {
        ok: false,
        reason: `Azure not reachable — run \`az login\` (and check the account/container): ${azureError(e).message}`,
      };
    }
  }

  async put(key: string, data: Buffer): Promise<void> {
    const c = await this.client();
    try {
      await c.getBlockBlobClient(key).uploadData(data, { abortSignal: timeoutSignal() });
    } catch (e) {
      throw azureError(e);
    }
  }

  async get(key: string): Promise<Buffer | null> {
    const c = await this.client();
    try {
      return (await c
        .getBlockBlobClient(key)
        .downloadToBuffer(0, undefined, { abortSignal: timeoutSignal() })) as Buffer;
    } catch {
      return null;
    }
  }

  async del(key: string): Promise<void> {
    const c = await this.client();
    try {
      await c.getBlockBlobClient(key).deleteIfExists({ abortSignal: timeoutSignal() });
    } catch {
      // already gone
    }
  }
}
