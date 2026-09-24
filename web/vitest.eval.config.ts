// The live-model eval suite. Never part of `pnpm test`: the main config's include cannot
// match *.eval.ts, and this one refuses to load without a key.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

if (!process.env.OPENROUTER_API_KEY) {
  throw new Error("pnpm eval needs OPENROUTER_API_KEY (a separate, budget-capped key).");
}

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./", import.meta.url)) } },
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["evals/**/*.eval.ts"],
    // Files run in parallel worker processes; trials inside a file run in sequence.
    maxWorkers: 3,
    testTimeout: 300_000,
    reporters: ["default", "./evals/eval-reporter.ts"],
    server: { deps: { inline: [/@copilotkit\/react-core/] } },
  },
});
