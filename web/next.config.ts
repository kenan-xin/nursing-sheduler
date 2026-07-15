import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone output: the Docker runner stage copies `.next/standalone` and runs
  // `node server.js` with a minimal traced node_modules (see docker/Dockerfile.web).
  output: "standalone",
};

export default nextConfig;
