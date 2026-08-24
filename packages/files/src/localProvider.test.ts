import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalStorageProvider } from "./localProvider";

describe("LocalStorageProvider", () => {
  let root: string;
  let provider: LocalStorageProvider;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "noahark-files-test-"));
    provider = new LocalStorageProvider(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("writes and reads back a file by key", async () => {
    await provider.put("tenant/t1/hello.txt", Buffer.from("hello"));
    const data = await provider.get("tenant/t1/hello.txt");
    expect(data.toString()).toBe("hello");
  });

  it("reports existence correctly", async () => {
    expect(await provider.exists("missing.txt")).toBe(false);
    await provider.put("present.txt", Buffer.from("x"));
    expect(await provider.exists("present.txt")).toBe(true);
  });

  it("deletes a file", async () => {
    await provider.put("to-delete.txt", Buffer.from("x"));
    await provider.delete("to-delete.txt");
    expect(await provider.exists("to-delete.txt")).toBe(false);
  });

  it("rejects a key that attempts to escape the storage root with ..", async () => {
    await expect(provider.put("../escape.txt", Buffer.from("x"))).rejects.toThrow(
      /Invalid storage key/,
    );
  });

  it("rejects a key nested with a traversal segment", async () => {
    await expect(
      provider.put("tenant/t1/../../escape.txt", Buffer.from("x")),
    ).rejects.toThrow(/Invalid storage key/);
  });

  it("rejects an absolute path as a key", async () => {
    await expect(provider.get("/etc/passwd")).rejects.toThrow(/Invalid storage key/);
  });

  it("rejects an empty key", async () => {
    await expect(provider.get("")).rejects.toThrow(/Invalid storage key/);
  });
});
