// Byte bounds for the browser SSE consumer. Two distinct kinds of bound live
// here, and the distinction is load-bearing:
//
//   1. The STRUCTURAL cursor bound (fail closed by REJECTION). The opaque
//      resume cursor is a wire-protocol shape with a defensible worst case, so
//      an oversized cursor is a protocol violation: it is never applied,
//      committed, persisted, or replayed as a `Last-Event-ID` header. SSE
//      syntax/framing itself is owned by `eventsource-parser`; there is NO
//      application-level record-size ceiling (an abnormally large complete
//      server event has no application byte-rejection boundary, matching the
//      old native `EventSource` path — see the ticket's trust-boundary note).
//
//   2. DISPLAY bounds (fail soft by UTF-8-safe TRUNCATION). Retained
//      user-visible copies are truncated to a finite ceiling so the bounded
//      histories cannot pin unbounded memory. These NEVER reject a
//      backend-valid value — the backend schemas do not cap error messages,
//      identifiers, filenames, or solver strings, so rejecting on length would
//      turn a valid job/event into malformed protocol data (cold-review P2).
//
// See `rebuild-tech-plan/tickets/sse-record-byte-bounds` for the derivation.

// --- Structural cursor bound (reject) --------------------------------------

// One SSE cursor (`SseFrame.id`, the opaque job-bound resume token). The public
// cursor is `v1.{b64url(job_id)}.{b64url(native_id)}` (`event_cursor.py::encode_cursor`):
//   - prefix `"v1."`                                    =    3 bytes
//   - `b64url(job_id)` where `parseJobResponse` caps    <= 2732 bytes
//     `job.id` at 512 chars; base64url expands 3 bytes -> 4 chars.
//   - separator `"."`                                   =    1 byte
//   - `b64url(native_id)` where the native id is a      <=   56 bytes
//     decimal int (memory store) or a canonical Redis
//     stream id `<ms>-<seq>` (<= 41 chars).
// Worst case ~= 2792 bytes. 4 KiB gives ~47% margin. This is a STRUCTURAL cap:
// an oversized cursor is rejected (never applied/committed/persisted) so it can
// neither pin retained memory nor be replayed as a `Last-Event-ID` header.
export const MAX_CURSOR_BYTES = 4096;

// --- Display retention bounds (truncate) -----------------------------------

// Short single-line labels: log labels, event names, error codes, progress/
// phase source and code identifiers. Generous vs. the longest real backend
// value (all well under 40 chars) while still finite. Sized to also hold a
// derived label that embeds a full job id (`activated:<id>`, id capped at 512
// chars by `parseJobResponse`) without cutting a valid identifier.
export const MAX_DISPLAY_LABEL_BYTES = 640;

// Filename-shaped display copies (download filename, artifact name). 255 chars
// is the common filesystem ceiling; 512 bytes absorbs UTF-8 expansion.
export const MAX_DISPLAY_FILENAME_BYTES = 512;

// Human-readable prose retained for display: error/phase messages and log
// detail summaries. 2 KiB comfortably holds any real diagnostic while bounding
// the per-entry footprint across the log budget.
export const MAX_DISPLAY_MESSAGE_BYTES = 2048;

// --- UTF-8 helpers ---------------------------------------------------------

// Count the UTF-8 byte length of `value` without allocating an encoded buffer.
// `TextEncoder.encode(value).length` allocates a Uint8Array whose size is the
// byte length — for a pathological multi-gigabyte string (which can exist
// transiently after `JSON.parse`), that allocation IS the attack. This walker
// returns the count in O(n) time and O(1) extra space.
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

// Whether `value` fits within `cap` UTF-8 bytes. Used at structural rejection
// points (cursor validation) to reject an oversized value before it pins
// memory or is replayed.
export function withinUtf8Bytes(value: string, cap: number): boolean {
  return utf8ByteLength(value) <= cap;
}

// Whether `value` is a non-empty string within `cap` UTF-8 bytes. Folds the
// structural byte-cap check into the non-empty predicate so cursor callers
// cannot forget the bound.
export function isNonEmptyStringWithin(value: unknown, cap: number): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  return utf8ByteLength(value) <= cap;
}

// Truncate `value` to at most `cap` UTF-8 bytes WITHOUT splitting a multibyte
// character. Iterates by code point (so a surrogate pair is kept whole) and
// stops before the byte budget would be exceeded. Returns `value` unchanged
// when it already fits. This is the single retained-display helper: it bounds
// user-visible copies without ever rejecting a backend-valid value.
export function truncateUtf8(value: string, cap: number): string {
  if (utf8ByteLength(value) <= cap) return value;
  let bytes = 0;
  let end = 0;
  for (const char of value) {
    const charBytes = utf8ByteLength(char);
    if (bytes + charBytes > cap) break;
    bytes += charBytes;
    end += char.length; // 1, or 2 for an astral-plane surrogate pair
  }
  return value.slice(0, end);
}
