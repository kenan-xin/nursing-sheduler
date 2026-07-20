import { describe, expect, it } from "vitest";
import {
  classifyOptimizeError,
  extractErrorDetail,
  extractStructuredError,
  isExactJobGoneError,
  isExactJobGoneResponse,
  OptimizeApiError,
} from "@/lib/bff/errors";

// Helper: the code-first `{ error: { ... } }` envelope every application, cursor,
// and scheduling-content failure ships.
const envelope = (error: Record<string, unknown>) => ({ error });

describe("classifyOptimizeError — code-first", () => {
  it("classifies job_not_found as recovery, regardless of endpoint", () => {
    expect(
      classifyOptimizeError(404, envelope({ code: "job_not_found", message: "gone" }), "poll").kind,
    ).toBe("job-not-found");
    expect(
      classifyOptimizeError(404, envelope({ code: "job_not_found", message: "gone" }), "events")
        .kind,
    ).toBe("job-not-found");
  });

  it("classifies the expired event cursor and carries oldest_event_id", () => {
    const info = classifyOptimizeError(
      409,
      envelope({
        code: "event_cursor_expired",
        message: "Requested event history is no longer retained.",
        oldest_event_id: "v1.abc.def",
      }),
      "events",
    );
    expect(info.kind).toBe("event-cursor-expired");
    expect(info.oldestEventId).toBe("v1.abc.def");
  });

  it("classifies the invalid event cursor", () => {
    expect(
      classifyOptimizeError(
        400,
        envelope({
          code: "invalid_event_cursor",
          message: "Last-Event-ID is not valid for this job.",
        }),
        "events",
      ).kind,
    ).toBe("invalid-event-cursor");
  });

  it("maps both artifact codes to no-artifact (not job expiry)", () => {
    expect(
      classifyOptimizeError(404, envelope({ code: "job_artifact_not_found", message: "x" }), "xlsx")
        .kind,
    ).toBe("no-artifact");
    expect(
      classifyOptimizeError(409, envelope({ code: "job_artifact_not_ready", message: "x" }), "xlsx")
        .kind,
    ).toBe("no-artifact");
  });

  it("classifies capacity and lifecycle conflicts by code", () => {
    expect(
      classifyOptimizeError(429, envelope({ code: "job_capacity_exceeded", message: "x" })).kind,
    ).toBe("queue-full");
    expect(
      classifyOptimizeError(409, envelope({ code: "job_operation_not_allowed", message: "x" }))
        .kind,
    ).toBe("conflict");
    expect(
      classifyOptimizeError(409, envelope({ code: "job_operation_contention", message: "x" })).kind,
    ).toBe("conflict");
  });

  it("classifies scheduling-content 422 codes as validation and keeps issues", () => {
    const issues = [{ path: ["solver"], code: "unsupported_value", message: "no" }];
    const info = classifyOptimizeError(
      422,
      envelope({ code: "unsupported_solver", message: "Unsupported solver.", issues }),
    );
    expect(info.kind).toBe("validation");
    expect(info.issues).toEqual(issues);
    for (const code of [
      "workspace_not_ready",
      "invalid_scheduling_data",
      "unsupported_workspace_version",
    ]) {
      expect(classifyOptimizeError(422, envelope({ code, message: "m" })).kind).toBe("validation");
    }
  });

  it("classifies BFF-synthesized fail-closed codes", () => {
    expect(
      classifyOptimizeError(502, envelope({ code: "backend_unreachable", message: "x" })).kind,
    ).toBe("backend-unreachable");
    expect(
      classifyOptimizeError(503, envelope({ code: "backend_unready", message: "x" })).kind,
    ).toBe("backend-unready");
  });

  it("treats an unrecognized structured code as server-error (5xx) or unknown", () => {
    expect(
      classifyOptimizeError(500, envelope({ code: "server_error", message: "boom" })).kind,
    ).toBe("server-error");
    expect(classifyOptimizeError(418, envelope({ code: "teapot", message: "?" })).kind).toBe(
      "unknown",
    );
  });
});

describe("classifyOptimizeError — FastAPI detail fallback", () => {
  it("classifies the exact 413 (detail form)", () => {
    const info = classifyOptimizeError(413, { detail: "Scheduling YAML is too large" });
    expect(info.kind).toBe("too-large");
    expect(info.code).toBeNull();
    expect(info.message).toBe("Scheduling YAML is too large");
  });

  it("classifies a 400 parse/source failure as request-invalid", () => {
    expect(
      classifyOptimizeError(400, { detail: "Either 'file' or 'yaml_content' must be provided" })
        .kind,
    ).toBe("request-invalid");
  });

  it("classifies a native 422 request-schema array as request-invalid", () => {
    expect(
      classifyOptimizeError(422, { detail: [{ loc: ["body"], msg: "field required" }] }).kind,
    ).toBe("request-invalid");
  });

  it("falls back to unknown for an unstructured non-error body", () => {
    expect(classifyOptimizeError(404, null).kind).toBe("unknown");
    expect(classifyOptimizeError(404, { something: "else" }).kind).toBe("unknown");
  });
});

describe("extractStructuredError / extractErrorDetail", () => {
  it("reads a code-first envelope only when error.code is a non-empty string", () => {
    expect(extractStructuredError(envelope({ code: "job_not_found", message: "gone" }))).toEqual({
      code: "job_not_found",
      message: "gone",
      oldest_event_id: undefined,
      issues: undefined,
    });
    expect(extractStructuredError(envelope({ code: "" }))).toBeNull();
    expect(extractStructuredError({ detail: "x" })).toBeNull();
    expect(extractStructuredError(null)).toBeNull();
  });

  it("reads the FastAPI detail field", () => {
    expect(extractErrorDetail({ detail: "Scheduling YAML is too large" })).toBe(
      "Scheduling YAML is too large",
    );
    expect(extractErrorDetail(null)).toBeNull();
  });
});

describe("OptimizeApiError", () => {
  it("carries the classifier verdict and a usable message", () => {
    const error = new OptimizeApiError(
      409,
      envelope({
        code: "event_cursor_expired",
        message: "history gone",
        oldest_event_id: "v1.a.b",
      }),
      "events",
    );
    expect(error.status).toBe(409);
    expect(error.info.kind).toBe("event-cursor-expired");
    expect(error.info.oldestEventId).toBe("v1.a.b");
    expect(error.message).toBe("history gone");
  });

  it("synthesizes a message when the body carries none", () => {
    expect(new OptimizeApiError(500, null).message).toBe("Optimize request failed (500)");
  });
});

describe("exact job-gone proof", () => {
  it("requires status 404 and the exact nonempty structured envelope", () => {
    const valid = envelope({ code: "job_not_found", message: "gone" });
    expect(isExactJobGoneResponse(404, valid)).toBe(true);
    expect(isExactJobGoneError(new OptimizeApiError(404, valid, "poll"))).toBe(true);
    expect(isExactJobGoneResponse(500, valid)).toBe(false);
    expect(isExactJobGoneResponse(404, envelope({ code: "job_not_found" }))).toBe(false);
    expect(isExactJobGoneResponse(404, envelope({ code: "job_not_found", message: "" }))).toBe(
      false,
    );
    expect(
      isExactJobGoneResponse(
        404,
        envelope({ code: "job_not_found", message: "gone", unexpected: true }),
      ),
    ).toBe(false);
  });
});
