import { defineConfig } from "vitest/config";

const integrationEnabled = process.env["INTEGRATION"] === "1";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/unit/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "integration",
          include: integrationEnabled ? ["test/integration/**/*.test.ts"] : [],
          environment: "node",
          testTimeout: 60_000,
          hookTimeout: 60_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
