import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "node", env: { DELIVERY_BASE_BRANCH: "develop" }, include: ["test/**/*.test.ts"], sequence: { concurrent: false } },
});
