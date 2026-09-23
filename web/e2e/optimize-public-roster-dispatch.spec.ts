// Public-Next-dispatch proof for the /roster BFF route (B3 fixup nested).
//
// The real-transport vitest cases in `optimize.integration.test.ts` import the
// route's `GET` handler and invoke it with a constructed `Request`. That proves
// handler-to-upstream wiring but NOT public Next App Router registration: a
// missing or misplaced `route.ts` still builds while those tests pass, because
// the framework never gets a chance to 404 a request that never reaches it.
//
// This spec closes that gap. The focused `playwright.public-roster-dispatch
// .config.ts` runs the SAME `pnpm build && pnpm start` launcher as the base
// config (no parallel application launcher), but points Next's
// `BACKEND_API_URL` at a private port this spec binds in `beforeAll`. Then
// `request.get('/api/optimize/<id>/roster')` drives the public Next URL
// through the real App-Router dispatch, the BFF route handler, the readiness
// gate probe, and the JSON relay. A `test.describe.configure({ mode:
// "serial" })` keeps the single backend instance and serializes the cases so
// no second worker fights for the stub port.
//
// The 404 / 409 cases assert the EXACT code-first envelope, the
// `application/json` content type, and `cache-control: no-store`. A Next
// framework 404 for a missing API route returns `text/html` with an HTML
// body (not a JSON envelope); therefore the content-type and body
// assertions together fail if `route.ts` is removed or misplaced. No
// production source is touched; the stub backend is the only addition.

import { expect, test } from "@playwright/test";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

// Matches `playwright.public-roster-dispatch.config.ts`. Outside the
// registered-services range so it never collides with a developer's real
// FastAPI on 127.0.0.1:8000.
const BACKEND_HOST = "127.0.0.1";
const BACKEND_PORT = Number(process.env.PUBLIC_ROSTER_TEST_BACKEND_PORT) || 8765;
const READY_PATH = "/ready";
const ROSTER_PATH = "/optimize/opt_public/roster";

// A complete v1 roster-container projection (the backend `roster_view` strips
// `xlsx.base64` before serving).
const ROSTER_CONTAINER = {
  schemaVersion: "roster-container/1",
  people: [{ id: 1 }, { id: 2 }],
  dates: [{ iso: "2026-07-01" }, { iso: "2026-07-02" }],
  solvedDays: [
    [{ kind: "shift", shiftId: "N" }, { kind: "off" }],
    [{ kind: "off" }, { kind: "leave" }],
  ],
  score: 7,
  solverStatus: "OPTIMAL",
  coordinateMap: {
    peopleRows: [3, 4],
    dateColumns: [2, 3],
    firstPeopleRow: 3,
    leadingCols: 1,
    historyCols: 0,
    prettify: true,
  },
  xlsx: {
    name: "nurse-scheduling-opt_public.xlsx",
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  },
};

let server: Server;
let handler: (req: IncomingMessage, res: ServerResponse) => void = () => {};

test.describe("public Next dispatch of /api/optimize/{id}/roster (B3 fixup)", () => {
  // One backend stub for the whole block; serial mode avoids a second worker
  // racing for port 8000.
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    server = createServer((req, res) => {
      // The BFF readiness gate probes `/ready` before forwarding any business
      // request; answer it as ready so the real business path is exercised.
      if (req.url === READY_PATH) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ready" }));
        return;
      }
      handler(req, res);
    });
    await new Promise<void>((resolve) => server.listen(BACKEND_PORT, BACKEND_HOST, resolve));
  });

  test.afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test.afterEach(() => {
    handler = () => {};
  });

  test("relays a 200 roster container through the public Next URL with strict JSON/no-store", async ({
    request,
  }) => {
    const captured: { url: string | undefined } = { url: undefined };
    handler = (req, res) => {
      captured.url = req.url;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(ROSTER_CONTAINER));
    };

    // Relative URL uses Playwright's baseURL → http://127.0.0.1:${PLAYWRIGHT_PORT}.
    // The request drives the real App Router dispatch, not a directly imported
    // handler.
    const response = await request.get(`/api/optimize/opt_public/roster`);

    // The BFF reached the backend at the exact encoded roster path.
    expect(captured.url).toBe(ROSTER_PATH);
    // Body, content type, and cache policy are byte-exact and strict.
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("application/json");
    expect(response.headers()["cache-control"]).toBe("no-store");
    expect(await response.json()).toEqual(ROSTER_CONTAINER);
  });

  test("relays a structured 404 (job_not_found) envelope through the public Next URL, distinguishable from a Next framework 404", async ({
    request,
  }) => {
    const body = {
      error: { code: "job_not_found", message: "Optimisation job not found" },
    };
    const captured: { url: string | undefined } = { url: undefined };
    handler = (req, res) => {
      captured.url = req.url;
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    const response = await request.get(`/api/optimize/opt_public/roster`);

    // The BFF reached the backend at the exact roster path — proving this is a
    // routed BFF outcome, not a Next framework 404 (which never reaches the
    // upstream).
    expect(captured.url).toBe(ROSTER_PATH);
    // A Next framework 404 for a missing API route returns `text/html` with an
    // HTML body. The content-type and body assertions together fail if the
    // route is missing or misplaced — so this case regress-protects the
    // framework-404 swap.
    expect(response.status()).toBe(404);
    expect(response.headers()["content-type"]).toBe("application/json");
    expect(response.headers()["cache-control"]).toBe("no-store");
    expect(await response.json()).toEqual(body);
  });

  test("relays a structured 409 (job_artifact_not_ready) envelope through the public Next URL", async ({
    request,
  }) => {
    const body = {
      error: {
        code: "job_artifact_not_ready",
        message: "The job has not produced a downloadable artifact.",
      },
    };
    const captured: { url: string | undefined } = { url: undefined };
    handler = (req, res) => {
      captured.url = req.url;
      res.writeHead(409, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    const response = await request.get(`/api/optimize/opt_public/roster`);

    expect(captured.url).toBe(ROSTER_PATH);
    expect(response.status()).toBe(409);
    expect(response.headers()["content-type"]).toBe("application/json");
    expect(response.headers()["cache-control"]).toBe("no-store");
    expect(await response.json()).toEqual(body);
  });
});
