// C2F3 — the real server-to-web `JobResponse` contract gate.
//
// Every other parser test in this directory builds its own fixture, which is
// exactly how the strict parser came to reject every real response: T09 added a
// required `request.purpose`, the hand-written fixtures never grew it, and both
// sides stayed internally consistent while disagreeing with each other.
//
// This suite reads bodies captured VERBATIM from real FastAPI responses
// (`contracts/job-response.golden.json`, produced and re-verified by
// `core/tests/test_job_response_contract.py`) and puts them through the exact
// parser the app uses. Nothing here is authored by hand, so the fixtures cannot
// drift away from the backend without one side going red.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { JOB_PURPOSES, type JobPurpose } from "@/lib/bff/types";
import { parseJobResponse } from "./event-payloads";

interface ContractVector {
  name: string;
  method: string;
  path: string;
  status: number;
  purpose: JobPurpose;
  body: Record<string, unknown>;
}

interface ContractDocument {
  contractVersion: string;
  vectors: ContractVector[];
}

const CONTRACT_PATH = fileURLToPath(
  new URL("../../../contracts/job-response.golden.json", import.meta.url),
);

const contract = JSON.parse(readFileSync(CONTRACT_PATH, "utf-8")) as ContractDocument;

describe("real FastAPI job responses against the exact web parser", () => {
  it("reads a contract that covers both purposes and both hops", () => {
    expect(contract.contractVersion).toBe("job-response/v1");
    expect(new Set(contract.vectors.map((vector) => vector.purpose))).toEqual(
      new Set(["ordinary", "assistant_diagnostic"]),
    );
    // The 202 accepted body AND the later poll: the purpose broke both, so both
    // have to be proven, not just the submission.
    expect(new Set(contract.vectors.map((vector) => vector.status))).toEqual(new Set([202, 200]));
  });

  it.each(contract.vectors.map((vector) => [vector.name, vector] as const))(
    "parses and preserves the purpose: %s",
    (_name, vector) => {
      const id = vector.body.id as string;
      const parsed = parseJobResponse(vector.body, id);

      expect(parsed).not.toBeNull();
      expect(parsed?.request.purpose).toBe(vector.purpose);
      expect(JOB_PURPOSES.has(parsed!.request.purpose)).toBe(true);
      // The purpose is not merely accepted — it survives onto the typed value the
      // rest of the app reads, which is what T10's diagnostic surface needs.
      expect(parsed?.id).toBe(id);
    },
  );

  it("still rejects a response whose purpose is outside the closed union", () => {
    const vector = contract.vectors[0];
    const forged = {
      ...vector.body,
      request: { ...(vector.body.request as object), purpose: "speculative" },
    };

    // Discriminating, not merely permissive: an unknown purpose means this client
    // cannot tell which queue the job is in, so it must not be read as ordinary.
    expect(parseJobResponse(forged)).toBeNull();
  });

  it("still rejects a response that omits purpose entirely", () => {
    const vector = contract.vectors[0];
    const { purpose: _dropped, ...request } = vector.body.request as { purpose: string };

    expect(parseJobResponse({ ...vector.body, request })).toBeNull();
  });

  it("still rejects an unknown extra request key", () => {
    const vector = contract.vectors[0];
    const widened = {
      ...vector.body,
      request: { ...(vector.body.request as object), speculative_field: 1 },
    };

    // The exactness that made the missing `purpose` fatal is deliberate and stays.
    expect(parseJobResponse(widened)).toBeNull();
  });

  it("parses the diagnostic's candidate ownership without inventing it", () => {
    const diagnostic = contract.vectors.find((vector) => vector.purpose === "assistant_diagnostic");
    const parsed = parseJobResponse(diagnostic!.body);

    expect(parsed?.request.basis?.parent_basis_id).toBe("a".repeat(64));
    expect(parsed?.request.basis?.transform_digest).toBe("b".repeat(32));
  });
});
