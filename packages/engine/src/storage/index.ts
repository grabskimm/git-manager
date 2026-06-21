import type { BackendConfig, StorageBackend } from "./backend.js";
import { FsBackend } from "./fsBackend.js";
import { S3Backend } from "./s3Backend.js";
import { R2Backend } from "./r2Backend.js";
import { AzureBackend } from "./azureBackend.js";

/** Construct a backend instance from its config entry. */
export function backendFromConfig(cfg: BackendConfig): StorageBackend {
  switch (cfg.id) {
    case "fs":
      return new FsBackend(cfg.dir);
    case "s3":
      return new S3Backend(cfg.bucket, { region: cfg.region, endpoint: cfg.endpoint });
    case "r2":
      return new R2Backend(cfg.bucket);
    case "azure":
      return new AzureBackend(cfg.account, cfg.container);
  }
}

export * from "./backend.js";
