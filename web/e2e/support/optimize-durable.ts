// T16f — deterministic BFF/SSE fixtures + a browser-side route stubber for the
// durable Optimize & Export acceptance journeys. The Playwright specs drive the
// REAL screen (`/optimize-durable-fixture`, which mounts the real controller +
// SSE parser + reconnect + terminal + cleanup pipeline) and intercept the
// same-origin `/api/**` boundary here, so nothing hand-rolls the protocol: the
// journeys prove the assembled client against fixed, contract-valid wire bytes.
//
// Every JobResponse / SSE payload below is byte-shaped to pass the strict T19
// parsers (`lib/query/event-payloads.ts`) — an off-contract field would make the
// client reconcile or reject, so these fixtures double as a living contract.

import type { Page, Route } from "@playwright/test";
import type { JobResponse, JobState, OptimizationOutcome } from "@/lib/bff/types";

// ===========================================================================
// Replay-oracle judge (R6 combined-cold-review P2)
// ===========================================================================
//
// The assembled gate's release proof for "what the browser recorded after
// reload" used to assert only: at least one raw id, none of them pre-reload, and
// the durable cursor present somewhere among them. That predicate accepted three
// false greens the cold review demonstrated by mutation — a DUPLICATED new id
// (`[c, c]` with cursor `c`), a single FOREIGN-job id, and a valid id MIXED with
// a foreign-job id. None of them is a legal replay, and runtime server-side
// validation does not make this browser oracle stronger: the oracle is precisely
// the proof of what the browser saw.
//
// The judge below is pure, so its whole truth table — valid / duplicate /
// foreign / mixed / stale / missing / malformed — is provable in a unit test
// beside it, deterministically, without the Compose stack. The Playwright spec
// supplies one atomic snapshot and this decides.
//
// Job binding is derived through the CANONICAL cursor contract
// (`core/nurse_scheduling/server/event_cursor.py`), not by string prefix matching,
// and the job it is compared AGAINST comes from the pre-reload session rather than
// from any cursor — see `ReplayEvidence.expectedJobId`. The public cursor is
//
//     v1.<unpadded base64url(job_id)>.<unpadded base64url(native_id)>
//
// and a segment is canonical only when its decoded UTF-8 text re-encodes to
// exactly the submitted spelling. Base64 has multiple spellings for the same
// bytes (`MR` and `MQ` both decode to `"1"`), so the round trip is what rejects
// aliases the server never emitted — mirroring `_decode_segment` exactly.
//
// Deliberately NOT asserted: anything about native-id increments. The native id
// is an opaque store token (a decimal int in the memory backend, a `<ms>-<seq>`
// Redis stream id in production); constraining its arithmetic would bind this
// oracle to a storage detail it must not own.

// ===========================================================================
// Exact canonical events-request URL contract
// ===========================================================================
//
// The client builds exactly one shape (`lib/query/optimize.ts:345`):
//
//     /api/optimize/${encodeURIComponent(jobId)}/events
//
// Root-relative, one path segment for the job, no query and no hash. So the
// contract below is ANCHORED to precisely that and nothing else. The previous
// unanchored `/\/optimize\/([^/?#]+)\/events/` matched a legacy path's tail, a
// suffixed path, and extra segments, and the caller then silently DISCARDED
// whatever failed to match — so the authority check judged a filtered projection
// of the evidence instead of the evidence.
//
// Everything here is total: a URL either yields a job id or yields a REASON, and
// the caller must treat a reason as a failure rather than as an absence.

/** The one canonical events path shape, anchored end to end. */
const EVENTS_PATH_PATTERN = /^\/api\/optimize\/([^/]+)\/events$/;

export type EventsUrlParse =
  | { ok: true; jobId: string }
  | { ok: false; url: string; reason: string };

/**
 * Normalise an expected origin, or return `null` when it is unusable.
 *
 * The origin must be supplied by the caller from an INDEPENDENT capture — the
 * page's own `location.origin`, read in the same snapshot as the evidence — never
 * derived from the URL under test. A missing or unparseable origin fails closed:
 * with nothing to compare against, every absolute URL would otherwise be accepted.
 */
export function normalizeExpectedOrigin(origin: string | null | undefined): string | null {
  if (typeof origin !== "string" || origin.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.username.length > 0 || parsed.password.length > 0) return null;
  // `URL.origin` is the canonical scheme://host[:port] form, with the default port
  // elided — so comparing origins never turns on a `:80` spelling difference.
  return parsed.origin;
}

/**
 * Whether a RAW absolute authority (`scheme://host[:port]`, no trailing slash) is
 * the canonical spelling of `origin`.
 *
 * `origin` is already `URL.origin`, i.e. canonical scheme + lowercase host with the
 * default port elided. The only accepted variation is that same origin with its
 * DEFAULT port spelled out, which is the documented equivalence a `Request` may
 * produce. Everything else — any host-case, host-encoding, port-padding,
 * alternate-IP-literal, credential-delimiter or separator difference — is a
 * different byte string and is therefore rejected without needing to be enumerated.
 */
export function isCanonicalRawAuthority(rawAuthority: string, origin: string): boolean {
  if (rawAuthority === origin) return true;
  // The one documented equivalence: `http://host` <-> `http://host:80`, and the
  // https/443 pair. Only when the canonical origin itself elides the port.
  const defaultPort = origin.startsWith("https://") ? ":443" : ":80";
  const originHasExplicitPort = /:\d+$/.test(origin);
  if (!originHasExplicitPort && rawAuthority === `${origin}${defaultPort}`) return true;
  return false;
}

/**
 * Parse one recorded events-request URL against the exact canonical contract.
 *
 * Accepts exactly two RAW spellings and nothing else:
 *
 *   1. the canonical root-relative form the client emits, and
 *   2. the canonical same-origin absolute form a `Request` object exposes.
 *
 * The raw string is validated BEFORE any `URL` normalization, because WHATWG
 * parsing silently rewrites the very spellings this contract exists to reject.
 * Normalizing first made all four of these same-origin aliases green:
 *
 *   api/optimize/job-A/events                   (path-relative, no leading slash)
 *   //localhost:51236/api/optimize/job-A/events  (protocol-relative)
 *   /api/optimize/old/../job-A/events            (dot-segment alias)
 *   "  /api/optimize/job-A/events  "             (whitespace alias)
 *
 * `URL` erased each one into the canonical pathname before the exact path check
 * ever ran, so a real client-side URL regression could still reach the same server
 * route while this gate stayed green.
 *
 * Also rejects a non-canonical percent-encoding of the job segment by requiring
 * `encodeURIComponent(decodeURIComponent(seg)) === seg` — the same
 * canonical-spelling discipline the cursor codec applies. `URL` is still used, but
 * only for the ORIGIN comparison, and only after the raw form has been accepted.
 */
export function parseEventsRequestUrl(url: string, expectedOrigin: string | null): EventsUrlParse {
  const fail = (reason: string): EventsUrlParse => ({ ok: false, url, reason });
  if (typeof url !== "string" || url.length === 0) return fail("empty URL");

  // ORIGIN AUTHORITY. Without an expected origin there is nothing to bind an
  // absolute URL to, so this fails closed rather than falling back to "any host".
  const origin = normalizeExpectedOrigin(expectedOrigin);
  if (origin === null) {
    return fail(`no valid expected origin was captured (got ${String(expectedOrigin)})`);
  }

  // ---- RAW-FORM VALIDATION, before any normalization ----------------------
  if (url !== url.trim()) return fail("leading or trailing whitespace is not canonical");
  if (/\s/.test(url)) return fail("whitespace inside the URL is not canonical");
  if (url.includes("\\")) return fail("backslashes are not canonical");
  if (url.includes("?")) return fail("query string is not part of the contract");
  if (url.includes("#")) return fail("hash is not part of the contract");

  let rawPath: string;
  if (url.startsWith("//")) {
    // Protocol-relative. Normalization would resolve it onto the base scheme and,
    // for a same-origin host, produce an indistinguishable result.
    return fail("protocol-relative URLs are not part of the contract");
  } else if (url.startsWith("/")) {
    rawPath = url;
  } else if (/^https?:\/\//.test(url)) {
    // Absolute `Request` form. Split the raw string at the first `/` after the
    // scheme so BOTH halves are judged as written: the authority against the
    // canonical origin byte-for-byte, and the path against the anchored shape.
    const authorityEnd = url.indexOf("/", url.indexOf("://") + 3);
    if (authorityEnd === -1) return fail("absolute URL has no path");
    const rawAuthority = url.slice(0, authorityEnd);
    // ---- RAW AUTHORITY VALIDATION ----------------------------------------
    //
    // Validating only the raw PATH was not enough: `new URL()` still normalized
    // the authority, so every one of these same-origin aliases was accepted for
    // expected origin `http://localhost:51236`:
    //
    //   http://LOCALHOST:51236/...       host case
    //   http://%6cocalhost:51236/...     percent-encoded host
    //   http://@localhost:51236/...      empty credential delimiter
    //   http://localhost:051236/...      zero-padded port
    //   http://2130706433/...            integer IPv4 (for 127.0.0.1)
    //
    // None of them is the spelling a `Request` exposes; they become
    // indistinguishable only after WHATWG canonicalization. So rather than
    // enumerating alias classes (host case, encoding, padded ports, integer/hex/
    // octal IPv4, IPv6 bracket forms, stray separators...) and hoping the list is
    // complete, the raw authority must equal the canonical origin BYTE FOR BYTE.
    // That admits exactly one spelling and therefore closes the whole class.
    //
    // The single documented exception is the explicit default port, because
    // `URL.origin` elides it while a `Request` may spell it out.
    if (!isCanonicalRawAuthority(rawAuthority, origin)) {
      return fail(`raw authority ${rawAuthority} is not the canonical origin ${origin}`);
    }
    rawPath = url.slice(authorityEnd);
  } else if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) {
    return fail("only http(s) URLs are part of the contract");
  } else {
    return fail("path-relative URLs are not part of the contract");
  }

  // The raw path must match the canonical shape exactly. This is what rejects dot
  // segments, empty segments, suffixes and extra segments as WRITTEN rather than as
  // normalized: `/api/optimize/old/../job-A/events` has five raw segments here.
  const matched = EVENTS_PATH_PATTERN.exec(rawPath);
  if (matched === null) {
    return fail(`raw path does not match /api/optimize/<jobId>/events: ${rawPath}`);
  }

  // ---- ORIGIN COMPARISON, only now, and only for the origin ---------------
  let parsed: URL;
  try {
    parsed = new URL(url, origin);
  } catch {
    return fail("unparseable URL");
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return fail("credentials are not part of the contract");
  }
  if (parsed.origin !== origin) {
    return fail(`origin ${parsed.origin} is not the page origin ${origin}`);
  }

  const segment = matched[1];
  let jobId: string;
  try {
    jobId = decodeURIComponent(segment);
  } catch {
    return fail(`job segment is not valid percent-encoding: ${segment}`);
  }
  if (jobId.length === 0) return fail("job segment decodes to an empty id");
  if (encodeURIComponent(jobId) !== segment) {
    return fail(`job segment is not a canonical encodeURIComponent spelling: ${segment}`);
  }
  return { ok: true, jobId };
}

