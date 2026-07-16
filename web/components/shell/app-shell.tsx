"use client";

// App shell (T08). Composes the responsive layout: top bar, desktop sidebar
// (hidden below the 920px `nav` breakpoint), the mobile sheet (in the top bar),
// and the hydration gate. It also mounts the app-wide singletons that must exist
// exactly once: the toast surface (sonner), the shared dirty-nav confirm dialog
// (acceptance row 2), the global delete-confirm dialog (ticket item 1), the
// browser-level dirty guard, and the e2e driving seam.

import { useRouter } from "next/navigation";
import { Toaster } from "sonner";
import { useTheme } from "@/components/theme/theme-provider";
import { TopBar } from "./top-bar";
import { SidebarNav } from "./sidebar-nav";
import { HydrationGate } from "./hydration-gate";
import { ConfirmDialog } from "./confirm-dialog";
import { TestBridge } from "./test-bridge";
import { useDirtyBeforeUnload } from "./use-guarded-navigation";
import { useNavGuardStore } from "./nav-guard-store";
import { useConfirmStore } from "./confirm-store";

export function AppShell({ children }: { children: React.ReactNode }) {
  const { theme } = useTheme();
  useDirtyBeforeUnload();

  return (
    <div className="flex min-h-screen flex-col">
      <TopBar />
      <div className="flex flex-1 overflow-hidden">
        {/* Desktop sidebar — hidden below 920px (mobile uses the sheet in the top bar) */}
        <aside
          data-testid="desktop-sidebar"
          className="hidden w-[var(--sidebar-w)] shrink-0 flex-col gap-2 overflow-y-auto border-r border-line bg-sidebar p-3 nav:flex"
        >
          <SidebarNav />
        </aside>

        <main className="flex-1 overflow-y-auto">
          <HydrationGate>{children}</HydrationGate>
        </main>
      </div>

      <DirtyNavDialog />
      <GlobalConfirmDialog />
      <Toaster theme={theme} position="bottom-right" closeButton />
      <TestBridge />
    </div>
  );
}

// Dirty-nav guard (acceptance row 2). Driven by the shared nav-guard store so every
// navigation path funnels through this one dialog. The router push runs here on
// confirm; the store owns only the pending path + open flag.
function DirtyNavDialog() {
  const router = useRouter();
  const open = useNavGuardStore((s) => s.open);
  const pendingPath = useNavGuardStore((s) => s.pendingPath);
  const cancel = useNavGuardStore((s) => s.cancel);
  const clear = useNavGuardStore((s) => s.clear);

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) cancel();
      }}
      title="Unsaved changes"
      description="You have unsaved changes. Leave this page without saving?"
      confirmLabel="Leave without saving"
      cancelLabel="Stay"
      variant="destructive"
      onConfirm={() => {
        const path = pendingPath;
        clear();
        if (path) router.push(path);
      }}
    />
  );
}

// Global delete-confirm modal (ticket item 1). Bound to the imperative confirm
// store so any screen can `await confirmDialog(...)` and share this single dialog.
function GlobalConfirmDialog() {
  const request = useConfirmStore((s) => s.request);
  const settle = useConfirmStore((s) => s.settle);

  return (
    <ConfirmDialog
      open={request !== null}
      onOpenChange={(next) => {
        if (!next) settle(false);
      }}
      title={request?.title ?? ""}
      description={request?.description ?? ""}
      confirmLabel={request?.confirmLabel}
      cancelLabel={request?.cancelLabel}
      variant={request?.variant}
      onConfirm={() => settle(true)}
    />
  );
}
