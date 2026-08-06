// T10 — installing the real DiagnosticCanceller into T05's contract.
//
// Kept in its own module so the assistant store depends on ONE function rather than
// on the transport helpers, the job parser, and the owned-job registry. That matters
// because the store is imported by nearly every assistant surface: widening what it
// pulls in would make an unrelated import graph depend on the optimize client.

import { setDiagnosticCanceller } from "@/lib/ai/assistant/diagnostic-cancellation";
import { postCancelOptimizeJob } from "@/lib/query/optimize";
import { OptimizeApiError } from "@/lib/bff/errors";
import type { JobResponse } from "@/lib/bff/types";
import { createDiagnosticCanceller } from "./diagnostic-canceller";

/**
 * Install T10's cancellation ownership.
 *
 * Deliberately UNCONDITIONAL rather than guarded by a "already installed" flag:
 * bring-up runs more than once per page lifetime, and with a flag the canceller in
 * force would depend on whether anything had reset it since the first call — a
 * property no caller can see. Assigning every time makes bring-up genuinely
 * establish the canceller, and the assignment itself costs nothing.
 */
export function installDiagnosticCanceller(): void {
  setDiagnosticCanceller(
    createDiagnosticCanceller({
      async cancelJob(jobId, signal) {
        await postCancelOptimizeJob(jobId, signal);
      },
      async readJob(jobId, signal) {
        try {
          const response = await fetch(`/api/optimize/${encodeURIComponent(jobId)}`, {
            cache: "no-store",
            signal,
          });
          if (!response.ok) {
            // A job the server no longer holds is gone, not unreadable: the caller
            // classifies that as terminal_other, which is the truth — there is
            // nothing left to cancel and no evidence to forward.
            throw new OptimizeApiError(response.status, await response.json().catch(() => null));
          }
          return (await response.json()) as JobResponse;
        } catch {
          return null;
        }
      },
    }),
  );
}
