// Route-group layout for the product screens (T08). Everything under `(app)` is
// wrapped in the responsive AppShell (top bar, nav, hydration gate, toasts,
// confirm dialogs). The design-system reference at `/design-system` lives OUTSIDE
// this group, so it renders bare (no shell chrome, no nested <main>).
//
// The route group `(app)` does not affect URLs — `app/(app)/page.tsx` is `/`.

import { AppShell } from "@/components/shell/app-shell";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
