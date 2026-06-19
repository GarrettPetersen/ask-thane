import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@ask-thane/ai": path.join(repoRoot, "packages/ai/src/index.ts"),
      "@ask-thane/data": path.join(repoRoot, "packages/data/src/index.ts"),
      "@ask-thane/domain": path.join(repoRoot, "packages/domain/src/index.ts"),
      "@ask-thane/workflows": path.join(repoRoot, "packages/workflows/src/index.ts"),
      "cloudflare:workers": path.join(repoRoot, "apps/api-worker/test/cloudflare-workers-shim.ts")
    }
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"]
  }
});
