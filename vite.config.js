import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Relative asset paths, so the build also works under a GitHub Pages sub-path.
  base: "./",
  build: { chunkSizeWarningLimit: 1000 },
  server: {
    // `npm run dev:server` runs the multiplayer server on :8080.
    proxy: { "/ws": { target: "ws://localhost:8080", ws: true } },
  },
});
