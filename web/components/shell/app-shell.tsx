"use client";

// App shell (T08, BLOCKER 1). The desktop root is a ROW: a sticky, full-height
// (100dvh) branded side rail from the top edge, beside a main column whose 56px
// bg-surface contextual top bar and scrollable content live INSIDE that column
// only (never a full-viewport dark bar above everything). Below the 920px `nav`
// breakpoint the rail is hidden and the same AppSideNav composition is reached
// through the mobile drawer in the top bar.
//
// It also mounts the app-wide singletons that must exist exactly once: the toast
// surface (sonner, themed to the prototype), the shared dirty-nav confirm dialog
// (acceptance row 2), the global delete-confirm dialog (ticket item 1), the
// browser-level dirty guard, and the e2e driving seam.

import { Toaster } from "sonner";
import { useTheme } from "@/components/theme/theme-provider";
import { AppSideNav } from "./app-side-nav";
import { TopBar } from "./top-bar";
import { HydrationGate } from "./hydration-gate";
import { ConfirmDialog } from "./confirm-dialog";
import { TestBridge } from "./test-bridge";
import { useBrowserBackGuard, useDirtyBeforeUnload } from "./use-guarded-navigation";
import { useNavGuardStore } from "./nav-guard-store";
import { useConfirmStore } from "./confirm-store";

export function AppShell({ children }: { children: React.ReactNode }) {
  const { theme } = useTheme();
  useDirtyBeforeUnload();
  useBrowserBackGuard();

  return (
    <div className="flex h-dvh overflow-hidden">
      {/* Desktop rail — full-height from the top edge; hidden below 920px. */}
      <aside
        data-testid="desktop-sidebar"
        className="hidden w-[var(--sidebar-w)] shrink-0 border-r border-line bg-sidebar nav:block"
      >
        <AppSideNav />
      </aside>

      {/* Main column — contextual top bar + scrollable content. */}
      <main className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <HydrationGate>{children}</HydrationGate>
        </div>
      </main>

      <DirtyNavDialog />
      <GlobalConfirmDialog />
      <Toaster
        theme={theme}
        position="bottom-center"
        className="ns-sonner"
        toastOptions={{ className: "ns-toast" }}
      />
      <TestBridge />
    </div>
  );
}

// Navigation-intent guard (T08a/b, acceptance row 2). Driven by the shared
// nav-guard store so every push/replace/back funnels through this one dialog.
// `confirm`/`cancel` run the staged intent's own `commit`/`onCancel` — the
// shell renders the dialog but holds no router or history logic itself.
function DirtyNavDialog() {
  const open = useNavGuardStore((s) => s.open);
  const confirm = useNavGuardStore((s) => s.confirm);
  const cancel = useNavGuardStore((s) => s.cancel);

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
      onConfirm={confirm}
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
      consequences={request?.consequences}
      onConfirm={() => settle(true)}
    />
  );
}
