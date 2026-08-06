// T08 — golden-vector tests for the TypeScript `OptimizeBasisV2` canonical encoder.
//
// This suite reads the SAME committed file `core/tests/test_optimize_basis.py`
// asserts against. The two encoders are independent implementations; pinning both
// to one file is what makes a one-sided change fail rather than silently fork the
// identity of retained Optimize evidence.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BASIS_ENCODING_VERSION,
  computeBasisId,
  encodeOptimizeBasisV2,
  encodeOptimizeBasisV2Bytes,
  OptimizeBasisError,
  sha256Hex,
  type OptimizeBasisV2,
} from "./optimize-basis";

interface GoldenVector {
  name: string;
  basis: OptimizeBasisV2;
  encoded: string;
  encodedUtf8ByteLength: number;
  basisId: string;
}

interface GoldenDocument {
  encodingVersion: string;
  vectors: GoldenVector[];
  invalid: { name: string; basis: OptimizeBasisV2 }[];
}

const GOLDEN_PATH = fileURLToPath(
  new URL("../../../../contracts/optimize-basis-v2.golden.json", import.meta.url),
);

const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf-8")) as GoldenDocument;

describe("OptimizeBasisV2 canonical encoding", () => {
  it("agrees with the golden file on the encoding version", () => {
    expect(golden.encodingVersion).toBe(BASIS_ENCODING_VERSION);
    expect(golden.vectors.length).toBeGreaterThan(0);
    expect(golden.invalid.length).toBeGreaterThan(0);
  });

  it.each(golden.vectors.map((vector) => [vector.name, vector] as const))(
    "encodes to the exact golden bytes: %s",
    (_name, vector) => {
      expect(encodeOptimizeBasisV2(vector.basis)).toBe(vector.encoded);
      expect(encodeOptimizeBasisV2Bytes(vector.basis).byteLength).toBe(
        vector.encodedUtf8ByteLength,
      );
    },
  );

  it.each(golden.vectors.map((vector) => [vector.name, vector] as const))(
    "derives the golden basisId: %s",
    async (_name, vector) => {
      await expect(computeBasisId(vector.basis)).resolves.toBe(vector.basisId);
      // The id is the digest of the CANONICAL ENCODING, never of any other form.
      await expect(sha256Hex(encodeOptimizeBasisV2Bytes(vector.basis))).resolves.toBe(
        vector.basisId,
      );
    },
  );

  it.each(golden.invalid.map((vector) => [vector.name, vector] as const))(
    "rejects rather than coerces: %s",
    (_name, vector) => {
      expect(() => encodeOptimizeBasisV2(vector.basis)).toThrow(OptimizeBasisError);
    },
  );

  it("gives every golden vector a distinct basisId", async () => {
    const ids = await Promise.all(golden.vectors.map((vector) => computeBasisId(vector.basis)));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("does not let a boolean alias the matching string", () => {
    const encoded = encodeOptimizeBasisV2({
      ...golden.vectors[0].basis,
      normalizedOptions: { solver: "ortools/cp-sat", prettify: true, timeoutSeconds: 300 },
    });
    expect(encoded).toContain("normalizedOptions.prettify=b:true\n");
    expect(encoded).not.toContain("normalizedOptions.prettify=s:true\n");
  });

  it("escapes a newline so a value cannot forge a second field line", () => {
    const encoded = encodeOptimizeBasisV2({
      ...golden.vectors[0].basis,
      serializerVersion: "x\nsolverSemanticVersion=s:forged",
    });
    // The forged text survives as escaped CONTENT of the serializerVersion line.
    // What must not happen is it becoming a LINE of its own, so the assertion is
    // on the line structure, not on a substring of the whole document.
    const lines = encoded.split("\n");
    expect(lines).not.toContain("solverSemanticVersion=s:forged");
    expect(lines.filter((line) => line.startsWith("solverSemanticVersion="))).toEqual([
      `solverSemanticVersion=s:${golden.vectors[0].basis.solverSemanticVersion}`,
    ]);
    // Header + 11 fields, each LF-terminated, so the split yields one trailing "".
    expect(lines).toHaveLength(13);
  });

  it("rejects a basis whose object shape is missing entirely", () => {
    expect(() => encodeOptimizeBasisV2(null as unknown as OptimizeBasisV2)).toThrow(
      OptimizeBasisError,
    );
  });
});
