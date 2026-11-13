import { clearLocationCache, locate, registerObject, type RegisterInput } from './registry';
import { R2Provider, r2ConfigFromEnv } from './r2-provider';
import { SupabaseProvider } from './supabase-provider';
import {
  ObjectExistsError, ObjectNotFoundError,
  type BucketName, type ObjectInfo, type ProviderName, type PutOptions, type SignedUpload, type StorageProvider,
} from './types';

export * from './types';
export { clearLocationCache } from './registry';

/**
 * The one way the application stores and reads files. Today every file is in Supabase and R2 is off, so this behaves
 * exactly like the old direct Supabase calls. R2 only takes part once its environment variables are set AND files are
 * registered as being there (or STORAGE_WRITE_PROVIDER=r2 for new files).
 *
 * Reads go to the provider the registry names, then fall back to the other one while STORAGE_FAILOVER is not 'off', so
 * a file that exists in either place stays reachable during the move.
 */
export interface StorageDeps {
  supabase: StorageProvider;
  r2: StorageProvider | null;
  locate: (bucket: BucketName, keys: string[]) => Promise<Map<string, ProviderName>>;
  register: (input: RegisterInput) => Promise<void>;
  writeProvider: () => ProviderName;
  failover: () => boolean;
}

export class Storage {
  constructor(private readonly d: StorageDeps) {}

  private provider(name: ProviderName): StorageProvider | null {
    return name === 'r2' ? this.d.r2 : this.d.supabase;
  }

  /** Providers to try for reading, best first. */
  private async readOrder(bucket: BucketName, key: string): Promise<StorageProvider[]> {
    const primaryName = (await this.d.locate(bucket, [key])).get(key) ?? 'supabase';
    return this.orderFor(primaryName);
  }

  private orderFor(primaryName: ProviderName): StorageProvider[] {
    const primary = this.provider(primaryName) ?? this.d.supabase;
    const otherName: ProviderName = primary.name === 'r2' ? 'supabase' : 'r2';
    const other = this.provider(otherName);
    return other && this.d.failover() ? [primary, other] : [primary];
  }

  async signedReadUrl(bucket: BucketName, key: string, expiresInSeconds: number): Promise<string | null> {
    const order = await this.readOrder(bucket, key);
    for (const p of order) {
      try {
        // Presigning R2 does not look at the object, so while a fallback exists check it is really there first.
        if (p.name === 'r2' && order.length > 1 && !(await p.head(bucket, key))) continue;
        const url = await p.signedReadUrl(bucket, key, expiresInSeconds);
        if (url) return url;
      } catch (err) {
        if (order.length === 1) throw err;
        console.warn(`[storage] ${p.name} could not sign ${bucket}/${key}, trying the other provider:`, (err as Error).message.slice(0, 120));
      }
    }
    return null;
  }

  /** Signed URLs for many keys at once. Keys with no URL are left out of the result. */
  async signedReadUrls(bucket: BucketName, keys: string[], expiresInSeconds: number): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (keys.length === 0) return out;
    const where = await this.d.locate(bucket, keys);
    const byProvider: Record<ProviderName, string[]> = { supabase: [], r2: [] };
    for (const key of keys) byProvider[where.get(key) ?? 'supabase'].push(key);
    if (byProvider.r2.length > 0 && !this.d.r2) { byProvider.supabase.push(...byProvider.r2); byProvider.r2 = []; }

    const needFallback: string[] = [];
    const sup = await this.d.supabase.signedReadUrls(bucket, byProvider.supabase, expiresInSeconds);
    for (const key of byProvider.supabase) { const u = sup.get(key); if (u) out.set(key, u); else needFallback.push(key); }

