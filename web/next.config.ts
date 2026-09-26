import { execSync } from "node:child_process";
import type { NextConfig } from "next";

import { getAllowedDevOrigins } from "./dev-origins";

/**
 * Compute the version from `git describe --tags --always --dirty`.
 *
 * Runs on the HOST at config-load time — both in `pnpm dev` (where .git is
 * present) and during the Docker web build's `pnpm build` step. In the Docker
 * build, `.git` is excluded by `.dockerignore` and git may be absent in
 * `node:alpine`, so this returns a fallback — but the Dockerfile sets
 * `NEXT_PUBLIC_APP_VERSION` via `ENV` before `pnpm build`, and the lazy guard
 * below preserves that Docker-provided value over this fallback.
 */
function getGitVersion(): string {
  try {
    return execSync("git describe --tags --always --dirty", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
  } catch {
    return "v0.0.0-unknown";
  }
}

// Low-memory image build (set by docker/Dockerfile.web). The deploy VM has ~2 GB:
// next build's in-process type check needs ~1.4 GB of heap on its own and OOMs
// there, so the image build skips it (CI's `pnpm typecheck` stays the type gate)
// and runs one static-generation worker instead of one per core.
const lowMemoryBuild = process.env.NS_LOW_MEMORY_BUILD === "1";

const nextConfig: NextConfig = {
  // Development only. Next 16 blocks cross-origin requests to dev-only assets
  // and endpoints unless the Origin hostname is `localhost`, the bind hostname,
  // or an entry here. `next dev` binds 0.0.0.0, so a browser on another LAN
  // device is answered 403 and never hydrates; listing this machine's own IPv4
  // addresses (see dev-origins.ts) lifts that block. Production leaves the key
  // unset, so the production config is unchanged.
  // Ref: https://nextjs.org/docs/app/api-reference/config/next-config-js/allowedDevOrigins
  ...(process.env.NODE_ENV === "development" && {
    allowedDevOrigins: getAllowedDevOrigins(),
  }),
  typescript: { ignoreBuildErrors: lowMemoryBuild },
  ...(lowMemoryBuild && { experimental: { cpus: 1 } }),
  // Standalone output: the Docker runner stage copies `.next/standalone` and runs
  // `node server.js` with a minimal traced node_modules (see docker/Dockerfile.web).
  output: "standalone",
  env: {
    // Lazy guard (load-bearing): preserve a non-blank NEXT_PUBLIC_APP_VERSION
    // (set by the Dockerfile ENV before `pnpm build`) over the git-describe
    // fallback. Inside the Docker build, .git is excluded and git may be absent,
    // so getGitVersion() would return v0.0.0-unknown — an unconditional
    // assignment would override the Docker stamp. In `pnpm dev` the env var is
    // unset, so getGitVersion() runs and self-stamps the version.
    NEXT_PUBLIC_APP_VERSION: process.env.NEXT_PUBLIC_APP_VERSION?.trim() || getGitVersion(),
    // The read-only e2e store bridge (`components/shell/test-bridge.tsx`) is gated on
    // this at BUILD time. It is declared here with an explicit `"0"` default because
    // Next only INLINES a `NEXT_PUBLIC_*` value it can see at build time: left
    // undefined, the reference compiles to a runtime `process.env` lookup instead, the
    // gate stays live, and the bridge ships in ordinary production after all — which
    // is exactly the bypass it exists to remove. Declared, it folds to a literal and
    // the whole branch is eliminated.
    NEXT_PUBLIC_NS_TEST_BRIDGE: process.env.NEXT_PUBLIC_NS_TEST_BRIDGE === "1" ? "1" : "0",
  },
};

export default nextConfig;