export interface EventsAuthorityVerdict {
  ok: boolean;
  failures: string[];
  /** Every distinct job id parsed out, in first-seen order. */
  jobIds: string[];
}

/**
 * Judge EVERY captured events-related URL against `expectedJobId`, failing closed
 * on any that is malformed or foreign. Nothing is filtered or deduplicated away
 * before judging: a URL the wrapper classified as events-related is evidence, and
 * unparseable evidence is a failure rather than a non-event.
 */
export function judgeEventsAuthority(
  urls: readonly string[],
  expectedJobId: string | null,
  expectedOrigin: string | null,
): EventsAuthorityVerdict {
  const failures: string[] = [];
  const jobIds: string[] = [];

  if (expectedJobId === null || expectedJobId.length === 0) {
    return {
      ok: false,
      failures: ["no independent job authority to compare events paths against"],
      jobIds,
    };
  }
  if (normalizeExpectedOrigin(expectedOrigin) === null) {
    return {
      ok: false,
      failures: [`no valid expected origin was captured (got ${String(expectedOrigin)})`],
      jobIds,
    };
  }
  if (urls.length === 0) {
    return { ok: false, failures: ["no events request was observed at all"], jobIds };
  }

  for (const url of urls) {
    const parsed = parseEventsRequestUrl(url, expectedOrigin);
    if (!parsed.ok) {
      failures.push(`events URL rejected (${parsed.reason})`);
      continue;
    }
    if (!jobIds.includes(parsed.jobId)) jobIds.push(parsed.jobId);
    if (parsed.jobId !== expectedJobId) {
      failures.push(
        `events URL targets job "${parsed.jobId}", not the active "${expectedJobId}": ${url}`,
      );
    }
  }

  return { ok: failures.length === 0, failures, jobIds };
}

// ===========================================================================
// The live replay test's phase bounds and total budget
// ===========================================================================
//
// These live here, beside the judge, for two reasons: they are a single source of
// truth for the spec that consumes them, and `e2e/support/**` is unit-testable
// (Playwright specs are excluded from vitest by filename), so the derivation below
// is guarded by assertions rather than by a comment.
//
// The live replay test is intentionally multi-phase and every phase already carries
// an explicit bound. Playwright's DEFAULT per-test budget is smaller than the sum of
// those bounds, so a run in which each phase merely behaved legitimately-slowly
// could exhaust the test while no phase had exhausted itself. That is what the cold
// review observed: run 4 of 6 hit the default while still inside its own phase
// bounds, and the abandoned 87-person solve then starved the following abort test's
// fixture mount — one under-specified budget, two failures.

/** Playwright's default per-test timeout, kept for the sufficiency comparison. */
export const PLAYWRIGHT_DEFAULT_TEST_TIMEOUT = 30_000;

/**
 * EVERY sequential bound on the live replay test's positive path, one named entry
 * each. The total is computed by summing this object's values, so a bound that is
 * added here is automatically inside the cap and a bound that exists in the test
 * but is MISSING here is caught by the unit suite's key-set assertion — the budget
 * cannot silently drift away from the work it covers.
 *
 * The previous cap summed only the five stream phases (72s) and then added an
 * unproved 48s "margin". That was incomplete by construction: `page.goto` alone
 * permits 30s, the reload navigation another 30s, and four web-first expectations
 * 5s each, so a schedule in which every operation stayed inside its own bound
 * could reach ~152s and still blow a 120s cap. Every one of those is now an
 * EXPLICIT local timeout passed at the call site, which is what makes this sum a
 * real ceiling rather than an estimate of defaults.
 */
export const REPLAY_BOUNDS = {
  // --- initialization: TWO sequential addInitScript calls -------------------
  // One key each, both `withBound`-enforced. A single shared entry could not tell
  // an omitted call from a fast one, and the replay budget previously had no
  // initialization entry at all even though it calls the same helper.
  injectObservationScript: 5_000,
  injectFixtureYaml: 5_000,
  // --- gotoFixture, all explicit at the call site ---------------------------
  gotoFixtureNavigation: 20_000,
  fixtureRootVisible: 5_000,
  screenVisible: 5_000,
  anonymizeAttributeRead: 5_000,
  anonymizeToggleClick: 5_000,
  anonymizeCheckedAssertion: 5_000,
  submitEnabledAssertion: 5_000,
  // --- submission + early ownership ----------------------------------------
  submitClick: 5_000,
  acceptedJobIdPoll: 10_000,
  // --- the five named stream phases ----------------------------------------
  firstResponsePoll: 15_000,
  keepaliveWindow: 12_000,
  resumedScreenVisible: 10_000,
  resumedHeaderPoll: 15_000,
  judgePoll: 20_000,
  // --- evaluate/navigation work with no Playwright timeout parameter --------
  // `page.evaluate` takes no per-call timeout, so each of these is enforced by
  // `withBound()` in the spec rather than merely budgeted for here.
  //
  // `observationEvaluates` covers the STANDALONE observation reads — the ones
  // outside any poll, since a poll's own bound already covers the evaluates it
  // repeats. In the replay test there are exactly four: `readSseObs` for the
  // accepted-id check and again after the keepalive window, and
  // `readReplayObservation` for the first resumed request and for the final
  // snapshot. At `OBSERVATION_EVALUATE_BOUND` each, that is 4 x 5s. (This replaced
  // a single 5s `finalObservationEvaluate` entry, which accounted for one of the
  // four — found while applying the same enumeration method to the tiny test.)
  // Calibrated against measurement, not guessed. Under a deliberately extreme
  // synthetic overload (loadavg ~24 on 10 cores) this in-page evaluate — freeze,
  // a <=200ms stabilisation loop, a regex over the recorded chunks, one
  // sessionStorage write — exceeded 15s and `withBound` correctly named it. The
  // work is ~1s unloaded, so 30s remains a tight, meaningful ceiling on something
  // that must never hang, while no longer failing on host saturation alone.
  freezeAndSnapshotEvaluate: 30_000,
  reloadNavigation: 20_000,
  snapshotReadEvaluate: 5_000,
  observationEvaluates: 20_000,
  // --- one small named allowance, AFTER the full sum ------------------------
  // Worker startup, fixture teardown and OS scheduling jitter between steps.
  schedulerAllowance: 8_000,
} as const;

// Totals: 10s initialization + 50s fixture setup + 15s submit/arm
// + 72s stream phases + 75s evaluate/navigation + 8s scheduler allowance = 230s,
// comfortably above the ~152s worst-case legitimate schedule the review constructed
// and comfortably below the product's 300s solve limit.

/** One standalone observation `page.evaluate`, enforced by `withBound()`. */
export const OBSERVATION_EVALUATE_BOUND = 5_000;

/**
 * The bounds `gotoFixture` spends, shared by BOTH assembled tests. Named as a key
 * list rather than a literal so the two budgets cannot drift apart from each other
 * or from the helper's actual call sites.
 */
export const GOTO_FIXTURE_BOUND_KEYS = [
  "gotoFixtureNavigation",
  "fixtureRootVisible",
  "screenVisible",
  "anonymizeAttributeRead",
  "anonymizeToggleClick",
  "anonymizeCheckedAssertion",
  "submitEnabledAssertion",
] as const;

/** The total `gotoFixture` may spend (50s). */
export const GOTO_FIXTURE_BOUNDS_TOTAL = GOTO_FIXTURE_BOUND_KEYS.reduce(
  (total, key) => total + REPLAY_BOUNDS[key],
  0,
);

/**
 * EVERY sequential bound on the TINY assembled test's positive path.
 *
 * Same defect shape the review blocked on for the replay test, in its sibling: an
 * internal 90s completion poll cannot be governed by Playwright's 30s default, so
 * the assertion could never have reached its own bound. Same repair method — one
 * named entry per sequential bound, total computed by summing the object, key set
 * pinned by the unit suite so an omission fails loudly.
 *
 * `fixtureSetup` reuses the shared `gotoFixture` total rather than restating the
 * seven literals, so a change there follows into both budgets.
 */
export const TINY_BOUNDS = {
  /** One key per `addInitScript` call, both `withBound`-enforced. */
  injectObservationScript: REPLAY_BOUNDS.injectObservationScript,
  injectFixtureYaml: REPLAY_BOUNDS.injectFixtureYaml,
  fixtureSetup: GOTO_FIXTURE_BOUNDS_TOTAL,
  /** Explicit: the default action timeout is 0, i.e. bounded only by the total. */
  submitClick: 5_000,
  /**
   * TWO sequential polls, counted separately. A single shared 15s key covered both
   * call sites with one entry, so the advertised ceiling was 15s short of the
   * schedule the test can actually run.
   */
  acceptedIdPoll: 15_000,
  sseResponsePoll: 15_000,
  /** One standalone `readSseObs` after the polls. */
  observationEvaluates: OBSERVATION_EVALUATE_BOUND,
  /**
   * The terminal auto-chain: artifact fetch, people-id restore, download, DELETE.
   * Unchanged at 90s — the completion poll is the point of this test and is not
   * weakened to fit a cap.
   */
  completionPoll: 90_000,
  /** The DELETE freed the single slot, so a new run is permitted again. */
  slotFreedAssertion: 30_000,
  /** Worker startup and OS scheduling jitter between steps. */
  schedulerAllowance: 8_000,
} as const;

