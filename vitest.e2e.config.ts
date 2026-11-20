import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["tests/e2e/**/*.e2e.ts"], testTimeout: 600_000, hookTimeout: 600_000, fileParallelism: false },
});
