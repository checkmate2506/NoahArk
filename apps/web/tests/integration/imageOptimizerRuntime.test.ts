import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const webRoot = fileURLToPath(new URL("../..", import.meta.url));
const publicDir = join(webRoot, "public");
const probeName = "p2d-optimizer-probe.png";
const probePath = join(publicDir, probeName);
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const nextCli = createRequire(import.meta.url).resolve("next/dist/bin/next");

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("could not bind a free port"));
        return;
      }
      const port = address.port;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { redirect: "manual" });
      if (res.status > 0) return;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`next start did not become ready: ${last}`);
}

async function portIsInUse(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(true));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(false));
    });
  });
}

async function waitForPortClosed(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await portIsInUse(port))) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`port ${port} is still listening`);
}

function killOwnedProcessTree(proc: ChildProcess, force: boolean): void {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const pid = proc.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    const args = ["/PID", String(pid), "/T"];
    if (force) args.push("/F");
    spawnSync("taskkill", args, { windowsHide: true, stdio: "ignore" });
    return;
  }
  try {
    process.kill(pid, force ? "SIGKILL" : "SIGTERM");
  } catch {
    // already gone
  }
}

const hasProductionBuild = existsSync(join(webRoot, ".next", "BUILD_ID"));

describe.skipIf(!hasProductionBuild)(
  "P2D.0 Next.js image optimizer (production runtime)",
  () => {
    let child: ChildProcess | undefined;
    let port = 0;
    let origin = "";
    const statuses: Record<string, number> = {};

    async function stopServer(): Promise<void> {
      const proc = child;
      child = undefined;
      if (!proc?.pid) {
        if (port) await waitForPortClosed(port, 5_000).catch(() => undefined);
        return;
      }
      if (proc.exitCode === null && proc.signalCode === null) {
        killOwnedProcessTree(proc, false);
      }
      const closed = await waitForPortClosed(port, 3_000)
        .then(() => true)
        .catch(() => false);
      if (!closed && proc.exitCode === null && proc.signalCode === null) {
        killOwnedProcessTree(proc, true);
        await waitForPortClosed(port, 8_000);
      } else if (!closed) {
        await waitForPortClosed(port, 8_000);
      }
    }

    beforeAll(async () => {
      await mkdir(publicDir, { recursive: true });
      await writeFile(probePath, PNG_1x1);
      port = await freePort();
      origin = `http://127.0.0.1:${port}`;
      child = spawn(
        process.execPath,
        [nextCli, "start", "-p", String(port), "-H", "127.0.0.1"],
        {
          cwd: webRoot,
          env: { ...process.env, NODE_ENV: "production", PORT: String(port) },
          stdio: ["ignore", "pipe", "pipe"],
          shell: false,
          windowsHide: true,
        },
      );
      const logs: string[] = [];
      child.stdout?.on("data", (chunk: Buffer) => logs.push(chunk.toString("utf8")));
      child.stderr?.on("data", (chunk: Buffer) => logs.push(chunk.toString("utf8")));
      try {
        await waitForHttp(origin, 60_000);
      } catch (error) {
        await stopServer();
        throw new Error(
          `${error instanceof Error ? error.message : error}\n${logs.join("")}`,
          { cause: error },
        );
      }
    }, 90_000);

    afterAll(async () => {
      try {
        await stopServer();
        await waitForPortClosed(port, 8_000);
        expect(await portIsInUse(port)).toBe(false);
      } finally {
        await unlink(probePath).catch(() => undefined);
      }
    }, 30_000);

    async function probe(name: string, pathAndQuery: string): Promise<number> {
      const res = await fetch(`${origin}${pathAndQuery}`, { redirect: "manual" });
      statuses[name] = res.status;
      const location = res.headers.get("location") ?? "";
      expect(location).not.toMatch(/sign-in/);
      const contentType = res.headers.get("content-type") ?? "";
      if (res.status === 200) {
        expect(contentType).not.toMatch(/image\/(webp|avif|jpeg|png|gif)/);
      }
      return res.status;
    }

    it("becomes reachable and does not serve an optimized image for local, remote, query-string or unsupported-quality probes", async () => {
      const ready = await fetch(origin, { redirect: "manual" });
      expect(ready.status).toBeGreaterThan(0);

      const local = await probe(
        "local",
        `/_next/image?url=${encodeURIComponent(`/${probeName}`)}&w=32&q=75`,
      );
      const remote = await probe(
        "remote",
        `/_next/image?url=${encodeURIComponent("https://example.com/x.png")}&w=32&q=75`,
      );
      const queryLocal = await probe(
        "queryLocal",
        `/_next/image?url=${encodeURIComponent(`/${probeName}?x=1`)}&w=32&q=75`,
      );
      const badQuality = await probe(
        "badQuality",
        `/_next/image?url=${encodeURIComponent(`/${probeName}`)}&w=32&q=1`,
      );

      console.error("P2D.0 image optimizer probe statuses", statuses);
      for (const status of [local, remote, queryLocal, badQuality]) {
        expect(status).toBe(404);
      }
      expect(statuses).toEqual({
        local,
        remote,
        queryLocal,
        badQuality,
      });
    });
  },
);
