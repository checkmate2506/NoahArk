/** Storage-provider abstraction. Phase 1 ships only the local filesystem
 * implementation (localProvider.ts) — an S3/Blob-compatible provider is a
 * later-phase addition behind this same interface. */
export interface StorageProvider {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}
