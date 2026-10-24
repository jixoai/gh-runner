/*
 * DirTail 单测：>64KB 历史文件首附时从尾部起步，首个片段是残行，必须丢弃到首个换行
 * （实机回归：vision 判读发现真实窗口日志首行从 "m.Net.…" 开始——半个标识符）。
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DirTail } from "../src/tailer.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("DirTail", () => {
  it("大文件首附：丢弃起步处的残行，从完整行开始交付", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rf-tail-"));
    const big = join(dir, "Runner_20261024-010101-utc.log");
    const filler = "x".repeat(300) + "\n";
    const head = `[2026-10-24 01:00:00Z INFO Terminal] WRITE LINE: 2026-10-24 01:00:00Z: Listening for Jobs\n`;
    // 先写 100KB 无尾随换行的填充 + 残行头部，再补完首条完整行
    await writeFile(big, filler.repeat(340)); // ~102KB，最后有 \n
    await appendFile(big, "[2026-10-24 01:00:01Z INFO Termi"); // 残行
    await new Promise((r) => setTimeout(r, 20));

    const received: string[][] = [];
    const tail = new DirTail(dir, "Runner_", { intervalMs: 50, initialBackreadBytes: 4096 });
    tail.start((lines) => received.push(lines));
    await sleep(300);
    // 起步交付里不允许出现 "[2026-10-24 01:00:01Z INFO Termi" 这种残行
    const flat = received.flat();
    expect(flat.length).toBeGreaterThan(0);
    expect(flat.some((l) => l.endsWith("Termi"))).toBe(false);
    expect(flat[0]).not.toMatch(/INFO Termi$/);

    // 追加后能继续增量交付
    await appendFile(big, "nal] WRITE LINE: 2026-10-24 01:00:02Z: Running job: tail-e2e\n[2026-10-24 01:00:02Z INFO Terminal] WRITE LINE: 2026-10-24 01:00:02Z: Job tail-e2e completed with result: Succeeded\n");
    await sleep(300);
    const after = received.flat();
    expect(after.some((l) => l.includes("Running job: tail-e2e"))).toBe(true);
    tail.stop();
  });
});
