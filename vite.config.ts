import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const uiAppDir = join(dirname(fileURLToPath(import.meta.url)), "src", "ui-app");

export default defineConfig({
  root: uiAppDir,
  plugins: [react(), tailwindcss(), viteSingleFile()],
  resolve: {
    alias: { "@": join(uiAppDir) },
  },
  build: {
    outDir: join(uiAppDir, "../../dist/ui"),
    emptyOutDir: true,
    target: "safari16",
    cssMinify: true,
  },
});
