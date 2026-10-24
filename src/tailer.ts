/*
 * 原始需求（2026-10-24）：界面要实时响应——runner 的 _diag/Runner_*.log 是作业事件的权威来源
 * （对外部启动的 runner 也生效），必须以低开销跟随其追加与轮转。
 *
 * 正交意图：
 * 1. 追加式文件跟随器：stat 轮询 + 增量读取，兼容网络/外置卷（fs.watch 不可靠）。
 * 2. 目录级"最新 Runner_*.log"轮转切换（每次 run.sh 重启产生新文件）。
 */

import { readdir, stat, open } from "node:fs/promises";
import { join } from "node:path";

/** 每次轮询的回调：本次新增的原始行（已按行切分，不含空尾巴）。 */
export type TailCallback = (lines: string[]) => void;

export interface FileTailerOptions {
  /** 轮询间隔（ms），默认 1000。 */
  intervalMs?: number;
  /** 首次附加时只回读文件尾部这么多字节（避免吞下整段历史），默认 64 KiB。 */
  initialBackreadBytes?: number;
}

/**
 * 跟随一个目录中最新的、名字匹配 `prefix*.log` 的文件。
 * - 文件被轮转（出现更新者）时切换并从尾部起步；
 * - 文件被截断时重置 offset；
 * - start() 首次把既有尾部内容以回调交付（用于恢复状态），此后持续增量。
 */
export class DirTail {
  #dir: string;
  #prefix: string;
  #intervalMs: number;
  #initialBackreadBytes: number;
  #timer: NodeJS.Timeout | null = null;
  #activeFile: string | null = null;
  #offset = 0;
  #partial = "";
  #polling = false;

  constructor(dir: string, prefix: string, options: FileTailerOptions = {}) {
    this.#dir = dir;
    this.#prefix = prefix;
    this.#intervalMs = options.intervalMs ?? 1000;
    this.#initialBackreadBytes = options.initialBackreadBytes ?? 64 * 1024;
  }

  start(onLines: TailCallback): void {
    if (this.#timer) return;
    void this.#poll(onLines);
    this.#timer = setInterval(() => void this.#poll(onLines), this.#intervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#activeFile = null;
    this.#offset = 0;
    this.#partial = "";
  }

  async #listCandidates(): Promise<{ file: string; mtimeMs: number }[]> {
    let names: string[];
    try {
      names = await readdir(this.#dir);
    } catch {
      return [];
    }
    const matched = names.filter(
      (n) => n.startsWith(this.#prefix) && n.endsWith(".log"),
    );
    const out: { file: string; mtimeMs: number }[] = [];
    for (const name of matched) {
      try {
        const st = await stat(join(this.#dir, name));
        if (st.isFile()) out.push({ file: name, mtimeMs: st.mtimeMs });
      } catch {
        /* 竞态消失的文件，跳过 */
      }
    }
    out.sort((a, b) =>
      a.mtimeMs === b.mtimeMs ? (a.file < b.file ? 1 : -1) : b.mtimeMs - a.mtimeMs,
    );
    return out;
  }

  async #poll(onLines: TailCallback): Promise<void> {
    if (this.#polling) return;
    this.#polling = true;
    try {
      const candidates = await this.#listCandidates();
      const latest = candidates[0];
      if (!latest) {
        this.#activeFile = null;
        return;
      }
      const path = join(this.#dir, latest.file);

      if (this.#activeFile !== path) {
        // 轮转/首附：从尾部起步，只回读有限历史。
        const st = await stat(path);
        const start = Math.max(0, st.size - this.#initialBackreadBytes);
        this.#activeFile = path;
        this.#offset = start;
        this.#partial = "";
      }

      const st = await stat(path).catch(() => null);
      if (!st) return;
      if (st.size < this.#offset) {
        this.#offset = 0; // 截断
        this.#partial = "";
      }
      if (st.size === this.#offset) return;

      const handle = await open(path, "r");
      try {
        const length = st.size - this.#offset;
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, this.#offset);
        this.#offset = st.size;
        const text = this.#partial + buffer.toString("utf8");
        const lines = text.split("\n");
        this.#partial = lines.pop() ?? "";
        const complete = lines.filter((l) => l.trim().length > 0);
        if (complete.length > 0) onLines(complete);
      } finally {
        await handle.close();
      }
    } catch {
      /* 卷暂不可用等：静默，下轮重试 */
    } finally {
      this.#polling = false;
    }
  }
}
