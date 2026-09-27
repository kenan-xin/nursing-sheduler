import { networkInterfaces } from "node:os";

// WHY THIS EXISTS. Next 16 blocks cross-origin requests to dev-only assets and
// endpoints (`/_next/*`, `/__nextjs*`) unless the request Origin's hostname is
// `localhost`, `*.localhost`, the configured bind hostname, or an entry in
// `allowedDevOrigins`. `next dev` binds `0.0.0.0`, so opening the server from
// another LAN device sends `Origin: http://<lan-ip>:3000` — a hostname none of
// those defaults covers — Next answers 403, the JS never loads and the app
// never hydrates. Feeding this machine's own addresses to `allowedDevOrigins`
// (development only) is what lifts that block.
// Ref: https://nextjs.org/docs/app/api-reference/config/next-config-js/allowedDevOrigins

/** The fields this helper reads from a `networkInterfaces()` entry. */
interface NetworkInterfaceAddress {
  address: string;
  family: string;
  internal: boolean;
}

/**
 * The hostnames `next dev` must accept dev requests from on this machine:
 * loopback, then every non-internal IPv4 address, de-duplicated.
 *
 * `127.0.0.1` is listed explicitly rather than read from the interface map,
 * whose loopback entry is filtered out as internal: Next's own entries are
 * `localhost` and `*.localhost`, so a dev server opened at
 * `http://127.0.0.1:3000` needs this entry to avoid the 403. IPv6 entries are
 * dropped — a browser origin carries a hostname, and this is the IPv4 path the
 * reported bug is on.
 *
 * `interfaces` is injectable so the list can be exercised without depending on
 * whatever addresses the machine running the test happens to have.
 */
export function getAllowedDevOrigins(
  interfaces: NodeJS.Dict<readonly NetworkInterfaceAddress[]> = networkInterfaces(),
): string[] {
  const interfaceAddresses = Object.values(interfaces).flatMap((entries) =>
    (entries ?? [])
      .filter((entry) => entry.family === "IPv4" && !entry.internal)
      .map((entry) => entry.address),
  );

  return [...new Set(["127.0.0.1", ...interfaceAddresses])];
}
