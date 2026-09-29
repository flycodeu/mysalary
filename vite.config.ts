import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  test: { include: ["tests/**/*.test.ts"] },
  server: { host: "127.0.0.1", port: 5198, strictPort: true },
});
