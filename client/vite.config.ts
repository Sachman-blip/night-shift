import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
    // Expose on LAN so friends on the same network can playtest.
    // (The client derives the ws:// endpoint from location.hostname.)
    host: true,
  },
  build: {
    rollupOptions: {
      output: {
        // Split the heavy libs into their own chunks: browsers fetch them in
        // parallel, and they stay cached across game-code redeploys.
        manualChunks: {
          three: ["three"],
          rapier: ["@dimforge/rapier3d-compat"],
          colyseus: ["colyseus.js"],
        },
      },
    },
  },
});
