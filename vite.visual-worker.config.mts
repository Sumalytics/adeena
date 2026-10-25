import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  build: {
    emptyOutDir: true,
    outDir: ".local/visual-worker",
    ssr: "scripts/visual-generation-worker.ts",
    rollupOptions: {
      external: ["postgres"],
      output: { entryFileNames: "visual-generation-worker.mjs" },
    },
  },
});