/** The exact key set of `TINY_BOUNDS`, pinned so an omission fails loudly. */
export const TINY_BOUND_KEYS = Object.keys(TINY_BOUNDS) as ReadonlyArray<keyof typeof TINY_BOUNDS>;

/** 5 + 5 + 50 + 5 + 15 + 15 + 5 + 90 + 30 + 8 = 228s. */
export const TINY_TEST_TIMEOUT = Object.values(TINY_BOUNDS).reduce(
  (total, bound) => total + bound,
  0,
);

/**
 * EVERY sequential bound on the ISOLATED ABORT test's positive path.
 *
 * The third instance of the same incomplete-budget class. That test had no
 * `test.setTimeout` and the assembled config declares no suite timeout, so
 * Playwright's 30s default governed a schedule whose own local bounds already
 * summed past 137s — and its submit click had no explicit action timeout at all,
 * where the default is 0 (bounded only by the total).
 *
 * `abortUrlSettle` is the 30s window the round-4 investigation established: under
 * host saturation the main-frame URL lags a COMMITTED navigation, and that window
 * is what makes the wait bounded rather than a weaker claim.
 */
export const ABORT_BOUNDS = {
  injectObservationScript: REPLAY_BOUNDS.injectObservationScript,
  injectFixtureYaml: REPLAY_BOUNDS.injectFixtureYaml,
  fixtureSetup: GOTO_FIXTURE_BOUNDS_TOTAL,
  /** Explicit: the default action timeout is 0, i.e. bounded only by the total. */
  submitClick: 5_000,
  firstResponsePoll: 15_000,
  /** One standalone `readSseObs` backing the first-response poll's final read. */
  observationEvaluates: OBSERVATION_EVALUATE_BOUND,
  /** The intentional navigate-away, explicit at the callsite. */
  abortNavigation: 30_000,
  /** Main-frame URL settle after a committed navigation. */
  abortUrlSettle: 30_000,
  /** The tail wait that lets the BFF observe and log the upstream cancel. */
  bffObservationTail: 2_000,
  schedulerAllowance: 8_000,
} as const;

/** The exact key set of `ABORT_BOUNDS`, pinned so an omission fails loudly. */
export const ABORT_BOUND_KEYS = Object.keys(ABORT_BOUNDS) as ReadonlyArray<
  keyof typeof ABORT_BOUNDS
>;

/** 5 + 5 + 50 + 5 + 15 + 5 + 30 + 30 + 2 + 8 = 155s. */
export const ABORT_TEST_TIMEOUT = Object.values(ABORT_BOUNDS).reduce(
  (total, bound) => total + bound,
  0,
);

/** The exact key set of `REPLAY_BOUNDS`, pinned so an omission fails loudly. */
export const REPLAY_BOUND_KEYS = Object.keys(REPLAY_BOUNDS) as ReadonlyArray<
  keyof typeof REPLAY_BOUNDS
>;

/** The complete cap: the sum of every enumerated bound. */
export const REPLAY_TEST_TIMEOUT = Object.values(REPLAY_BOUNDS).reduce(
  (total, bound) => total + bound,
  0,
);

/** The five named stream phases, kept as a subtotal for the review's comparison. */
export const REPLAY_PHASE_BOUNDS =
  REPLAY_BOUNDS.firstResponsePoll +
  REPLAY_BOUNDS.keepaliveWindow +
  REPLAY_BOUNDS.resumedScreenVisible +
  REPLAY_BOUNDS.resumedHeaderPoll +
  REPLAY_BOUNDS.judgePoll;

/** The product's own solve ceiling; the cap must stay meaningfully inside it. */
export const PRODUCT_SOLVE_LIMIT = 300_000;

// Individual re-exports for the spec's call sites, so no literal is duplicated.
export const FIRST_BYTE_TIMEOUT = REPLAY_BOUNDS.firstResponsePoll;
export const KEEPALIVE_WINDOW = REPLAY_BOUNDS.keepaliveWindow;
export const RESUMED_SCREEN_TIMEOUT = REPLAY_BOUNDS.resumedScreenVisible;
export const RESUMED_HEADER_TIMEOUT = REPLAY_BOUNDS.resumedHeaderPoll;
export const JUDGE_POLL_TIMEOUT = REPLAY_BOUNDS.judgePoll;

// ===========================================================================
// Anti-contamination cleanup lifecycle
// ===========================================================================
//
// A failed or timed-out replay test must not leave the 87-person solve running:
// the fixture submits at the form's 300s default, and an orphaned solver starves
// the next lane's fixture mount (that is how one 30s timeout produced 29/2).
//
// The backend contract this follows, read from source rather than assumed:
//
//   * `POST /optimize/{id}/cancel` → **202** (`api/optimize.py:212`). A QUEUED job
//     goes straight to terminal CANCELLED; a RUNNING one enters **CANCELLING**,
//     which is NOT terminal (`jobs/controller.py:373-401`). Re-cancelling a
//     terminal or already-cancelling job returns it unchanged, so cancel is
//     idempotent.
//   * `DELETE /optimize/{id}` → **204** (`api/optimize.py:255`), and
//     `delete_job` raises `JobOperationNotAllowedError` unless the job is already
//     terminal (`jobs/controller.py:522-536`), which `app.py:250` maps to **409**.
//   * A missing job is **404**.
//
// So DELETE must never be fired while the job is still `cancelling` — the previous
// implementation did exactly that, ignored every status, and treated only a
// transport exception as failure, which is why it could "succeed" while leaving
// the solve alive. This lifecycle cancels, POLLS to terminal within an explicit
// bound, and only then deletes.

/** Bounds for the cleanup lifecycle. Independent of the test's own cap. */
export const CLEANUP_BOUNDS = {
  cancelRequest: 10_000,
  terminalPoll: 30_000,
  terminalPollInterval: 500,
  deleteRequest: 10_000,
  statusRequest: 10_000,
} as const;

/** The documented statuses each cleanup step may return. */
export const CLEANUP_ACCEPTED_STATUS = {
  /** 202 documented; 404 when a prior attempt already deleted the job. */
  cancel: [202, 404] as readonly number[],
  /** 204 documented; 404 is the idempotent already-deleted outcome. */
  delete: [204, 404] as readonly number[],
} as const;

export interface CleanupHttp {
  post(url: string, timeout: number): Promise<{ status: number; body: string }>;
  delete(url: string, timeout: number): Promise<{ status: number; body: string }>;
  get(url: string, timeout: number): Promise<{ status: number; body: string }>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface CleanupOutcome {
  /**
   * Ids the backend turned out not to have (the documented idempotent 404 branch).
   * Populated by `releaseLiveJobs`; consumed by `auditCoverageAfterRelease`.
   */
  absent?: string[];
  ok: boolean;
  /** Ordered, human-readable trace of every step and its status. */
  steps: string[];
  failures: string[];
}

/** Whether a job payload reports a terminal state. */
export function isTerminalJobBody(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as { terminal?: unknown; state?: unknown };
    if (parsed.terminal === true) return true;
    return (
      typeof parsed.state === "string" &&
      ["completed", "cancelled", "failed"].includes(parsed.state)
    );
  } catch {
    return false;
  }
}

/**
 * Cancel → poll to terminal → delete, asserting the documented status at every
 * step. Pure with respect to Playwright: `http` is injected, so the whole
 * lifecycle (including the 409-if-you-delete-too-early hazard) is unit-testable.
 */
