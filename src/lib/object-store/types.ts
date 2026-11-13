/**
 * One storage interface for every file the app keeps (generated videos, B-roll, project images).
 * Logical bucket names ('videos', 'uploads') never change, so paths saved in the database and image references saved
 * in conversations stay valid whichever provider holds the bytes.
 */
export type BucketName = 'videos' | 'uploads';
export type ProviderName = 'supabase' | 'r2';

export interface ObjectInfo {
  size: number;
  contentType: string | null;
  etag: string | null;
}

export interface PutOptions {
  contentType: string;
  /** Replace an existing object. Default false: fail if the key already exists (same as the old Supabase calls). */
  upsert?: boolean;
}

export interface SignedUpload {
  url: string;
  method: 'PUT';
  /** Headers the browser must send exactly as given (for example Content-Type). */
  headers: Record<string, string>;
}

export class ObjectExistsError extends Error {
  constructor(bucket: string, key: string) {
    super(`Object already exists: ${bucket}/${key}`);
    this.name = 'ObjectExistsError';
  }
}

export class ObjectNotFoundError extends Error {
  constructor(bucket: string, key: string) {
    super(`Object not found: ${bucket}/${key}`);
    this.name = 'ObjectNotFoundError';
  }
}

export interface StorageProvider {
  readonly name: ProviderName;
  put(bucket: BucketName, key: string, body: Buffer, opts: PutOptions): Promise<void>;
  /** Throws ObjectNotFoundError when the object is missing. */
  download(bucket: BucketName, key: string): Promise<Buffer>;
  /** Returns null when the object does not exist. */
  head(bucket: BucketName, key: string): Promise<ObjectInfo | null>;
  signedReadUrl(bucket: BucketName, key: string, expiresInSeconds: number): Promise<string | null>;
  signedReadUrls(bucket: BucketName, keys: string[], expiresInSeconds: number): Promise<Map<string, string>>;
  signedUpload(bucket: BucketName, key: string, contentType: string, expiresInSeconds: number): Promise<SignedUpload>;
  delete(bucket: BucketName, key: string): Promise<void>;
}
