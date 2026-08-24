import { spawn, type ChildProcess } from "node:child_process";

/**
 * P1E-5 (Phase 1F): `child.kill()` alone does not reliably stop a `next
 * dev`/`next start` process tree on Windows — the Next.js CLI spawns its
 * own child process(es), and killing only the immediate PID can leave
 * those running (observed directly during this engagement's own live
 * verification work). `taskkill /T /F` kills the whole tree by PID.
 */
export async function killProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.on("exit", () => resolve());
      killer.on("error", () => resolve());
    });
  } else {
    child.kill("SIGKILL");
  }
}
