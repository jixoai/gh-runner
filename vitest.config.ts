import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // E2E 涉及真实进程与 HOME 隔离，禁止文件级并行
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
