// Local production serve for `output: 'standalone'`. `next start` is unsupported
// with standalone output, and the standalone build does not copy `.next/static`
// or `public` next to `server.js` — so we do it here, mirroring the Docker runner
// stage, then run the standalone server. Docker uses `node server.js` directly;
// this script is the local equivalent.
import { cpSync, existsSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";

const standalone = ".next/standalone";
const server = `${standalone}/server.js`;

if (!existsSync(server)) {
  console.error(`Missing ${server} — run \`pnpm build\` first.`);
  process.exit(1);
}

// Refresh the traced static assets + public dir next to the standalone server.
rmSync(`${standalone}/.next/static`, { recursive: true, force: true });
cpSync(".next/static", `${standalone}/.next/static`, { recursive: true });
if (existsSync("public")) {
  rmSync(`${standalone}/public`, { recursive: true, force: true });
  cpSync("public", `${standalone}/public`, { recursive: true });
}

// PORT / HOSTNAME are read from the environment by the standalone server.
const child = spawn(process.execPath, [server], { stdio: "inherit", env: process.env });
child.on("exit", (code) => process.exit(code ?? 0));
