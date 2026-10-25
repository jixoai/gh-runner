// 构建辅助：品牌图标资产 → dist/assets（npm 分发随包携带）。
import { cp, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "assets", "icons", "build");
const dest = join(root, "dist", "assets");
await mkdir(dest, { recursive: true });
await cp(src, dest, { recursive: true }); // build/ 内含 linux/ 子目录，必须递归
console.log("branding assets -> dist/assets");
