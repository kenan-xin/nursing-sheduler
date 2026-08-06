// Backend core/nurse_scheduling/server/app.py::info_payload — the closed
// snake_case identity contract. `web/app/api/info/validate.ts` parses upstream
// bytes into exactly this shape (reconstructing the response field-by-field, not
// relaying raw bytes), so an unknown/private/extra field (e.g. a leaked
// `backend_url`) can never reach the browser.
export interface InfoIdentity {
  service_name: string;
  api_version: string;
  app_version: string;
  deployment_id: string;
  instance_id: string;
  started_at: string;
  job_backend: string;
  job_store_id: string;
}

// core/nurse_scheduling/server/semantic_profile.py — the backend's SCHEDULING
// SEMANTICS, not its build. `app_version` moves with every commit; these move
// only when the meaning of a solved model changes, which is what makes them safe
// to compare two runs' evidence across (T08).
//
// The browser reads this before submitting, sends it back on the submission, and
// the backend rejects a submission prepared under a profile it has since left.
export interface InfoSemanticProfile {
  submission_contract_version: string;
  solver_semantic_version: string;
  backend_capability_version: string;
}

// The only two valid `/info` shapes (app.py::info): a `ready` identity report at
// HTTP 200, or an `unavailable` identity report with a string `reason` at 503.
// Any other status value, missing/mistyped field, extra key, or HTTP pairing is
// rejected by the validator as `invalid_upstream_response`.
export type InfoResponse =
  | ({ status: "ready"; semantic_profile: InfoSemanticProfile } & InfoIdentity)
  | ({
      status: "unavailable";
      reason: string;
      semantic_profile: InfoSemanticProfile;
    } & InfoIdentity);

// The BFF-synthesized fail-closed body for a network failure, timeout, or an
// upstream response that isn't a well-formed `/info` payload. Distinct `reason`
// values let callers tell "backend never answered" apart from "backend answered
// with something we can't trust" without parsing free-text messages.
export interface InfoUnavailableResponse {
  status: "unavailable";
  reason: "backend_unreachable" | "invalid_upstream_response";
}