export async function releaseLiveJob(jobId: string, http: CleanupHttp): Promise<CleanupOutcome> {
  const steps: string[] = [];
  const failures: string[] = [];
  const path = `/api/optimize/${encodeURIComponent(jobId)}`;

  // TRANSPORT SAFETY. Every injected call is wrapped, because a timeout or socket
  // rejection used to propagate out of this helper — which meant the hook never
  // reached the line that builds and attaches the diagnostic, and an already-failed
  // primary test could be replaced by an unstructured cleanup throw. A rejection is
  // now just another named failure in the outcome.
  type Attempt = { ok: true; status: number; body: string } | { ok: false; error: string };
  const attempt = async (
    label: string,
    call: () => Promise<{ status: number; body: string }>,
  ): Promise<Attempt> => {
    try {
      return { ok: true, ...(await call()) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      steps.push(`${label} -> transport error`);
      failures.push(`${label} request failed at the transport level: ${message}`);
      return { ok: false, error: message };
    }
  };

  const cancelAttempt = await attempt("cancel", () =>
    http.post(`${path}/cancel`, CLEANUP_BOUNDS.cancelRequest),
  );
  if (!cancelAttempt.ok) return { ok: false, steps, failures };
  const cancel = cancelAttempt;
  steps.push(`cancel -> ${cancel.status}`);
  if (!CLEANUP_ACCEPTED_STATUS.cancel.includes(cancel.status)) {
    failures.push(
      `cancel returned ${cancel.status}; documented outcomes are ${CLEANUP_ACCEPTED_STATUS.cancel.join(" or ")}`,
    );
    return { ok: false, steps, failures };
  }
  if (cancel.status === 404) {
    steps.push("job already absent; nothing to delete");
    return { ok: true, steps, failures };
  }

  // Poll to terminal. A RUNNING job first enters `cancelling`, and DELETE before
  // terminal is the documented 409 — so this wait is the whole point.
  const deadline = http.now() + CLEANUP_BOUNDS.terminalPoll;
  let terminal = false;
  let lastStatus = 0;
  let lastBody = "";
  while (http.now() <= deadline) {
    const stateAttempt = await attempt("status poll", () =>
      http.get(path, CLEANUP_BOUNDS.statusRequest),
    );
    if (!stateAttempt.ok) return { ok: false, steps, failures };
    const state = stateAttempt;
    lastStatus = state.status;
    lastBody = state.body;
    if (state.status === 404) {
      steps.push("job disappeared while polling; nothing to delete");
      return { ok: true, steps, failures };
    }
    if (state.status !== 200) {
      failures.push(`status poll returned ${state.status}; expected 200 or 404`);
      return { ok: false, steps, failures };
    }
    if (isTerminalJobBody(state.body)) {
      terminal = true;
      break;
    }
    await http.sleep(CLEANUP_BOUNDS.terminalPollInterval);
  }
  if (!terminal) {
    steps.push(
      `still nonterminal after ${CLEANUP_BOUNDS.terminalPoll}ms (last status ${lastStatus})`,
    );
    failures.push(
      `job did not reach a terminal state within ${CLEANUP_BOUNDS.terminalPoll}ms; last body ${lastBody.slice(0, 200)}`,
    );
    return { ok: false, steps, failures };
  }
  steps.push("reached terminal");

  const deleteAttempt = await attempt("delete", () =>
    http.delete(path, CLEANUP_BOUNDS.deleteRequest),
  );
  if (!deleteAttempt.ok) return { ok: false, steps, failures };
  const deleted = deleteAttempt;
  steps.push(`delete -> ${deleted.status}`);
  if (!CLEANUP_ACCEPTED_STATUS.delete.includes(deleted.status)) {
    failures.push(
      `delete returned ${deleted.status}; documented outcomes are ${CLEANUP_ACCEPTED_STATUS.delete.join(" or ")}`,
    );
    return { ok: false, steps, failures };
  }
  return { ok: true, steps, failures };
}

// ===========================================================================
// Node-side accepted-job ownership tracker
// ===========================================================================
//
// Ownership USED to be assigned from inside an `expect.poll` callback. That is the
// right seam on a successful callback, but Playwright races the callback against
// the poll deadline without cancelling or awaiting the loser, so a callback could
// observe and arm an accepted 202 AFTER the failed test had entered `afterEach` and
// after the hook had already copied an empty array. A read-only probe of the
// installed runtime showed exactly that: `hookSnapshot: []` at timeout, then
// `armed: ["job-timeout-race"]` 121ms later. The late assignment orphaned that job
// and leaked ownership into the next test.
//
// So ownership is no longer a test-body side effect at all. It is a Node-side
// tracker registered BEFORE submit, fed by the response event, with an explicit
// lifecycle: every body read it starts is recorded, and `drain()` awaits all of
// them. The hook drains before it snapshots, so no ownership mutation can outlive
// the snapshot. There is no second abandonable callback anywhere in the design.
//
// `AcceptedJobSource` is the tiny slice of `Page` this needs, so the lifecycle is
// unit-testable without a browser.
export interface AcceptedJobRequest {
  method(): string;
  url(): string;
}

export interface AcceptedJobResponse {
  status(): number;
  url(): string;
  request(): AcceptedJobRequest;
  json(): Promise<unknown>;
}

export interface AcceptedJobEvents {
  response: AcceptedJobResponse;
  request: AcceptedJobRequest;
  requestfailed: AcceptedJobRequest;
}

export interface AcceptedJobSource {
  on<K extends keyof AcceptedJobEvents>(
    event: K,
    handler: (arg: AcceptedJobEvents[K]) => void,
  ): void;
  off<K extends keyof AcceptedJobEvents>(
    event: K,
    handler: (arg: AcceptedJobEvents[K]) => void,
  ): void;
}

/**
 * How long `drain()` waits for a submission POST that is still IN FLIGHT to be
 * answered before giving up on it.
 *
 * This exists because draining only the body reads was not enough: a test that times
 * out while the POST is still on the wire would reach the hook with nothing recorded
 * at all, and the response event would fire after the snapshot. The hook therefore
 * waits for the request to land first, so the id is owned rather than missed.
 */
export const ACCEPTED_PENDING_SETTLE_MS = 5_000;

/**
 * The structured, AUTHORITATIVE result of a drain.
 *
 * `drain()` used to return `void`, and the hook then snapshotted `ids()` and
 * reported success regardless of whether anything was left unresolved. Two exact
 * probes showed what that cost:
 *
 *   late accepted after the drain bound:
 *     before  = { ids: [], stats: { started: 0, failed: 0, pending: 1 } }
 *     cleanup = { ok: true, steps: ["no accepted job was armed; nothing to release"] }
 *
 *   accepted response body rejection:
 *     state   = { ids: [], stats: { started: 1, failed: 1, pending: 0 } }
 *     cleanup = { ok: true, steps: ["no accepted job was armed; nothing to release"] }
 *
 * In both, a real solver job could exist while the hook reported success. So the
 * drain now says so: `resolved` is false whenever a submission is still pending or
 * an acceptance is otherwise unaccounted for, and the caller must either RECOVER the
 * identity from an authoritative product source or fail the gate.
 */

/**
 * What became of ONE accepted 202. The tracker's contract is that every accepted
 * submission ends as exactly one of these — there is no "nothing happened" outcome.
 */
export type AcceptedSlotOutcome =
  /** A valid, canonical, not-previously-seen job id. The only accounted outcome. */
  | { kind: "id"; jobId: string }
  /** The body READ fine but carried no usable id (missing / empty / non-string). */
  | { kind: "invalid-body"; detail: string }
  /** The body read rejected. */
  | { kind: "unreadable"; detail: string }
  /** The body read had not settled when the bounded drain expired. */
  | { kind: "unfinished" }
  /** A valid id we had ALREADY seen — so this acceptance is not separately accounted. */
  | { kind: "duplicate"; jobId: string };

export interface AcceptedDrainOutcome {
  /** Unique valid ids, in acceptance order. */
  ids: string[];
  /** Every accepted 202 observed, in acceptance order, with its outcome. */
  slots: AcceptedSlotOutcome[];
  /** How many accepted 202s were seen at all. */
  acceptedCount: number;
  /**
   * Accepted 202s that did NOT yield a unique valid id — invalid body, unreadable
   * body, unfinished read, or a duplicate of an id already owned.
   *
   * The invalid-body case is why this replaced a plain `failed` counter: a 202 whose
   * body read SUCCEEDED but carried `{}` or `{id:""}` left a null slot and incremented
   * nothing, so the drain reported `resolved: true` with no id and the hook released an
   * empty set and went green over a job that may well have been running.
   */
  unaccountedSlots: number;
  /** Submissions still on the wire when the bounded settle expired. */
  pending: number;
  /** True only when every acceptance is accounted for and nothing is still pending. */
  resolved: boolean;
}

export interface AcceptedJobTracker {
  /** Every accepted job id, in acceptance order, deduplicated. */
  ids(): string[];
  /**
   * Await in-flight submissions and body reads, then report authoritatively.
   * The hook calls this BEFORE snapshotting and BEFORE disposing.
   */
  drain(): Promise<AcceptedDrainOutcome>;
  /**
   * Stop listening, and REPORT what detaching the listeners just orphaned.
   *
   * Disposal is the moment ownership can be lost silently: any submission still on
   * the wire, or any body read still in flight, will now complete with nobody
   * watching. So disposal is not allowed to be a `void` side effect — it returns
   * the count it stranded, and the caller must treat a nonzero count as unresolved
   * ownership rather than as a clean finish. Safe to call more than once; repeat
   * calls report zero because the first call already detached.
   */
  dispose(): AcceptedDisposal;
  /** Diagnostics for a report: acceptances seen, acceptances unaccounted, pending. */
  stats(): { started: number; unaccounted: number; pending: number };
}

/** What detaching the listeners stranded. `orphaned` must be zero for a clean finish. */
export interface AcceptedDisposal {
  /** Submissions on the wire plus body reads in flight when listeners detached. */
  orphaned: number;
}

/** Whether a request is a submission POST to `/api/optimize`. */
export function isSubmissionRequest(request: AcceptedJobRequest): boolean {
  if (request.method().toUpperCase() !== "POST") return false;
  const path = String(request.url()).split("?")[0];
  return path === "/api/optimize" || path.endsWith("/api/optimize");
}

/** Whether a response is an accepted (202) submission POST to `/api/optimize`. */
export function isAcceptedSubmission(response: AcceptedJobResponse): boolean {
  if (response.status() !== 202) return false;
  if (response.request().method().toUpperCase() !== "POST") return false;
  const path = String(response.url()).split("?")[0];
  return path === "/api/optimize" || path.endsWith("/api/optimize");
}

/**
 * Track every accepted submission on the Node side. Register before submit; the
 * hook drains and disposes.
 */
export function trackAcceptedJobs(
  source: AcceptedJobSource,
  options: { pendingSettleMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): AcceptedJobTracker {
  const pendingSettleMs = options.pendingSettleMs ?? ACCEPTED_PENDING_SETTLE_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // Slot-indexed by ACCEPTANCE order, not by body-read completion order. A nested or
  // faster read must not reorder ownership, because release order is part of the
  // determinism this promises.
  const slots: Array<AcceptedSlotOutcome | undefined> = [];
  // A SET, not an array, and each read removes itself on settle — so after a bounded
  // drain the remaining size is exactly the number of reads that never landed.
  const inflight = new Set<Promise<void>>();
  let started = 0;
  let pending = 0;
  let disposed = false;

  const onRequest = (request: AcceptedJobRequest): void => {
    if (disposed) return;
    if (isSubmissionRequest(request)) pending += 1;
  };
  const onRequestFailed = (request: AcceptedJobRequest): void => {
    if (isSubmissionRequest(request) && pending > 0) pending -= 1;
  };

  const handler = (response: AcceptedJobResponse): void => {
    if (disposed) return;
    if (isSubmissionRequest(response.request()) && pending > 0) pending -= 1;
    if (!isAcceptedSubmission(response)) return;
    started += 1;
    const slot = slots.length;
    // `undefined` means "this read has not settled yet"; the drain converts any slot
    // still undefined at its bound into an explicit `unfinished` outcome.
    slots.push(undefined);
    const read: Promise<void> = response
      .json()
      .then((body) => {
        const id = (body as { id?: unknown } | null)?.id;
        if (typeof id !== "string") {
          // FAIL CLOSED on a readable body with no usable id. This used to leave the
          // slot null and increment nothing, so the drain called it resolved and the
          // hook released an empty set — green over a possibly-live job.
          slots[slot] = {
            kind: "invalid-body",
            detail: `accepted body id was ${id === undefined ? "absent" : typeof id}`,
          };
          return;
        }
        if (id.length === 0) {
          slots[slot] = { kind: "invalid-body", detail: "accepted body id was empty" };
          return;
        }
        slots[slot] = { kind: "id", jobId: id };
      })
      .catch((error: unknown) => {
        // A body that cannot be read is recorded, not thrown: the hook must still be
        // able to drain and report.
        slots[slot] = {
          kind: "unreadable",
          detail: error instanceof Error ? error.message : String(error),
        };
      })
      .finally(() => {
        inflight.delete(read);
      });
    inflight.add(read);
  };

  source.on("request", onRequest);
  source.on("requestfailed", onRequestFailed);
  source.on("response", handler);

  return {
    ids: () => {
      const seen: string[] = [];
      for (const slot of slots) {
        if (slot?.kind === "id" && !seen.includes(slot.jobId)) seen.push(slot.jobId);
      }
      return seen;
    },
    drain: async (): Promise<AcceptedDrainOutcome> => {
      // 1. Wait, bounded, for a submission POST that is still on the wire. Without
      //    this a test that times out mid-POST reaches the hook with nothing
      //    recorded and the response fires after the snapshot.
      const deadline = Date.now() + pendingSettleMs;
      while (pending > 0 && Date.now() < deadline) {
        await sleep(25);
      }
      // 2. Then drain the body reads, repeatedly — awaiting one batch can allow
      //    another response's read to be registered, and the hook must not snapshot
      //    until the set is quiet. BOUNDED, because awaiting these unconditionally
      //    would hang the fail-closed hook itself on a read that never settles, which
      //    is the defect class this whole path exists to close. Its OWN window, not
      //    the remainder of phase 1's: a slow POST must not starve a healthy body read
      //    into being counted as unobtainable.
      const readDeadline = Date.now() + pendingSettleMs;
      for (let pass = 0; pass < 5; pass += 1) {
        if (inflight.size === 0) break;
        const remaining = readDeadline - Date.now();
        if (remaining <= 0) break;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            // The Set is iterated SYNCHRONOUSLY here, and entries remove themselves
            // only in a later microtask, so passing it directly cannot miss one.
            Promise.allSettled(inflight),
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, remaining);
            }),
          ]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      }
      // Resolve every slot to an explicit outcome. A read that never settled becomes
      // `unfinished` rather than silently vanishing, and a repeat of an id we already
      // own becomes `duplicate` — because "exactly one unique valid id per acceptance"
      // is the invariant, so a second slot reporting the same id leaves that ACCEPTANCE
      // unaccounted for even though the id itself is known.
      const resolvedSlots: AcceptedSlotOutcome[] = [];
      const observed: string[] = [];
      for (const slot of slots) {
        const outcome: AcceptedSlotOutcome = slot ?? { kind: "unfinished" };
        if (outcome.kind === "id") {
          if (observed.includes(outcome.jobId)) {
            resolvedSlots.push({ kind: "duplicate", jobId: outcome.jobId });
            continue;
          }
          observed.push(outcome.jobId);
        }
        resolvedSlots.push(outcome);
      }
      const unaccountedSlots = resolvedSlots.filter((slot) => slot.kind !== "id").length;
      // FAIL CLOSED. A pending submission may have created a job we cannot name, and an
      // unaccounted acceptance definitely names one we failed to capture.
      return {
        ids: observed,
        slots: resolvedSlots,
        acceptedCount: resolvedSlots.length,
        unaccountedSlots,
        pending,
        resolved: pending === 0 && unaccountedSlots === 0,
      };
    },
    dispose: (): AcceptedDisposal => {
      if (disposed) return { orphaned: 0 };
      disposed = true;
      source.off("request", onRequest);
      source.off("requestfailed", onRequestFailed);
      source.off("response", handler);
      // Anything unfinished at this instant will now land unobserved.
      return { orphaned: pending + inflight.size };
    },
    stats: () => {
      let unaccounted = 0;
      const seen: string[] = [];
      for (const slot of slots) {
        if (slot?.kind === "id" && !seen.includes(slot.jobId)) {
          seen.push(slot.jobId);
          continue;
        }
        unaccounted += 1;
      }
      return { started, unaccounted, pending };
    },
  };
}

