import { execSync } from "node:child_process";
import type { NextConfig } from "next";

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

const nextConfig: NextConfig = {
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
  },
};

export default nextConfig;
