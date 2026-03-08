import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "dashboard",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ["react", "react-dom"]
        }
      }
    }
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8787"
    }
  }
});
