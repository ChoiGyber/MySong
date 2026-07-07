import { defineConfig } from "vite";

// Vite config tuned for Tauri: fixed dev port, no screen clearing so Rust logs stay visible.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // Don't watch the Rust side; Tauri handles it.
      ignored: ["**/src-tauri/**"],
    },
  },
});
