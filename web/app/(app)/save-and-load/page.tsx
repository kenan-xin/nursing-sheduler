// Save & Load (T08). The dedicated persistence surface. The full download /
// upload / anonymise editor lands with its own ticket; T08 establishes the honest
// pieces this screen must own now: the browser auto-save explanation, the
// stateful persistence status (Restoring / Saving / Saved / Save failed), the
// build version, and the destructive "Start over" reset (relocated here from the
// top bar per the prototype).

import { StartOverCard } from "@/components/shell/new-schedule-button";
import { PersistenceBadge } from "@/components/shell/persistence-status";
import { AppVersion } from "@/components/app-version";
import { FaFloppyDisk } from "@/components/icons";

export default function SaveAndLoadPage() {
  return (
    <div
      data-testid="screen"
      data-screen="Save and Load"
      className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-5 py-8"
    >
      <header className="flex items-center gap-3">
        <span className="flex size-9 items-center justify-center border border-line bg-panel text-ink2">
          <FaFloppyDisk className="size-4" />
        </span>
        <div className="flex flex-col gap-0.5">
          <h1 className="font-heading text-title font-semibold tracking-tight">Save &amp; Load</h1>
          <p className="text-meta text-ink2">
            Your work is auto-saved in this browser. Download, upload and anonymise arrive with the
            Save &amp; Load editor.
          </p>
        </div>
      </header>

      <section
        data-testid="auto-save-status"
        className="flex flex-col items-start gap-3 border border-line bg-surface p-4"
      >
        <div className="flex w-full flex-wrap items-center justify-between gap-3">
          <h2 className="font-heading text-title font-semibold tracking-tight">Auto-save</h2>
          <PersistenceBadge />
        </div>
        <p className="max-w-[60ch] text-meta text-ink2">
          Your work is saved to this browser automatically and restored when you return. The badge
          above reflects the latest write.
        </p>
        <AppVersion />
      </section>

      <StartOverCard />

      <div className="flex flex-col items-start gap-2 border border-dashed border-line bg-surface p-6">
        <p className="text-body text-ink2">
          Download, upload and anonymise land with the Save &amp; Load editor ticket.
        </p>
        <p className="text-meta text-ink3">Persistence status and start-over are available now.</p>
      </div>
    </div>
  );
}