/**
 * Release EVERY accepted job, deterministically and in the order they were
 * accepted. A test may observe more than one accepted submission (a resubmit path,
 * or a retry the product performs); arming only the first and then throwing would
 * leave the rest orphaned, which is the contamination class this exists to close.
 * Every job is attempted even if an earlier one fails, so one bad release cannot
 * hide the others.
 */
export async function releaseLiveJobs(
  jobIds: readonly string[],
  http: CleanupHttp,
): Promise<CleanupOutcome> {
  if (jobIds.length === 0) {
    return {
      ok: true,
      steps: ["no accepted job was armed; nothing to release"],
      failures: [],
      absent: [],
    };
  }
  const steps: string[] = [];
  const failures: string[] = [];
  const absent: string[] = [];
  for (const jobId of jobIds) {
    const outcome = await releaseLiveJob(jobId, http);
    steps.push(`job ${jobId}: ${outcome.steps.join(" | ")}`);
    for (const failure of outcome.failures) failures.push(`job ${jobId}: ${failure}`);
    // A job the backend never had cannot be evidence that anything was cleaned up.
    if (outcome.steps.some((step) => step.includes("already absent") || step.includes("404"))) {
      absent.push(jobId);
    }
  }
  return { ok: failures.length === 0, steps, failures, absent };
}

/**
 * Confirm, AFTER release, that every id counted as coverage actually existed.
 *
 * Closes the release-404 laundering path: a stale or invented id satisfies the
 * cardinality check (it is new and distinct) and then releases "successfully" via the
 * documented idempotent 404 branch — so an unaccounted acceptance would look covered by
 * a job that was never there. Coverage only counts if the backend actually had it.
 *
 * Tracker-observed ids are deliberately exempt: on the success path the product's own
 * terminal auto-chain DELETEs the job, so the hook legitimately finds it already gone.
 * Only ids standing in for something we could not name have to prove they existed.
 */
export function auditCoverageAfterRelease(
  settlement: OwnershipSettlement,
  released: CleanupOutcome,
): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  for (const jobId of settlement.coverage) {
    if ((released.absent ?? []).includes(jobId)) {
      failures.push(
        `recovered job ${jobId} was counted as coverage but the backend never had it; ` +
          `the acceptance it was meant to account for is still unnamed`,
      );
    }
  }
  return { ok: failures.length === 0, failures };
}

// ===========================================================================
// Ownership recovery + the fail-closed settlement decision
// ===========================================================================
//
// When the Node-side tracker cannot name a job (submission still pending at the
// settle bound, or an accepted 202 whose body would not read), the id is not gone —
// it is written elsewhere. The product's submission transaction persists the
// ACTIVE session record, job id included, as part of accepting the 202
// (`lib/optimize/session-transaction.ts`, key `nurse.optimize.session`). That record
// is an INDEPENDENT authority: it is produced by the page, not by the CDP response
// stream, so it survives exactly the failures that defeat the tracker.
//
// So the hook's order is: drain → if unresolved, recover from the page record →
// settle → dispose → release every id. And if settlement still cannot account for
// the ownership, the hook FAILS — it does not report cleanup success.

/** sessionStorage key of the product's single in-flight submission record. */
export const OPTIMIZE_SESSION_RECORD_KEY = "nurse.optimize.session";

/** The product's session schema version (`OPTIMIZE_SESSION_SCHEMA_VERSION`). */
export const OPTIMIZE_SESSION_SCHEMA_VERSION = 1;

/** Bound for the page-side recovery read. One `evaluate`, so it is small. */
export const OWNERSHIP_RECOVERY_BOUND = 5_000;

/**
 * Extract the job id from a raw session record, treating anything unexpected as a
 * REASON rather than as an absence.
 *
 * Only the active variant carries a job id; a provisional record (written before the
 * POST) legitimately has none, which is reported as `jobId: null` rather than as a
 * failure — a provisional record means the accepted id never existed to recover.
 */
export function recoverJobIdFromSessionRecord(
  raw: string | null,
): { ok: true; jobId: string | null } | { ok: false; reason: string } {
  if (raw === null) return { ok: true, jobId: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "session record is not JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "session record is not an object" };
  }
  const record = parsed as Record<string, unknown>;

  // SCHEMA, not shape. This used to accept ANY object with a nonempty `jobId`, so a
  // corrupt, stale, foreign-schema or future-schema record — and a provisional record
  // that happened to carry a jobId — all passed as authority for a live job. The
  // product's own validator (`lib/optimize/session-transaction.ts`) requires the exact
  // schema version, an exact key set per variant, and `phase` as the discriminator;
  // only the ACTIVE variant carries a job id at all.
  if (record.schemaVersion !== OPTIMIZE_SESSION_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: `session record schemaVersion ${String(record.schemaVersion)} is not ${OPTIMIZE_SESSION_SCHEMA_VERSION}`,
    };
  }
  if (typeof record.ownerId !== "string" || record.ownerId.length === 0) {
    return { ok: false, reason: "session record has no owner id" };
  }

  if (record.phase === "provisional") {
    // A provisional record means the POST had not been accepted when it was written, so
    // it is NOT authority for a live job — not even carrying a jobId, which the
    // product's exact-key check would itself reject. In the real
    // `activation-persistence-failed` path the durable record STAYS provisional while a
    // real job runs, and the id lives only in volatile state; the volatile authority in
    // `recoverAcceptedOwnership` is what covers that, never a guess from this record.
    if ("jobId" in record) {
      return { ok: false, reason: "provisional session record carries a jobId; not valid" };
    }
    return { ok: true, jobId: null };
  }
  if (record.phase !== "active") {
    return { ok: false, reason: `session record phase ${String(record.phase)} is not active` };
  }

  const jobId = record.jobId;
  if (typeof jobId !== "string" || jobId.length === 0) {
    return { ok: false, reason: "active session record has no valid jobId" };
  }
  return { ok: true, jobId };
}

