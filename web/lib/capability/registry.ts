// The runtime view of the immutable shipped registry (T06).
//
// Built once per page lifetime from the typed sources, frozen, and stamped with the
// deployed client's `APP_VERSION` plus the generated manifest hash. There is no
// hand-maintained content-version constant anywhere in this feature: the version IS
// the build stamp and the hash IS the content identity, which is what the technical
// plan means by removing version drift.
//
// A HELP ANSWER RETAINS THE STAMP. Every tool result and every navigation outcome
// carries `{ appBuildVersion, manifestSha256 }`. When the user later acts on an
// answer, the host compares the stamp the answer was produced under against the live
// one; a redeployed client changes the pair and the action fails closed rather than
// resolving against content the answer never saw.

import { currentAppVersion } from "@/lib/scenario/app-version";
import { buildCapabilityManifest } from "./build-manifest";
import { GENERATED_CAPABILITY_MANIFEST } from "./registry.generated";
import type { CapabilityRegistryStamp, CapabilityRegistryV1 } from "./types";

let cached: CapabilityRegistryV1 | null = null;

/**
 * The shipped registry. Memoized because the derivation is pure and the result is
 * frozen -- there is nothing a second build could legitimately produce differently,
 * and re-deriving per tool call would only invite a caller to hold a stale copy.
 *
 * Throws {@link import("./build-manifest").CapabilityRegistryError} if the sources are
 * invalid. That is deliberate: an invalid registry must not degrade into a partial
 * one, because a partial registry is exactly the thing that lets an answer name a
 * control the app does not have.
 */
export function getCapabilityRegistry(): CapabilityRegistryV1 {
  if (cached) return cached;
  const manifest = buildCapabilityManifest();
  cached = Object.freeze({
    schemaVersion: manifest.schemaVersion,
    appBuildVersion: currentAppVersion(),
    manifestSha256: GENERATED_CAPABILITY_MANIFEST.manifestSha256,
    entries: manifest.entries,
    anchors: manifest.anchors,
  });
  return cached;
}

/** The version identity to record on a display, a tool result or a receipt. */
export function capabilityRegistryStamp(): CapabilityRegistryStamp {
  const registry = getCapabilityRegistry();
  return Object.freeze({
    appBuildVersion: registry.appBuildVersion,
    manifestSha256: registry.manifestSha256,
  });
}

/** Whether a stamp recorded earlier still describes the live registry. */
export function stampMatchesLiveRegistry(stamp: CapabilityRegistryStamp): boolean {
  const live = capabilityRegistryStamp();
  return (
    stamp.appBuildVersion === live.appBuildVersion && stamp.manifestSha256 === live.manifestSha256
  );
}

/**
 * Test seam: drop the memoized registry so a spec can change the `APP_VERSION` stamp.
 * Not used by production code -- the registry is immutable within a page lifetime.
 */
export function resetCapabilityRegistryForTest(): void {
  cached = null;
}
