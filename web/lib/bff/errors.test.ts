import { describe, expect, it } from "vitest";
import { classifyOptimizeError, errorDetailMessage, extractErrorDetail } from "@/lib/bff/errors";

describe("classifyOptimizeError", () => {
  it("classifies the EXACT plain 404 as expired (recovery)", () => {
    expect(classifyOptimizeError(404, "Optimization job not found", "poll").kind).toBe("expired");
    expect(classifyOptimizeError(404, "Optimization job not found", "events").kind).toBe("expired");
  });

  it("classifies a structured XLSX 404 as known-terminal no-result (NOT expiry)", () => {
    const info = classifyOptimizeError(
      404,
      { message: "No feasible solution is available.", status: "infeasible" },
      "xlsx",
    );
    expect(info.kind).toBe("no-result");
    expect(info.jobStatus).toBe("infeasible");
  });

  // Negative cases — the exact bug the review flagged: nothing else may become "expired".
  it("does NOT classify an unrelated 404 as expired", () => {
    expect(classifyOptimizeError(404, "Some other 404", "poll").kind).toBe("unknown");
    expect(classifyOptimizeError(404, "optimization job not found", "poll").kind).toBe("unknown"); // wrong case
  });

  it("does NOT classify a detail-less 404 as expired", () => {
    expect(classifyOptimizeError(404, null, "poll").kind).toBe("unknown");
    expect(classifyOptimizeError(404, undefined).kind).toBe("unknown");
  });

  it("does NOT classify the no-result detail as no-result off the XLSX endpoint", () => {
    expect(
      classifyOptimizeError(404, { message: "No feasible solution is available." }, "poll").kind,
    ).toBe("unknown");
    // Also unknown when the endpoint is omitted entirely.
    expect(classifyOptimizeError(404, { message: "No feasible solution is available." }).kind).toBe(
      "unknown",
    );
  });

  it("classifies the 409 'Result is not ready yet.' as non-terminal", () => {
    const info = classifyOptimizeError(
      409,
      { message: "Result is not ready yet.", status: "running" },
      "xlsx",
    );
    expect(info.kind).toBe("not-ready");
  });

  it("keeps other structured 409s as conflict (endpoint-specific status)", () => {
    expect(
      classifyOptimizeError(409, {
        message: "Optimization job has already finished.",
        status: "optimal",
      }).kind,
    ).toBe("conflict");
    expect(
      classifyOptimizeError(409, {
        message: "Cannot delete a running optimization job.",
        status: "running",
      }).kind,
    ).toBe("conflict");
  });

  it("classifies 429 and 413", () => {
    expect(
      classifyOptimizeError(429, "Too many optimization jobs are already queued or running").kind,
    ).toBe("queue-full");
    expect(classifyOptimizeError(413, "Scheduling YAML is too large").kind).toBe("too-large");
  });
});

describe("detail tolerance (string or object)", () => {
  it("extracts detail from a FastAPI error body", () => {
    expect(extractErrorDetail({ detail: "Optimization job not found" })).toBe(
      "Optimization job not found",
    );
    expect(
      extractErrorDetail({ detail: { message: "Result is not ready yet.", status: "running" } }),
    ).toEqual({
      message: "Result is not ready yet.",
      status: "running",
    });
    expect(extractErrorDetail(null)).toBeNull();
  });

  it("reads a message from string and object details", () => {
    expect(errorDetailMessage("plain")).toBe("plain");
    expect(errorDetailMessage({ message: "structured" })).toBe("structured");
    expect(errorDetailMessage({ status: "running" })).toBe("");
    expect(errorDetailMessage(null)).toBe("");
  });
});