    if (this.d.r2 && byProvider.r2.length > 0) {
      const r2 = this.d.r2;
      const alt = this.d.failover();
      await Promise.all(byProvider.r2.map(async (key) => {
        if (alt && !(await r2.head(bucket, key))) { needFallback.push(key); return; }
        const u = await r2.signedReadUrl(bucket, key, expiresInSeconds);
        if (u) out.set(key, u);
      }));
    }
    if (this.d.failover()) {
      // Anything unresolved may be in the other provider (R2 file not registered yet, or R2 file missing).
      for (const key of needFallback) {
        const u = await this.signedReadUrl(bucket, key, expiresInSeconds);
        if (u) out.set(key, u);
      }
    }
    return out;
  }

  async download(bucket: BucketName, key: string): Promise<Buffer> {
    const order = await this.readOrder(bucket, key);
    let last: unknown = new ObjectNotFoundError(bucket, key);
    for (const p of order) {
      try {
        return await p.download(bucket, key);
      } catch (err) {
        last = err;
        if (order.length > 1) console.warn(`[storage] ${p.name} could not read ${bucket}/${key}, trying the other provider:`, (err as Error).message.slice(0, 120));
      }
    }
    throw last;
  }

  async head(bucket: BucketName, key: string): Promise<ObjectInfo | null> {
    for (const p of await this.readOrder(bucket, key)) {
      const info = await p.head(bucket, key).catch(() => null);
      if (info) return info;
    }
    return null;
  }

  async exists(bucket: BucketName, key: string): Promise<boolean> {
    return (await this.head(bucket, key)) !== null;
  }

  /** Stores a new file with the configured write provider. Returns where it went. */
  async put(bucket: BucketName, key: string, body: Buffer, opts: PutOptions): Promise<{ provider: ProviderName }> {
    const wantR2 = this.d.writeProvider() === 'r2' && this.d.r2 !== null;
    if (wantR2) {
      try {
        await this.d.r2!.put(bucket, key, body, opts);
        // The file exists in R2 now; record that so readers look there. If this fails the file is an orphan the
        // reconciliation report will list, and the caller sees an error instead of a path nothing can read.
        await this.d.register({ bucket, key, provider: 'r2', sizeBytes: body.length, contentType: opts.contentType });
        return { provider: 'r2' };
      } catch (err) {
        if (err instanceof ObjectExistsError || !this.d.failover()) throw err;
        console.warn(`[storage] R2 write of ${bucket}/${key} failed, storing in Supabase instead:`, (err as Error).message.slice(0, 120));
      }
    }
    await this.d.supabase.put(bucket, key, body, opts);
    return { provider: 'supabase' };
  }

  /** A URL the browser can PUT a file to. Credentials are never exposed, only the time-limited URL. */
  async signedUpload(bucket: BucketName, key: string, contentType: string, expiresInSeconds = 900): Promise<SignedUpload & { provider: ProviderName }> {
    if (this.d.writeProvider() === 'r2' && this.d.r2) {
      const upload = await this.d.r2.signedUpload(bucket, key, contentType, expiresInSeconds);
      await this.d.register({ bucket, key, provider: 'r2', contentType });
      return { ...upload, provider: 'r2' };
    }
    return { ...(await this.d.supabase.signedUpload(bucket, key, contentType, expiresInSeconds)), provider: 'supabase' };
  }

  /** Not used by the application today (it never deletes files); present so the interface is complete. */
  async delete(bucket: BucketName, key: string): Promise<void> {
    for (const p of [this.d.supabase, this.d.r2]) if (p) await p.delete(bucket, key);
  }
}

/** Maps a configured Supabase bucket name (SUPABASE_BUCKET_VIDEOS / SUPABASE_BUCKET_UPLOADS) to the logical bucket. */
export function toLogicalBucket(name: string): BucketName {
  if (name === (process.env.SUPABASE_BUCKET_VIDEOS || 'videos') || name === 'videos') return 'videos';
  if (name === (process.env.SUPABASE_BUCKET_UPLOADS || 'uploads') || name === 'uploads') return 'uploads';
  throw new Error(`Unknown storage bucket: ${name}`);
}

let singleton: Storage | null = null;

export function createDefaultStorage(): Storage {
  const r2Config = r2ConfigFromEnv();
  return new Storage({
    supabase: new SupabaseProvider(),
    r2: r2Config ? new R2Provider(r2Config) : null,
    locate,
    register: registerObject,
    writeProvider: () => (process.env.STORAGE_WRITE_PROVIDER === 'r2' ? 'r2' : 'supabase'),
    failover: () => process.env.STORAGE_FAILOVER !== 'off',
  });
}

/** The application-wide storage object. */
export function getStorage(): Storage {
  if (!singleton) singleton = createDefaultStorage();
  return singleton;
}

/** For tests only. */
export function resetStorageForTests(): void {
  singleton = null;
  clearLocationCache();
}
