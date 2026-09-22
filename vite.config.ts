import { defineConfig } from "vite";

// GitHub Pages serves the site at https://wolfxxx.github.io/GROKNinja/
const pagesBase = process.env.GITHUB_PAGES === "1" ? "/GROKNinja/" : "/";

export default defineConfig({
  base: pagesBase,
  server: {
    port: 5173,
    open: true,
  },
  assetsInclude: ["**/*.glb"],
  build: {
    target: "es2022",
    sourcemap: true,
    // Village FBX + Mixamo takes are large; keep the warning high.
    chunkSizeWarningLimit: 4000,
  },
});
