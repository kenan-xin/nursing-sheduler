// TanStack Query keys for the optimize surface.
export const optimizeKeys = {
  all: ["optimize"] as const,
  // The SHARED authoritative base cache for a job — read by unkeyed T06 consumers and
  // by T16b recovery. Only the current exact-token attachment mirrors into it.
  job: (jobId: string) => ["optimize", jobId] as const,
  // An ATTACHMENT-SCOPED cache for a job (T16a P1 provenance): a superseded
  // attachment writes only its own scope, never the base or a later attachment's.
  jobScoped: (jobId: string, attachmentKey: unknown) =>
    ["optimize", jobId, "attach", attachmentKey] as const,
};
