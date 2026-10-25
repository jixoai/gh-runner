// 图标生成：自绘 SVG → @opentray/icon 内核 → 全平台合规资产集（icns/ico/png）+ 菜单栏模板图。
// 产物提交在 assets/icons/build/，构建时同步进 dist/assets（npm 分发随包携带）。
import { mkdir, writeFile, copyFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { generateOpenTrayAppIcon, rasterizeSvg, encodeImagePng } from "@opentray/icon";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "assets", "icons", "build");
await mkdir(outDir, { recursive: true });

// 1) App 图标：composed 直通（设计已含 macOS 内容区留白），内核产出合规集
const meta = await generateOpenTrayAppIcon({
  sourcePath: join(root, "assets", "icons", "source.svg"),
  composed: true,
  outputPath: join(outDir, "icon-1024.png"),
  icnsOutputPath: join(outDir, "icon.icns"),
  icoOutputPath: join(outDir, "icon.ico"),
  manifestOutputPath: join(outDir, "manifest.json"),
});
console.log("[icons] app icon set:", meta.outputPath);

// 2) 菜单栏模板图（纯黑+alpha）与 Win32 彩色小图
const svg = await (await import("node:fs/promises")).readFile(
  join(root, "assets", "icons", "tray-template.svg"),
  "utf8",
);
const rgba = await rasterizeSvg(svg, 64);
const trayPng = await encodeImagePng(rgba);
await writeFile(join(outDir, "tray-template.png"), trayPng);
await copyFile(join(outDir, "icon-1024.png"), join(outDir, "tray-color.png"));
console.log("[icons] tray assets written");
