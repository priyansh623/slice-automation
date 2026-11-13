import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ObjectExistsError, ObjectNotFoundError, type BucketName, type ObjectInfo, type PutOptions, type SignedUpload, type StorageProvider } from './types';

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  buckets: Record<BucketName, string>;
  /** Override for tests; defaults to https://<accountId>.r2.cloudflarestorage.com */
  endpoint?: string;
}

/** Returns null unless every R2 variable is set, so R2 stays completely off until it is configured. */
export function r2ConfigFromEnv(env: NodeJS.ProcessEnv = process.env): R2Config | null {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_VIDEOS, R2_BUCKET_UPLOADS } = env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_VIDEOS || !R2_BUCKET_UPLOADS) return null;
  return { accountId: R2_ACCOUNT_ID, accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY, buckets: { videos: R2_BUCKET_VIDEOS, uploads: R2_BUCKET_UPLOADS } };
}

const statusOf = (e: unknown): number | undefined => (e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
const isMissing = (e: unknown): boolean => statusOf(e) === 404 || (e as { name?: string })?.name === 'NoSuchKey' || (e as { name?: string })?.name === 'NotFound';

/** Cloudflare R2 through its S3-compatible API. Credentials never leave the server; browsers only get presigned URLs. */
export class R2Provider implements StorageProvider {
  readonly name = 'r2' as const;
  private readonly client: S3Client;

  constructor(private readonly config: R2Config, client?: S3Client) {
    const clientConfig: S3ClientConfig = {
      region: 'auto',
      endpoint: config.endpoint ?? `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    };
    this.client = client ?? new S3Client(clientConfig);
  }

  private bucketOf(bucket: BucketName): string {
    return this.config.buckets[bucket];
  }

  async put(bucket: BucketName, key: string, body: Buffer, opts: PutOptions): Promise<void> {
    try {
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucketOf(bucket),
        Key: key,
        Body: body,
        ContentType: opts.contentType,
        ContentLength: body.length,
        // Atomic "create only if absent": a retry can never overwrite or duplicate an object.
        ...(opts.upsert ? {} : { IfNoneMatch: '*' }),
      }));
    } catch (e) {
      if (statusOf(e) === 412) throw new ObjectExistsError(bucket, key);
      throw new Error(`Failed to upload ${bucket}/${key} to R2: ${(e as Error).message}`);
    }
  }

  async download(bucket: BucketName, key: string): Promise<Buffer> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucketOf(bucket), Key: key }));
      if (!res.Body) throw new ObjectNotFoundError(bucket, key);
      return Buffer.from(await res.Body.transformToByteArray());
    } catch (e) {
      if (e instanceof ObjectNotFoundError) throw e;
      if (isMissing(e)) throw new ObjectNotFoundError(bucket, key);
      throw new Error(`Failed to download ${bucket}/${key} from R2: ${(e as Error).message}`);
    }
  }

  async head(bucket: BucketName, key: string): Promise<ObjectInfo | null> {
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucketOf(bucket), Key: key }));
      return { size: res.ContentLength ?? 0, contentType: res.ContentType ?? null, etag: res.ETag ? res.ETag.replace(/"/g, '') : null };
    } catch (e) {
      if (isMissing(e)) return null;
      throw new Error(`Failed to read metadata of ${bucket}/${key} from R2: ${(e as Error).message}`);
    }
  }

  /** Presigning is a local computation: no network call, and it does not check that the object exists. */
  async signedReadUrl(bucket: BucketName, key: string, expiresInSeconds: number): Promise<string | null> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucketOf(bucket), Key: key }), { expiresIn: expiresInSeconds });
  }

  async signedReadUrls(bucket: BucketName, keys: string[], expiresInSeconds: number): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    await Promise.all(keys.map(async (key) => { const url = await this.signedReadUrl(bucket, key, expiresInSeconds); if (url) out.set(key, url); }));
    return out;
  }

  async signedUpload(bucket: BucketName, key: string, contentType: string, expiresInSeconds: number): Promise<SignedUpload> {
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({ Bucket: this.bucketOf(bucket), Key: key, ContentType: contentType }),
      { expiresIn: expiresInSeconds, signableHeaders: new Set(['content-type']) },
    );
    return { url, method: 'PUT', headers: { 'Content-Type': contentType } };
  }

  /**
   * Connectivity check used by the admin connection test: can the credentials reach each bucket? Never throws and
   * never includes the credentials in what it returns.
   */
  async ping(): Promise<{ bucket: BucketName; ok: boolean; detail: string }[]> {
    const names: BucketName[] = ['videos', 'uploads'];
    return Promise.all(names.map(async (bucket) => {
      try {
        await this.client.send(new HeadBucketCommand({ Bucket: this.bucketOf(bucket) }));
        return { bucket, ok: true, detail: `Bucket "${this.bucketOf(bucket)}" reachable` };
      } catch (e) {
        const raw = `${(e as Error).name ?? 'Error'}: ${(e as Error).message ?? ''}`.slice(0, 160);
        const detail = [this.config.secretAccessKey, this.config.accessKeyId].reduce((text, secret) => (secret ? text.split(secret).join('[hidden]') : text), raw);
        return { bucket, ok: false, detail: `Bucket "${this.bucketOf(bucket)}": ${detail}` };
      }
    }));
  }

  async delete(bucket: BucketName, key: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucketOf(bucket), Key: key }));
    } catch (e) {
      throw new Error(`Failed to delete ${bucket}/${key} from R2: ${(e as Error).message}`);
    }
  }
}
