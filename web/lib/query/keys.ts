// TanStack Query keys for the optimize surface.
export const optimizeKeys = {
  all: ["optimize"] as const,
  job: (jobId: string) => ["optimize", jobId] as const,
};
