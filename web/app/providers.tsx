"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { ThemeProvider } from "@/components/theme/theme-provider";
import { useLoadSingaporeHolidays } from "@/lib/query/singapore-holidays";

// App-wide client providers. Wired into the root layout so every client component
// has a TanStack Query context (T06's BFF hooks depend on it). The QueryClient is
// created once per browser session via useState so it survives re-renders but is
// never shared across requests on the server.
//
// The class-based ThemeProvider (light/dark + accent) sits inside the QueryClient
// wrapper so every client component has both contexts. The QueryClient wrapper is
// left intact per T06's ownership of the data-fetching spine.

/** The app's QueryClient defaults; shared with the Storybook harness so stories match. */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // BFF calls are explicit; avoid surprise refetches on window focus.
        refetchOnWindowFocus: false,
        retry: false,
      },
    },
  });
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(createQueryClient);

  return (
    <QueryClientProvider client={queryClient}>
      <SingaporeHolidayLoader />
      <ThemeProvider>{children}</ThemeProvider>
    </QueryClientProvider>
  );
}

/** Loads the live holiday list once per session (bead si4j); renders nothing. */
function SingaporeHolidayLoader() {
  useLoadSingaporeHolidays();
  return null;
}
