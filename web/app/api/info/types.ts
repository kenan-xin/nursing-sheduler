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

// The only two valid `/info` shapes (app.py::info): a `ready` identity report at
// HTTP 200, or an `unavailable` identity report with a string `reason` at 503.
// Any other status value, missing/mistyped field, extra key, or HTTP pairing is
// rejected by the validator as `invalid_upstream_response`.
export type InfoResponse =
  | ({ status: "ready" } & InfoIdentity)
  | ({ status: "unavailable"; reason: string } & InfoIdentity);

// The BFF-synthesized fail-closed body for a network failure, timeout, or an
// upstream response that isn't a well-formed `/info` payload. Distinct `reason`
// values let callers tell "backend never answered" apart from "backend answered
// with something we can't trust" without parsing free-text messages.
export interface InfoUnavailableResponse {
  status: "unavailable";
  reason: "backend_unreachable" | "invalid_upstream_response";
}
