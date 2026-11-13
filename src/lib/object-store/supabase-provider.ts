import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { ObjectExistsError, ObjectNotFoundError, type BucketName, type ObjectInfo, type PutOptions, type SignedUpload, type StorageProvider } from './types';

export const bucketId = (bucket: BucketName): string =>
  // `||`, not `??`: an environment variable set to an empty string must fall back to the default name too.
  bucket === 'videos' ? (process.env.SUPABASE_BUCKET_VIDEOS || 'videos') : (process.env.SUPABASE_BUCKET_UPLOADS || 'uploads');

/** The existing behaviour: Supabase Storage through the service-role client (server-side only). */
export class SupabaseProvider implements StorageProvider {
  readonly name = 'supabase' as const;
  private client: SupabaseClient | null;

  constructor(client?: SupabaseClient) {
    this.client = client ?? null;
  }

  private sb(): SupabaseClient {
    if (!this.client) {
      this.client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
    }
    return this.client;
  }

  async put(bucket: BucketName, key: string, body: Buffer, opts: PutOptions): Promise<void> {
    const { error } = await this.sb().storage.from(bucketId(bucket)).upload(key, body, { contentType: opts.contentType, upsert: opts.upsert ?? false });
    if (error) {
      if (/already exists|duplicate/i.test(error.message)) throw new ObjectExistsError(bucket, key);
      throw new Error(`Failed to upload ${bucket}/${key} to Supabase Storage: ${error.message}`);
    }
  }

  async download(bucket: BucketName, key: string): Promise<Buffer> {
    const { data, error } = await this.sb().storage.from(bucketId(bucket)).download(key);
    if (error || !data) {
      if (!error || /not found|does not exist|404/i.test(error.message)) throw new ObjectNotFoundError(bucket, key);
      // Keep the client's HTTP status and original error on the thrown error so a caller can tell a transient failure
      // (network, 429, 5xx) from a permanent one. Only properties are added; the message is unchanged.
      const e = error as { status?: unknown; statusCode?: unknown; originalError?: unknown };
      throw Object.assign(new Error(`Failed to download ${key} from bucket ${bucketId(bucket)}: ${error.message}`), { status: e.status, statusCode: e.statusCode, originalError: e.originalError });
    }
    return Buffer.from(await data.arrayBuffer());
  }

  async head(bucket: BucketName, key: string): Promise<ObjectInfo | null> {
    const { data, error } = await this.sb().storage.from(bucketId(bucket)).info(key);
    if (error || !data) return null;
    return { size: data.size ?? 0, contentType: data.contentType ?? null, etag: data.etag ?? null };
  }

  async signedReadUrl(bucket: BucketName, key: string, expiresInSeconds: number): Promise<string | null> {
    const { data, error } = await this.sb().storage.from(bucketId(bucket)).createSignedUrl(key, expiresInSeconds);
    if (error || !data?.signedUrl) return null;
    return data.signedUrl;
  }

  async signedReadUrls(bucket: BucketName, keys: string[], expiresInSeconds: number): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (keys.length === 0) return out;
    const { data } = await this.sb().storage.from(bucketId(bucket)).createSignedUrls(keys, expiresInSeconds);
    for (const item of data ?? []) if (item.signedUrl && item.path) out.set(item.path, item.signedUrl);
    return out;
  }

  async signedUpload(bucket: BucketName, key: string, contentType: string): Promise<SignedUpload> {
    const { data, error } = await this.sb().storage.from(bucketId(bucket)).createSignedUploadUrl(key);
    if (error || !data) throw new Error(`Failed to create upload URL: ${error?.message ?? 'no data'}`);
    return { url: data.signedUrl, method: 'PUT', headers: { 'Content-Type': contentType } };
  }

  async delete(bucket: BucketName, key: string): Promise<void> {
    const { error } = await this.sb().storage.from(bucketId(bucket)).remove([key]);
    if (error) throw new Error(`Failed to delete ${bucket}/${key}: ${error.message}`);
  }
}
