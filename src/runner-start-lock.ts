import { mkdtemp, readdir, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { pidExists } from "./supervisor.ts";

export async function acquireRunnerStartLock(dir: string): Promise<() => Promise<void>> {
  const path = join(dir, ".gh-runner-start.lock");
  const candidate = await mkdtemp(join(dir, ".gh-runner-start-"));
  const owner = `${process.pid}-${randomUUID()}`;
  try {
    await writeFile(join(candidate, owner), "", { mode: 0o600 });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await rename(candidate, path);
        return async () => {
          await unlink(join(path, owner)).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
          });
          await rmdir(path).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY" && error.code !== "EEXIST") throw error;
          });
        };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST" && code !== "ENOTEMPTY" && code !== "EPERM") throw error;
        const previous = await readdir(path).catch((readError: NodeJS.ErrnoException) => {
          if (readError.code === "ENOENT") return null;
          throw readError;
        });
        if (previous === null) continue;
        if (previous.length > 0) {
          const previousOwner = previous[0]!;
          const previousPid = Number(/^(\d+)-[a-f0-9-]{36}$/.exec(previousOwner)?.[1]);
          if (previous.length !== 1 || !Number.isSafeInteger(previousPid) || previousPid <= 0 || pidExists(previousPid) !== "dead") {
            throw new Error("另一个 GH Runner 正在启动此实例，或启动锁无法确认；请稍后重试");
          }
          await unlink(join(path, previousOwner)).catch((unlinkError: NodeJS.ErrnoException) => {
            if (unlinkError.code !== "ENOENT") throw unlinkError;
          });
        }
        await rmdir(path).catch((removeError: NodeJS.ErrnoException) => {
          if (removeError.code !== "ENOENT" && removeError.code !== "ENOTEMPTY" && removeError.code !== "EEXIST") throw removeError;
        });
      }
    }
  } finally {
    await rm(candidate, { recursive: true, force: true });
  }
  throw new Error("无法取得 Runner 启动锁，请稍后重试");
}
