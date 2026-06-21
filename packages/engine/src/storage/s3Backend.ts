import type { StorageBackend } from "./backend.js";

/** Dynamic import that doesn't require the module to be installed at build time. */
async function load(name: string): Promise<any> {
  return import(name);
}

async function streamToBuffer(body: any): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  if (typeof body.transformToByteArray === "function") {
    return Buffer.from(await body.transformToByteArray());
  }
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Buffer>) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/**
 * AWS S3 (and any S3-compatible endpoint) backend. Credentials come from the AWS
 * SDK's default provider chain — env, shared config, and SSO/OAuth (`aws sso
 * login`) — so no static keys are stored by GitManager. Requires the optional
 * `@aws-sdk/client-s3` dependency.
 */
export class S3Backend implements StorageBackend {
  readonly id = "s3";
  readonly label: string;
  private client: any = null;

  constructor(
    private bucket: string,
    private opts: { region?: string; endpoint?: string } = {},
  ) {
    this.label = `S3 (${bucket}${opts.endpoint ? ` @ ${opts.endpoint}` : ""})`;
  }

  private async sdk(): Promise<any> {
    const mod = await load("@aws-sdk/client-s3");
    if (!this.client) {
      this.client = new mod.S3Client({
        region: this.opts.region || process.env.AWS_REGION || "us-east-1",
        ...(this.opts.endpoint ? { endpoint: this.opts.endpoint, forcePathStyle: true } : {}),
      });
    }
    return mod;
  }

  async isReady(): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      const mod = await this.sdk();
      await this.client.send(new mod.HeadBucketCommand({ Bucket: this.bucket }));
      return { ok: true };
    } catch (e) {
      return {
        ok: false,
        reason: `S3 not reachable (install @aws-sdk/client-s3 and run \`aws sso login\`/configure creds): ${(e as Error).message}`,
      };
    }
  }

  async put(key: string, data: Buffer): Promise<void> {
    const mod = await this.sdk();
    await this.client.send(
      new mod.PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data }),
    );
  }

  async get(key: string): Promise<Buffer | null> {
    const mod = await this.sdk();
    try {
      const res = await this.client.send(
        new mod.GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return await streamToBuffer(res.Body);
    } catch (e) {
      if ((e as { name?: string }).name === "NoSuchKey") return null;
      return null;
    }
  }

  async del(key: string): Promise<void> {
    const mod = await this.sdk();
    await this.client.send(new mod.DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