// ---------------------------------------------------------------------------
// The volatile (DOM) authority's selector contract
// ---------------------------------------------------------------------------
//
// The volatile read used to scan every `<p>` for the PROSE `Job ID: <id>`. That
// coupled a fail-closed ownership gate to user-visible copy: a wording change, a
// translation, or a wrapper element would make recovery silently find nothing, and
// the acceptance it was meant to cover would be reported unnamed. Worse, the regex
// was `^Job ID:\s*(\S+)$` over `textContent`, so it could equally match any other
// paragraph that happened to start that way.
//
// So the product now renders a stable, narrow hook on the job-id VALUE
// (`components/optimize/run-status-panel.tsx`), and everything below judges what
// that hook yields. The pair is pinned by a DOM test in
// `components/optimize/run-status-panel.test.tsx`, which imports the constant from
// here — so the selector and the markup cannot drift apart silently.

/** The `data-testid` on the rendered live job-id VALUE. */
export const VOLATILE_JOB_ID_TESTID = "optimize-job-id";

/** The exact query the page-side read runs. */
export const VOLATILE_JOB_ID_SELECTOR = `[data-testid="${VOLATILE_JOB_ID_TESTID}"]`;

/** Job-id texts the page yielded, or a REASON the page's answer is unusable. */
export type VolatileJobIdsVerdict = { ok: true; ids: string[] } | { ok: false; reason: string };

/**
 * Judge the raw texts the volatile selector matched.
 *
 * Total and fail-closed, because this is an ownership authority: an answer this
 * cannot vouch for becomes a REASON, which `recoverAcceptedOwnership` turns into a
 * failed recovery and `settleAcceptedOwnership` turns into a red gate. The one
 * benign outcome is ABSENCE — no node at all means the page holds no live job id,
 * which is reported as an empty set and then fails closed at the CARDINALITY check
 * if an acceptance actually needed covering. Nothing here may invent an id.
 *
 * Rejected, each for its own reason:
 *
 *   * MULTIPLE nodes — the panel renders at most one in-flight submission, so two
 *     hooks mean a stale panel or a duplicated mount and neither can be shown to
 *     name the live job. Picking one would be a guess.
 *   * a node with NO text, or text that is empty/whitespace once trimmed.
 *   * text containing INNER whitespace — which is exactly what a hook moved from the
 *     value onto the whole line would produce (`Job ID: opt_1`), so a regression of
 *     that shape is named rather than silently parsed back out.
 *
 * STALENESS is deliberately NOT judged here: a DOM string carries no evidence of
 * whether the backend still has that job. It is caught downstream instead — a
 * recovered id counted as coverage that the backend never had 404s on release and
 * `auditCoverageAfterRelease` fails the gate.
 */
export function judgeVolatileJobIdTexts(
  texts: readonly (string | null | undefined)[],
): VolatileJobIdsVerdict {
  if (!Array.isArray(texts)) {
    return { ok: false, reason: "page did not report a list of volatile job-id nodes" };
  }
  if (texts.length === 0) return { ok: true, ids: [] };
  if (texts.length > 1) {
    return {
      ok: false,
      reason:
        `page rendered ${texts.length} "${VOLATILE_JOB_ID_TESTID}" nodes ` +
        `(${texts.map((text) => JSON.stringify(text)).join(", ")}); ` +
        `the live job authority is ambiguous`,
    };
  }
  const raw = texts[0];
  if (typeof raw !== "string") {
    return {
      ok: false,
      reason: `"${VOLATILE_JOB_ID_TESTID}" node carried no text (${String(raw)})`,
    };
  }
  const jobId = raw.trim();
  if (jobId.length === 0) {
    return { ok: false, reason: `"${VOLATILE_JOB_ID_TESTID}" node text was empty` };
  }
  if (/\s/.test(jobId)) {
    return {
      ok: false,
      reason:
        `"${VOLATILE_JOB_ID_TESTID}" node text ${JSON.stringify(raw)} is not a bare job id; ` +
        `the hook must sit on the id VALUE, not on the whole line`,
    };
  }
  return { ok: true, ids: [jobId] };
}

/** The page-side seams, so settlement is testable without a browser. */
export interface OwnershipRecoverySource {
  /** Read the raw durable session record from the page. Rejects if the page is gone. */
  readSessionRecord(): Promise<string | null>;
  /**
   * Read every job id the page currently holds in VOLATILE state.
   *
   * Required because the durable record is not always sufficient. `activateSession`
   * can return `activation-persistence-failed`: the 202 WAS accepted, a real job IS
   * running, and the durable record deliberately stays PROVISIONAL — the accepted id
   * exists only in volatile controller state. Recovering from the durable record alone
   * would report "no job id" over a live solver, which is the exact fail-open shape
   * this whole path exists to prevent.
   */
  readVolatileJobIds(): Promise<string[]>;
}

/** The outcome of a recovery attempt — total, like every other judge here. */
export type OwnershipRecovery =
  | { ok: true; ids: string[]; note: string }
  | { ok: false; reason: string };

/** Attempt page-side recovery. A rejection is a reason, never a throw. */
export async function recoverAcceptedOwnership(
  source: OwnershipRecoverySource,
): Promise<OwnershipRecovery> {
  let raw: string | null;
  try {
    raw = await source.readSessionRecord();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `page-side session record was unreadable: ${message}` };
  }
  const parsed = recoverJobIdFromSessionRecord(raw);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };

  const notes: string[] = [];
  const ids: string[] = [];
  if (parsed.jobId === null) {
    notes.push("durable record holds no active job id");
  } else {
    ids.push(parsed.jobId);
    notes.push(`durable active record names job ${parsed.jobId}`);
  }

  // AUTHORITY 2 — volatile controller state, the ONLY place an accepted id lives when
  // activation persistence failed after a real 202.
  let volatileIds: string[];
  try {
    volatileIds = await source.readVolatileJobIds();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `page-side volatile job ids were unreadable: ${message}` };
  }
  for (const id of volatileIds) {
    if (typeof id !== "string" || id.length === 0) {
      return { ok: false, reason: "page reported an invalid volatile job id" };
    }
    if (!ids.includes(id)) ids.push(id);
  }
  notes.push(
    volatileIds.length === 0
      ? "page holds no volatile accepted job id"
      : `volatile state names ${volatileIds.length} job id(s): ${volatileIds.join(", ")}`,
  );

  return { ok: true, ids, note: notes.join("; ") };
}

/** The settled ownership set plus whether it may be trusted as complete. */
export interface OwnershipSettlement {
  /** Every id to release, tracker-observed first, then recovered, deduplicated. */
  ids: string[];
  /**
   * The RECOVERED ids being counted as coverage for unaccounted acceptances. These
   * must still be confirmed to have existed — see `auditCoverageAfterRelease`. A stale
   * id that 404s covers nothing, and counting it would launder the missing job.
   */
  coverage: string[];
  /** True only when nothing is left unaccounted for. */
  ok: boolean;
  /** Human-readable trail for the attachment. */
  notes: string[];
  /** Why ownership is not settled. Empty exactly when `ok`. */
  failures: string[];
}

/**
 * Decide, purely, whether accepted-job ownership is fully accounted for.
 *
 * This is the whole fail-closed rule in one testable function:
 *
 *   drain resolved                  -> settled, release the drained ids
 *   drain unresolved, recovery adds  -> settled, release drained + recovered
 *   drain unresolved, recovery empty -> NOT settled; a job may exist unnamed
 *   drain unresolved, recovery error  -> NOT settled
 *   disposal orphaned anything        -> NOT settled, regardless of the above
 *
 * The one deliberate asymmetry: a submission whose transport FAILED already
 * decrements `pending` in the tracker, so a genuinely aborted POST does not reach
 * here as unresolved. Only a submission that is still open at the bound does.
 */
export function settleAcceptedOwnership(
  drained: AcceptedDrainOutcome,
  recovery: OwnershipRecovery | null,
  disposal: AcceptedDisposal,
): OwnershipSettlement {
  const ids = [...drained.ids];
  const notes: string[] = [];
  const failures: string[] = [];

  notes.push(
    `drain: ${drained.acceptedCount} acceptance(s), ${drained.ids.length} known id(s), ` +
      `${drained.unaccountedSlots} unaccounted, ${drained.pending} pending, ` +
      `${disposal.orphaned} stranded by disposal`,
  );

  // CARDINALITY, not mere non-emptiness. Checking only "recovery returned something"
  // let ONE id — possibly a duplicate of one already owned, or a stale id — stand in for
  // ANY number of missing jobs. Coverage must be one-to-one: every unaccounted
  // acceptance needs its own distinct, NEW identity from an authoritative source.
  const unresolvedCount = drained.unaccountedSlots + drained.pending + disposal.orphaned;
  const coverage: string[] = [];
  if (unresolvedCount > 0) {
    const unresolved: string[] = [];
    if (drained.unaccountedSlots > 0) {
      unresolved.push(`${drained.unaccountedSlots} acceptance(s) unaccounted for`);
    }
    if (drained.pending > 0) unresolved.push(`${drained.pending} submission(s) still pending`);
    if (disposal.orphaned > 0) unresolved.push(`${disposal.orphaned} stranded by disposal`);
    const summary = unresolved.join(" and ");
    if (recovery === null) {
      failures.push(`accepted ownership unresolved (${summary}) and no recovery was attempted`);
    } else if (!recovery.ok) {
      failures.push(
        `accepted ownership unresolved (${summary}); recovery failed: ${recovery.reason}`,
      );
    } else {
      notes.push(`recovery: ${recovery.note}`);
      // NEW and DISTINCT. An id we already own launders nothing, and a repeated id
      // cannot cover two different missing jobs.
      const recovered: string[] = [];
      for (const id of recovery.ids) {
        if (ids.includes(id) || recovered.includes(id)) continue;
        recovered.push(id);
      }
      ids.push(...recovered);
      coverage.push(...recovered);
      notes.push(
        `coverage: ${recovered.length} new distinct id(s) for ${unresolvedCount} unresolved acceptance(s)`,
      );
      if (recovered.length < unresolvedCount) {
        failures.push(
          `accepted ownership unresolved (${summary}): authority produced ${recovered.length} new distinct job id(s) for ${unresolvedCount} unresolved acceptance(s); a solver job may exist unnamed`,
        );
      }
    }
  }

  return { ids, coverage, ok: failures.length === 0, notes, failures };
}

