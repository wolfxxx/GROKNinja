import { defineConfig } from "vite";

// GitHub Pages serves the site at https://wolfxxx.github.io/GROKNinja/
const pagesBase = process.env.GITHUB_PAGES === "1" ? "/GROKNinja/" : "/";

export default defineConfig({
  base: pagesBase,
  // The local FBX village kit is a large junction under public/. Only the
  // playable web assets are copied after bundling (tools/copy-public.mjs).
  build: {
    copyPublicDir: false,
    target: "es2022",
    sourcemap: true,
    chunkSizeWarningLimit: 4000,
  },
  server: {
    port: 5173,
    open: true,
  },
  assetsInclude: ["**/*.glb"],
});
