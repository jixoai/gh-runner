import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/main.ts"],
  outDir: "dist",
  format: "esm",
  platform: "node",
  target: "node22",
  banner: { js: "#!/usr/bin/env node" },
  // opentray 家族在 dependencies 里，tsdown 默认保持 dependencies external——
  // 平台原生运行时经 optionalDependencies 运行期解析，绝不能打进产物。
});
