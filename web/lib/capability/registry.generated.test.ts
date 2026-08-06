// The stale-manifest gate, and the generator that satisfies it (T06).
//
// ONE MECHANISM, TWO MODES. Ordinarily this recomputes the manifest hash from the live
// typed sources and asserts it matches `registry.generated.ts`; with
// `UPDATE_CAPABILITY_REGISTRY=1` it rewrites that file instead. Making the generator
// and the check the same code is what guarantees they cannot disagree -- a separate
// codegen script would be a second implementation of the canonical form, and the day
// the two drifted the gate would start passing for the wrong reason.
//
// It runs inside `pnpm test`, which is part of the build/CI gate, so a renamed anchor,
// a removed route, a new tool name or a single reworded sentence of nurse-facing help
// fails the build until the manifest is regenerated and the diff reviewed.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildCapabilityManifest, CAPABILITY_SCHEMA_VERSION } from "./build-manifest";
import { GENERATED_CAPABILITY_MANIFEST } from "./registry.generated";

const GENERATED_PATH = fileURLToPath(new URL("./registry.generated.ts", import.meta.url));
const UPDATING = process.env.UPDATE_CAPABILITY_REGISTRY === "1";

interface ManifestIdentity {
  schemaVersion: number;
  manifestSha256: string;
  entryCount: number;
  anchorCount: number;
  canonicalByteLength: number;
}

/** Recompute the identity from the live sources. The single source of the hash. */
function computeIdentity(): ManifestIdentity {
  const manifest = buildCapabilityManifest();
  return {
    schemaVersion: manifest.schemaVersion,
    manifestSha256: createHash("sha256").update(manifest.canonical, "utf8").digest("hex"),
    entryCount: manifest.entries.length,
    anchorCount: manifest.anchors.length,
    canonicalByteLength: Buffer.byteLength(manifest.canonical, "utf8"),
  };
}

function renderGeneratedFile(identity: ManifestIdentity): string {
  return `// GENERATED FILE -- do not edit by hand.
//
// Regenerate with:  pnpm capability:generate
// (which is \`UPDATE_CAPABILITY_REGISTRY=1 vitest run lib/capability/registry.generated\`)
//
// This is the recorded identity of the shipped capability manifest: the SHA-256 of
// the canonical bytes \`buildCapabilityManifest()\` produces from the typed sources.
// \`registry.generated.test.ts\` recomputes it on every test run, so ANY change to the
// navigation route ids, the control-anchor declarations, the tool names, the
// repository command types or one word of nurse-facing help content fails the build
// until this file is regenerated and reviewed. That is the stale-manifest gate.
//
// The counts and byte length are recorded alongside the hash purely so the diff of a
// regeneration is readable: a hash changing on its own says nothing about what moved.

export const GENERATED_CAPABILITY_MANIFEST = Object.freeze({
  schemaVersion: ${identity.schemaVersion},
  manifestSha256: "${identity.manifestSha256}",
  entryCount: ${identity.entryCount},
  anchorCount: ${identity.anchorCount},
  canonicalByteLength: ${identity.canonicalByteLength},
});
`;
}

describe("capability manifest — generated hash tracks the typed sources", () => {
  it(
    UPDATING
      ? "regenerates registry.generated.ts from the live sources"
      : "the committed manifest hash matches the live sources",
    () => {
      const identity = computeIdentity();

      if (UPDATING) {
        writeFileSync(GENERATED_PATH, renderGeneratedFile(identity), "utf8");
        // The already-imported module still holds the pre-write values in this
        // process, so the file itself is what gets asserted. The next ordinary run is
        // the real check.
        expect(readFileSync(GENERATED_PATH, "utf8")).toContain(identity.manifestSha256);
        return;
      }

      expect(
        {
          schemaVersion: GENERATED_CAPABILITY_MANIFEST.schemaVersion,
          manifestSha256: GENERATED_CAPABILITY_MANIFEST.manifestSha256,
          entryCount: GENERATED_CAPABILITY_MANIFEST.entryCount,
          anchorCount: GENERATED_CAPABILITY_MANIFEST.anchorCount,
          canonicalByteLength: GENERATED_CAPABILITY_MANIFEST.canonicalByteLength,
        },
        "the generated capability manifest is stale — run `pnpm capability:generate` " +
          "and review the diff",
      ).toEqual(identity);
    },
  );

  it("the hash is deterministic across builds", () => {
    // No clock, no randomness, no import-order dependence: the canonical form sorts
    // entries and anchors by id. Without this, a regeneration would produce a fresh
    // hash on an unchanged tree and the gate would cry wolf every build.
    expect(computeIdentity()).toEqual(computeIdentity());
  });

  it("records the registry schema version, not the app build version", () => {
    // The APP build stamp is applied at runtime (`registry.ts`), NOT baked in here:
    // baking it would make the hash change on every deploy and the gate meaningless.
    expect(GENERATED_CAPABILITY_MANIFEST.schemaVersion).toBe(CAPABILITY_SCHEMA_VERSION);
    expect(JSON.stringify(GENERATED_CAPABILITY_MANIFEST)).not.toContain("appBuildVersion");
  });
});