/** Wire version prefix of the public event cursor (`CURSOR_VERSION`). */
export const CURSOR_VERSION = "v1";

/** Unpadded base64url: URL-safe alphabet only, no `=` padding, non-empty. */
const CURSOR_SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/;

/** One decoded public cursor. */
export interface DecodedCursor {
  jobId: string;
  nativeEventId: string;
}

/**
 * Decode one canonical segment, or return `null` when it is not a canonical
 * unpadded base64url UTF-8 spelling. Mirrors `event_cursor.py::_decode_segment`,
 * including the byte-for-byte re-encode that rejects non-canonical aliases.
 */
function decodeCursorSegment(segment: string): string | null {
  if (!CURSOR_SEGMENT_PATTERN.test(segment)) return null;
  const decoded = Buffer.from(segment, "base64url").toString("utf8");
  // `Buffer` is lenient about both base64 aliases and invalid UTF-8 (it
  // substitutes U+FFFD rather than throwing), so the round trip carries the
  // whole rejection: a non-canonical spelling or a bad byte sequence re-encodes
  // to something other than `segment`.
  if (Buffer.from(decoded, "utf8").toString("base64url") !== segment) return null;
  return decoded;
}

/**
 * Decode a public cursor, or return `null` when it is malformed. Shape and
 * version are checked exactly as `event_cursor.py::decode_cursor` does; the job
 * binding itself is compared by the caller.
 */
export function decodePublicCursor(token: string): DecodedCursor | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== CURSOR_VERSION) return null;
  const jobId = decodeCursorSegment(parts[1]);
  const nativeEventId = decodeCursorSegment(parts[2]);
  if (jobId === null || nativeEventId === null) return null;
  return { jobId, nativeEventId };
}

export interface ReplayEvidence {
  /**
   * THE SOLE JOB AUTHORITY, and it must not come from a cursor.
   *
   * Deriving the expected job by decoding `cursorBefore` was circular: a foreign
   * cursor named its own expected job, and foreign raw ids plus a foreign
   * `cursorAfter` then agreed with it, so a fully self-consistent foreign envelope
   * passed. The caller supplies the job the PRE-RELOAD session was actually
   * running, captured independently of any cursor in the same causal snapshot, and
   * `cursorBefore` is now something this judge CHECKS rather than something it
   * trusts.
   */
  expectedJobId: string | null;
  /** Raw `id:` values recorded from the post-reload SSE body, in wire order. */
  rawIds: readonly string[];
  /** The durably persisted cursor read in the SAME atomic snapshot as `rawIds`. */
  cursorAfter: string | null;
  /** The exact cursor captured before reload and replayed as `Last-Event-ID`. */
  cursorBefore: string | null;
  /** Every raw id observed BEFORE the reload. */
  preReloadIds: readonly string[];
}

export interface ReplayJudgement {
  ok: boolean;
  /** Every violated rule, named. Empty exactly when `ok`. */
  failures: string[];
}

/**
 * Judge one atomic post-reload snapshot against the strictly-after replay
 * contract.
 *
 * Retained: non-empty evidence, no pre-reload id re-sent, raw-id UNIQUENESS, and
 * the durable cursor both new and present among the recorded frames.
 *
 * The job authority is now `evidence.expectedJobId` — supplied by the caller from
 * the pre-reload session, never decoded out of a cursor. Everything cursor-shaped
 * is bound TO it: `cursorBefore`, every raw id, and `cursorAfter`. Because the
 * spec separately asserts that the first post-reload `Last-Event-ID` equals
 * `cursorBefore`, binding `cursorBefore` here transitively binds the resumed
 * request too.
 *
 * On the `cursorAfter` job-binding rule: it is a DIAGNOSTIC REFINEMENT, not an
 * independently protected gate, and this file does not claim otherwise. Because
 * `cursorAfter` must also appear among `rawIds` and every raw id is bound, an `ok`
 * result already entails the cursor is bound — so removing this rule cannot flip
 * any judgement from red to green. It is kept because it names the CURSOR in the
 * failure list instead of leaving a reader to infer which id was foreign, and the
 * unit suite asserts that exact cursor-specific message alongside the per-id one.
 */
export function judgeReplayEvidence(evidence: ReplayEvidence): ReplayJudgement {
  const failures: string[] = [];
  const { expectedJobId, rawIds, cursorAfter, cursorBefore, preReloadIds } = evidence;

  // Fail closed: with no independent authority there is nothing to bind against,
  // and falling back to a cursor is exactly the circularity this replaced.
  if (expectedJobId === null || expectedJobId.length === 0) {
    return { ok: false, failures: ["no independent pre-reload job authority was captured"] };
  }
  const expectedJob = expectedJobId;

  if (cursorBefore === null || cursorBefore.length === 0) {
    failures.push("no pre-reload cursor was captured");
  } else {
    const before = decodePublicCursor(cursorBefore);
    if (before === null) {
      failures.push(`pre-reload cursor is not a canonical public cursor: ${cursorBefore}`);
    } else if (before.jobId !== expectedJob) {
      failures.push(
        `pre-reload cursor is bound to job "${before.jobId}", not the active "${expectedJob}"`,
      );
    }
  }

  if (rawIds.length === 0) failures.push("no post-reload frame ids were recorded");

  const preReloadSet = new Set(preReloadIds);
  const stale = rawIds.filter((id) => preReloadSet.has(id));
  if (stale.length > 0) {
    failures.push(`replay re-sent ${stale.length} already-seen id(s): ${stale.join(", ")}`);
  }

  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of rawIds) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  if (duplicates.size > 0) {
    failures.push(`post-reload frame ids are not unique: ${[...duplicates].join(", ")}`);
  }

  for (const id of rawIds) {
    const decoded = decodePublicCursor(id);
    if (decoded === null) {
      failures.push(`recorded id is not a canonical public cursor: ${id}`);
      continue;
    }
    if (decoded.jobId !== expectedJob) {
      failures.push(
        `recorded id is bound to job "${decoded.jobId}", not the active "${expectedJob}": ${id}`,
      );
    }
  }

  if (cursorAfter === null) {
    failures.push("no durable cursor was persisted after reload");
  } else {
    if (preReloadSet.has(cursorAfter)) {
      failures.push(`durable cursor is an already-seen id: ${cursorAfter}`);
    }
    const after = decodePublicCursor(cursorAfter);
    if (after === null) {
      failures.push(`durable cursor is not a canonical public cursor: ${cursorAfter}`);
    } else if (after.jobId !== expectedJob) {
      failures.push(
        `durable cursor is bound to job "${after.jobId}", not the active "${expectedJob}"`,
      );
    }
    if (!rawIds.includes(cursorAfter)) {
      failures.push(`durable cursor ${cursorAfter} is absent from the recorded frames`);
    }
  }

  return { ok: failures.length === 0, failures };
}

export const DURABLE_FIXTURE_URL = "/optimize-durable-fixture";
export const JOB_ID = "opt_e2e_1";

const CREATED_AT = "2026-07-20T00:00:00+00:00";
const STARTED_AT = "2026-07-20T00:00:01+00:00";
const FINISHED_AT = "2026-07-20T00:01:00+00:00";

function links(id: string, schedule: string | null): JobResponse["links"] {
  const base = `/optimize/${id}`;
  return {
    self: base,
    events: `${base}/events`,
    cancellation: `${base}/cancel`,
    early_completion: `${base}/finish-now`,
    schedule,
  };
}

const REQUEST: JobResponse["request"] = {
  input_name: "s.yaml",
  solver: "ortools/cp-sat",
  prettify: null,
  timeout_seconds: 300,
};

/** A contract-valid queued JobResponse. */
export function queuedJob(id = JOB_ID, queuePosition = 1): JobResponse {
  return {
    id,
    state: "queued",
    terminal: false,
    queue_position: queuePosition,
    created_at: CREATED_AT,
    started_at: null,
    finished_at: null,
    request: REQUEST,
    result: null,
    error: null,
    controls: { cancellable: true, early_completion_available: false },
    links: links(id, null),
  };
}

/** A contract-valid running JobResponse (server controls both available). */
export function runningJob(id = JOB_ID): JobResponse {
  return {
    id,
    state: "running",
    terminal: false,
    queue_position: null,
    created_at: CREATED_AT,
    started_at: STARTED_AT,
    finished_at: null,
    request: REQUEST,
    result: null,
    error: null,
    controls: { cancellable: true, early_completion_available: true },
    links: links(id, null),
  };
}

/** A contract-valid cancelling JobResponse (no controls). */
export function cancellingJob(id = JOB_ID): JobResponse {
  return {
    ...runningJob(id),
    state: "cancelling",
    controls: { cancellable: false, early_completion_available: false },
  };
}

interface CompletedOptions {
  outcome?: OptimizationOutcome;
  score?: number | null;
}

/** A contract-valid completed JobResponse. Optimal/feasible expose a schedule
 *  link; infeasible carries no artifact. */
