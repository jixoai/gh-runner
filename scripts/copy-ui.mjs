// 构建辅助：把 UI 静态资产拷进 dist/ui（跨平台，构建脚本不依赖 POSIX 命令）。
import { copyFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const uiDir = join(root, "dist", "ui");
await mkdir(uiDir, { recursive: true });
for (const file of ["index.html", "demo.js"]) {
  await copyFile(join(root, "src", "ui", file), join(uiDir, file));
}
console.log(`copied ui assets -> ${join("dist", "ui")}`);
