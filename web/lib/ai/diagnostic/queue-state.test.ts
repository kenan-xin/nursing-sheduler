// T10 — the capacity/queue/non-preemption view. Seven diagnostics must not block
// one ordinary job (the reserved slot), and a running diagnostic must never be
// silently pre-empted — the ordinary run stays admitted and the UI offers Cancel
// diagnostic truthfully.

import { describe, expect, it } from "vitest";
import {
  deriveDiagnosticQueueView,
  isDiagnosticCapacityRejection,
  type DiagnosticQueueJobFact,
} from "./queue-state";

function fact(over: Partial<DiagnosticQueueJobFact>): DiagnosticQueueJobFact {
  return { jobId: "j", purpose: "ordinary", state: "queued", owns: true, ...over };
}

describe("deriveDiagnosticQueueView", () => {
  it("is idle when no ordinary is queued behind a diagnostic", () => {
    const view = deriveDiagnosticQueueView([
      fact({ jobId: "ord", purpose: "ordinary", state: "queued", owns: true }),
    ]);
    expect(view.ordinaryBlockedByDiagnostic).toBe(false);
    expect(view.offerCancelDiagnostic).toBe(false);
  });

  it("offers Cancel diagnostic when an OWNED running diagnostic blocks an owned queued ordinary", () => {
    const view = deriveDiagnosticQueueView([
      fact({ jobId: "diag", purpose: "assistant_diagnostic", state: "running", owns: true }),
      fact({ jobId: "ord", purpose: "ordinary", state: "queued", owns: true }),
    ]);
    expect(view.ordinaryBlockedByDiagnostic).toBe(true);
    expect(view.offerCancelDiagnostic).toBe(true);
    expect(view.cancelDiagnosticJobId).toBe("diag");
    expect(view.blockingDiagnosticJobId).toBe("diag");
  });

  it("shows the block truthfully but does NOT offer Cancel when the running diagnostic is not owned here", () => {
    const view = deriveDiagnosticQueueView([
      fact({ jobId: "diag", purpose: "assistant_diagnostic", state: "running", owns: false }),
      fact({ jobId: "ord", purpose: "ordinary", state: "queued", owns: true }),
    ]);
    expect(view.ordinaryBlockedByDiagnostic).toBe(true);
    expect(view.offerCancelDiagnostic).toBe(false);
    expect(view.cancelDiagnosticJobId).toBe(null);
  });

  it("is idle when an ordinary is queued but no diagnostic is running", () => {
    const view = deriveDiagnosticQueueView([
      fact({ jobId: "diag", purpose: "assistant_diagnostic", state: "queued", owns: true }),
      fact({ jobId: "ord", purpose: "ordinary", state: "queued", owns: true }),
    ]);
    expect(view.ordinaryBlockedByDiagnostic).toBe(false);
  });

  it("ignores unknown purposes rather than guessing they are diagnostics", () => {
    const view = deriveDiagnosticQueueView([
      fact({ jobId: "x", purpose: "ordinary", state: "running", owns: true }),
      fact({ jobId: "ord", purpose: "ordinary", state: "queued", owns: true }),
    ]);
    expect(view.ordinaryBlockedByDiagnostic).toBe(false);
  });
});

describe("isDiagnosticCapacityRejection", () => {
  it("recognises the backend's reserved-capacity error code", () => {
    // `errors.py::DiagnosticCapacityError.code`. NOT `ordinary_reserved` — that is
    // the store's INTERNAL admission-decision string and never reaches the wire, so
    // accepting it here would only make a typo look like a working match.
    expect(isDiagnosticCapacityRejection("diagnostic_capacity_reserved")).toBe(true);
    expect(isDiagnosticCapacityRejection("ordinary_reserved")).toBe(false);
    expect(isDiagnosticCapacityRejection("job_capacity_exceeded")).toBe(false);
  });

  it("does not recognise an unrelated failure code", () => {
    expect(isDiagnosticCapacityRejection("validation")).toBe(false);
    expect(isDiagnosticCapacityRejection(null)).toBe(false);
    expect(isDiagnosticCapacityRejection(undefined)).toBe(false);
  });
});
