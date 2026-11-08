import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    testTimeout: 15000,
    hookTimeout: 15000,
    fileParallelism: false,
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
      reporter: ["lcov", "text"],
    },
  },
});