export function completedJob(id = JOB_ID, options: CompletedOptions = {}): JobResponse {
  const outcome = options.outcome ?? "optimal";
  const infeasible = outcome === "infeasible";
  const result: NonNullable<JobResponse["result"]> = infeasible
    ? {
        outcome: "infeasible",
        score: null,
        solver_status: "INFEASIBLE",
        termination_reason: "infeasibility_proven",
      }
    : {
        outcome,
        score: options.score ?? (outcome === "optimal" ? 7 : 42),
        solver_status: outcome === "optimal" ? "OPTIMAL" : "FEASIBLE",
        termination_reason: outcome === "optimal" ? "optimality_proven" : "solver_timeout",
      };
  return {
    id,
    state: "completed",
    terminal: true,
    queue_position: null,
    created_at: CREATED_AT,
    started_at: STARTED_AT,
    finished_at: FINISHED_AT,
    request: REQUEST,
    result,
    error: null,
    controls: { cancellable: false, early_completion_available: false },
    links: links(id, infeasible ? null : `/optimize/${id}/xlsx`),
  };
}

/** A contract-valid cancelled JobResponse. */
export function cancelledJob(id = JOB_ID): JobResponse {
  return {
    id,
    state: "cancelled",
    terminal: true,
    queue_position: null,
    created_at: CREATED_AT,
    started_at: STARTED_AT,
    finished_at: FINISHED_AT,
    request: REQUEST,
    result: null,
    error: { code: "cancelled", message: "Optimization cancelled." },
    controls: { cancellable: false, early_completion_available: false },
    links: links(id, null),
  };
}

/** A contract-valid failed JobResponse. `worker_lost` is server-resubmittable. */
export function failedJob(
  id = JOB_ID,
  code = "worker_lost",
  message = "The optimization worker stopped before the job completed.",
): JobResponse {
  return {
    id,
    state: "failed",
    terminal: true,
    queue_position: null,
    created_at: CREATED_AT,
    started_at: STARTED_AT,
    finished_at: FINISHED_AT,
    request: REQUEST,
    result: null,
    error: { code, message },
    controls: { cancellable: false, early_completion_available: false },
    links: links(id, null),
  };
}

// --- SSE frames (flat wire payloads, contract-valid) -----------------------

export interface SseFrameInput {
  id: string;
  event: string;
  data: Record<string, unknown>;
}

/** Serialize frames into one `text/event-stream` body (LF blank-line framing,
 *  matching the backend producer). */
export function sseBody(frames: SseFrameInput[]): string {
  return (
    frames
      .map((f) => `id: ${f.id}\nevent: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`)
      .join("") + ": keep-alive\n\n"
  );
}

export function runningFrame(id = "c1"): SseFrameInput {
  return {
    id,
    event: "job.state_changed",
    data: {
      occurred_at: STARTED_AT,
      state: "running",
      queue_position: null,
      cancel_requested: false,
      early_completion_requested: false,
      terminal: false,
      worker_id: "worker-1",
      controls: { cancellable: true, early_completion_available: true },
    },
  };
}

export function progressedFrame(id: string, score: number, elapsedSeconds: number): SseFrameInput {
  return {
    id,
    event: "job.progressed",
    data: {
      currentBestScore: score,
      elapsedSeconds,
      solutionIndex: 1,
      commentCount: 0,
      source: "solver",
    },
  };
}

/** A `job.phase_changed` frame (ephemeral solver phase report). Shapes match
 *  `frameToSignal`: valid `occurred_at`, non-empty source/code/message, and a
 *  finite elapsedSeconds. */
export function phaseChangedFrame(
  id: string,
  source = "solver",
  code = "solve",
  message = "Optimizing schedule",
  elapsedSeconds = 0.5,
): SseFrameInput {
  return {
    id,
    event: "job.phase_changed",
    data: { occurred_at: STARTED_AT, source, code, message, elapsedSeconds },
  };
}

export function resultAvailableFrame(
  id: string,
  outcome: OptimizationOutcome = "optimal",
): SseFrameInput {
  const infeasible = outcome === "infeasible";
  return {
    id,
    event: "job.result_available",
    data: infeasible
      ? {
          occurred_at: "2026-07-20T00:00:30+00:00",
          outcome: "infeasible",
          score: null,
          solver_status: "INFEASIBLE",
          termination_reason: "infeasibility_proven",
          artifact_name: null,
        }
      : {
          occurred_at: "2026-07-20T00:00:30+00:00",
          outcome,
          score: outcome === "optimal" ? 7 : 42,
          solver_status: outcome === "optimal" ? "OPTIMAL" : "FEASIBLE",
          termination_reason: outcome === "optimal" ? "optimality_proven" : "solver_timeout",
          artifact_name: "schedule.xlsx",
        },
  };
}

/** A strict terminal `job.state_changed` frame for a completed/cancelled/failed
 *  job. Shapes match `parseStrictTerminalFrame`. */
export function terminalFrame(id: string, state: JobState): SseFrameInput {
  const base = {
    occurred_at: FINISHED_AT,
    state,
    queue_position: null,
    cancel_requested: state === "cancelled",
    early_completion_requested: false,
    terminal: true,
    controls: { cancellable: false, early_completion_available: false },
  };
  if (state === "completed") return { id, event: "job.state_changed", data: base };
  const code = state === "cancelled" ? "cancelled" : "worker_lost";
  const message =
    state === "cancelled"
      ? "Optimization cancelled."
      : "The optimization worker stopped before the job completed.";
  return {
    id,
    event: "job.state_changed",
    data: { ...base, error: { code, message } },
  };
}

// --- route stubbing --------------------------------------------------------

/** A minimal valid `.xlsx` (empty ZIP with the local-file `PK\x03\x04` magic is
 *  enough for the download to succeed; restore is a no-op with an empty map). */
const XLSX_EMPTY_ZIP_BASE64 =
  "UEsDBBQAAAAAAAAAIQAAAAAAAAAAAAAAAAAJAAAAdGVzdC50eHRQSwECFAAUAAAAAAAAACEAAAAAAAAAAAAAAAAACQAAAAAAAAAAAAAAAAAAAAAAdGVzdC50eHRQSwUGAAAAAAEAAQA3AAAAJwAAAAAA";

export interface OptimizeRouteConfig {
  /** `/api/info` identity. Defaults to an online, version-matched backend. */
  info?: () => { status: number; body: unknown };
  /** `POST /api/optimize`. Defaults to a 202 running job. */
  onSubmit?: (route: Route) => Promise<void> | void;
  /** `GET /api/optimize/{id}` poll. Defaults to a completed job. */
  onPoll?: (route: Route) => Promise<void> | void;
  /** `GET /api/optimize/{id}/events` SSE. Defaults to a full happy-path stream. */
  onEvents?: (route: Route) => Promise<void> | void;
  /** `GET /api/optimize/{id}/xlsx`. Defaults to a valid empty workbook. */
  onXlsx?: (route: Route) => Promise<void> | void;
  /** `DELETE /api/optimize/{id}` cleanup. Defaults to 204. */
  onDelete?: (route: Route) => Promise<void> | void;
  /** `POST /api/optimize/{id}/cancel`. Defaults to a cancelled job. */
  onCancel?: (route: Route) => Promise<void> | void;
  /** `POST /api/optimize/{id}/finish-now`. Defaults to a completed feasible job. */
  onFinishNow?: (route: Route) => Promise<void> | void;
}

export function json(route: Route, status: number, body: unknown): Promise<void> {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

export function sse(route: Route, frames: SseFrameInput[]): Promise<void> {
  return route.fulfill({
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
    },
    body: sseBody(frames),
  });
}

export function xlsx(route: Route): Promise<void> {
  return route.fulfill({
    status: 200,
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": 'attachment; filename="schedule.xlsx"',
    },
    body: Buffer.from(XLSX_EMPTY_ZIP_BASE64, "base64"),
  });
}

/**
 * Install the deterministic `/api/**` boundary for one journey. Unhandled `/api`
 * calls are aborted so a missing stub fails loudly rather than hitting the dead
 * backend. Everything else (page assets) continues.
 */
export async function installOptimizeRoutes(
  page: Page,
  config: OptimizeRouteConfig = {},
): Promise<void> {
  const info =
    config.info ??
    (() => ({
      status: 200,
      body: { status: "ready", api_version: "alpha", app_version: "0.1.0" },
    }));

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    const path = url.pathname;

    if (path === "/api/info") {
      const { status, body } = info();
      return json(route, status, body);
    }
    if (path === "/api/health") {
      return json(route, 200, { status: "ok", appVersion: "0.1.0" });
    }
    if (path === "/api/optimize" && method === "POST") {
      return config.onSubmit ? config.onSubmit(route) : json(route, 202, runningJob());
    }

    const idMatch = path.match(/^\/api\/optimize\/([^/]+)(\/[a-z-]+)?$/);
    if (idMatch) {
      const sub = idMatch[2];
      if (sub === "/events") {
        return config.onEvents
          ? config.onEvents(route)
          : sse(route, [
              runningFrame("c1"),
              progressedFrame("c2", 5, 0.5),
              progressedFrame("c3", 7, 1),
              resultAvailableFrame("c4", "optimal"),
              terminalFrame("c5", "completed"),
            ]);
      }
      if (sub === "/xlsx") {
        return config.onXlsx ? config.onXlsx(route) : xlsx(route);
      }
      if (sub === "/cancel") {
        return config.onCancel ? config.onCancel(route) : json(route, 200, cancelledJob());
      }
      if (sub === "/finish-now") {
        return config.onFinishNow
          ? config.onFinishNow(route)
          : json(route, 200, completedJob(JOB_ID, { outcome: "feasible" }));
      }
      if (sub === undefined && method === "DELETE") {
        return config.onDelete ? config.onDelete(route) : route.fulfill({ status: 204, body: "" });
      }
      if (sub === undefined && method === "GET") {
        return config.onPoll ? config.onPoll(route) : json(route, 200, completedJob());
      }
    }

    return route.abort();
  });
}

/** Navigate to the durable fixture and wait for the seeded, hydrated screen. */
export async function gotoDurableFixture(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __NS_ENABLE_TEST_BRIDGE?: boolean }).__NS_ENABLE_TEST_BRIDGE = true;
  });
  await page.goto(DURABLE_FIXTURE_URL);
}
