import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import type { StorageProvider } from "./storageProvider";

/**
 * Local-filesystem storage provider for development. Every key is resolved
 * against a fixed root and verified to stay inside it — a key containing
 * `..` or an absolute path is rejected before it ever reaches the
 * filesystem, so this can never be used to read/write outside its root
 * regardless of what a caller passes in.
 */
export class LocalStorageProvider implements StorageProvider {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private resolveKey(key: string): string {
    if (
      key.length === 0 ||
      key.includes("..") ||
      key.startsWith("/") ||
      key.startsWith("\\")
    ) {
      throw new Error("Invalid storage key");
    }
    const full = resolve(this.root, key);
    if (full !== this.root && !full.startsWith(this.root + sep)) {
      throw new Error("Storage key escapes the storage root");
    }
    return full;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const full = this.resolveKey(key);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, data);
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.resolveKey(key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolveKey(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await access(this.resolveKey(key));
      return true;
    } catch {
      return false;
    }
  }
}
