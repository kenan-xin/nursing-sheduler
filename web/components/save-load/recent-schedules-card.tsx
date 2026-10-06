"use client";

// Recent schedules card (plq5 P1). Every New and Load keeps the schedule it left;
// this card lists them and reopens, renames, pins and deletes them. An L1 card with
// the Save & Load head band; the list itself is a square data surface with hairline
// rows (DESIGN.md: data surfaces stay square).
//
// Opening is the same atomic switch as Load. Each schedule keeps its own roster
// (plq5 P2), so nothing is cleared: the one being left keeps its roster too.

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { disambiguateScheduleNames, RECENT_SCHEDULES_LIMIT } from "@/lib/scenario";
import {
  scenarioCommands,
  useAuthorityStore,
  type ScheduleActionOutcome,
  type ScheduleSummary,
} from "@/lib/store";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { surfaceVariants } from "@/components/ui/surface";
import { FaPen, FaThumbtack, FaTrash } from "@/components/icons";
import { cn } from "@/lib/utils";

const FAILURE_COPY: Record<Extract<ScheduleActionOutcome, { ok: false }>["reason"], string> = {
  "open-here": "This schedule is open here. Open another schedule first, then delete this one.",
  "open-elsewhere": "This schedule is being edited in another tab. Close it there first.",
  "storage-full": "Browser storage is full. Delete old schedules in Save & Load.",
  failed: "That did not work. Nothing was changed.",
};

const RELATIVE = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

/** "Last edited 3 days ago". */
export function lastEditedLabel(updatedAt: string, now: Date = new Date()): string {
  const seconds = (new Date(updatedAt).getTime() - now.getTime()) / 1000;
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size)
      return `Last edited ${RELATIVE.format(Math.round(seconds / size), unit)}`;
  }
  return "Last edited just now";
}

/** Ask the browser to keep this site's storage. `null` when it cannot be asked. */
async function requestPersistentStorage(): Promise<boolean | null> {
  if (typeof navigator === "undefined" || !navigator.storage?.persist) return null;
  try {
    return await navigator.storage.persist();
  } catch {
    return null;
  }
}

export interface RecentSchedulesCardProps {
  /** Runs after a schedule was opened, so the caller can close its own editors. */
  onOpened?: () => void;
  /** Test seam for `navigator.storage.persist()`. */
  requestPersist?: () => Promise<boolean | null>;
}

interface Row extends ScheduleSummary {
  name: string;
  openHere: boolean;
}

export function RecentSchedulesCard({
  onOpened,
  requestPersist = requestPersistentStorage,
}: RecentSchedulesCardProps) {
  const scenarioId = useAuthorityStore((s) => s.scenarioId);
  const recordRevision = useAuthorityStore((s) => s.recordRevision);
  const documentRevision = useAuthorityStore((s) => s.documentRevision);
  const ownership = useAuthorityStore((s) => s.ownership);
  const removedSchedules = useAuthorityStore((s) => s.removedSchedules);
  const [summaries, setSummaries] = useState<ScheduleSummary[] | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Row | null>(null);
  const [busy, setBusy] = useState(false);

  // A reread still in flight when the card unmounts is dropped, not applied: it would
  // otherwise set state on a dead tree (in tests, after the jsdom window is gone).
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    let next: ScheduleSummary[];
    try {
      next = await scenarioCommands.listSchedules();
    } catch {
      next = [];
    }
    if (mounted.current) setSummaries(next);
  }, []);

  // Reread whenever this tab's schedule, revision or ownership moves, and at every
  // resumption point (another tab may have opened, renamed or deleted one).
  useEffect(() => {
    void refresh();
  }, [refresh, scenarioId, recordRevision, documentRevision, ownership]);
  useEffect(() => {
    const onFocus = () => void refresh();
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  // Announce each schedule the limit removed. A remount does not repeat it.
  const announced = useRef(removedSchedules);
  useEffect(() => {
    if (removedSchedules === announced.current) return;
    announced.current = removedSchedules;
    for (const name of removedSchedules) {
      toast.info(`Removed "${name}" to stay within ${RECENT_SCHEDULES_LIMIT} unpinned schedules.`);
    }
  }, [removedSchedules]);

  const names = disambiguateScheduleNames(
    (summaries ?? []).map((summary) => ({
      name: summary.title ?? summary.autoName,
      createdAt: summary.createdAt,
    })),
  );
  const rows: Row[] = (summaries ?? []).map((summary, index) => ({
    ...summary,
    name: names[index]!,
    openHere: summary.scenarioId === scenarioId,
  }));

  // The limit notice comes BEFORE any removal: at the limit, say which one goes next.
  const unpinned = rows.filter((row) => !row.pinned && !row.blank);
  const nextRemoved =
    unpinned.length >= RECENT_SCHEDULES_LIMIT
      ? unpinned.filter((row) => !row.heldByOtherTab).at(-1)
      : undefined;

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const open = (row: Row) =>
    run(async () => {
      const outcome = await scenarioCommands.openSchedule(row.scenarioId);
      if (!outcome.ok) {
        toast.error("Could not open that schedule. Your current schedule has been kept.");
        return;
      }
      onOpened?.();
      toast.success(`Opened "${row.name}"`);
    });

  const rename = (row: Row, title: string) =>
    run(async () => {
      const outcome = await scenarioCommands.renameSchedule(row.scenarioId, title);
      if (!outcome.ok) {
        toast.error(FAILURE_COPY[outcome.reason]);
        return;
      }
      setRenaming(null);
    });

  const togglePin = (row: Row) =>
    run(async () => {
      const pinned = !row.pinned;
      const outcome = await scenarioCommands.setSchedulePinned(row.scenarioId, pinned);
      if (!outcome.ok) {
        toast.error(FAILURE_COPY[outcome.reason]);
        return;
      }
      if (!pinned) {
        toast.success(`Unpinned "${row.name}"`);
        return;
      }
      // Pinning stops the LIST removing it; only the browser can stop the browser
      // clearing the whole site under storage pressure, so ask, and report its answer.
      const persisted = await requestPersist();
      if (persisted) {
        toast.success(`Pinned "${row.name}". This browser will keep its saved schedules.`);
      } else {
        toast.warning(
          `Pinned "${row.name}". This browser ${persisted === null ? "cannot promise" : "did not promise"} to keep saved data when space runs low. Download a copy to be safe.`,
        );
      }
    });

  const confirmDelete = async () => {
    const row = deleting;
    if (!row) return;
    await run(async () => {
      const outcome = await scenarioCommands.deleteSchedule(row.scenarioId);
      if (!outcome.ok) {
        toast.error(FAILURE_COPY[outcome.reason]);
        return;
      }
      toast.success(`Deleted "${row.name}"`);
    });
  };

  return (
    <section
      data-testid="recent-schedules-card"
      className={cn("flex flex-col", surfaceVariants({ role: "surface", geometry: "card" }))}
    >
      <div className="flex flex-col gap-1 border-b border-line2 px-5 py-4">
        <h2
          id="recent-schedules-title"
          className="font-heading text-cardhead font-semibold tracking-[-0.015em] text-ink"
        >
          Recent schedules
        </h2>
        <p className="max-w-[60ch] text-meta text-ink2">
          Keeps your {RECENT_SCHEDULES_LIMIT} most recent schedules. Pin one to keep it.
        </p>
      </div>
      <div className="flex flex-col gap-3 px-5 py-4">
        {nextRemoved ? (
          <p
            role="status"
            data-testid="recent-schedules-limit-notice"
            className="rounded-control border border-warn bg-warntint p-3 text-meta text-warnink"
          >
            {`You have ${unpinned.length} unpinned schedules. The next new or loaded schedule removes "${nextRemoved.name}". Pin it to keep it.`}
          </p>
        ) : null}
        {summaries === null ? (
          <p className="text-meta text-ink3">Loading schedules…</p>
        ) : (
          <ul
            aria-labelledby="recent-schedules-title"
            className="flex flex-col divide-y divide-line2"
          >
            {rows.map((row) => (
              <li
                key={row.scenarioId}
                data-testid="recent-schedule-row"
                data-open-here={row.openHere || undefined}
                className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0"
              >
                {renaming === row.scenarioId ? (
                  <RenameForm
                    row={row}
                    busy={busy}
                    onSave={(title) => void rename(row, title)}
                    onCancel={() => setRenaming(null)}
                  />
                ) : (
                  <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 truncate font-semibold text-ink" title={row.name}>
                        {row.name}
                      </span>
                      {row.openHere ? <Badge variant="brand">Open here</Badge> : null}
                      {row.heldByOtherTab ? (
                        <Badge variant="warn">Open in another tab</Badge>
                      ) : null}
                      {row.pinned ? <Badge>Pinned</Badge> : null}
                      {row.hasRoster ? <Badge>Has roster</Badge> : null}
                    </div>
                    <span className="text-meta text-ink2">
                      {row.title ? `${row.autoName} · ` : ""}
                      {lastEditedLabel(row.updatedAt)}
                    </span>
                    {row.derivedFrom ? (
                      <span className="text-meta text-ink3">Based on {row.derivedFrom}</span>
                    ) : null}
                  </div>
                )}
                {renaming === row.scenarioId ? null : (
                  <div className="flex flex-wrap items-center gap-2">
                    {row.openHere ? null : (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy}
                        aria-label={`Open ${row.name}`}
                        onClick={() => void open(row)}
                      >
                        Open
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      aria-label={`Rename ${row.name}`}
                      onClick={() => setRenaming(row.scenarioId)}
                    >
                      <FaPen aria-hidden />
                      Rename
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      aria-pressed={row.pinned}
                      aria-label={`${row.pinned ? "Unpin" : "Pin"} ${row.name}`}
                      onClick={() => void togglePin(row)}
                    >
                      <FaThumbtack aria-hidden />
                      {row.pinned ? "Unpin" : "Pin"}
                    </Button>
                    {row.openHere ? null : (
                      <Button
                        size="sm"
                        variant="destructive-outline"
                        disabled={busy || row.heldByOtherTab}
                        aria-label={`Delete ${row.name}`}
                        onClick={() => setDeleting(row)}
                      >
                        <FaTrash aria-hidden />
                        Delete
                      </Button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="max-w-[60ch] text-meta text-ink3">
          Schedules are stored only in this browser, with real names. Delete a schedule to remove
          it. Each schedule keeps its own roster.
        </p>
      </div>
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(next) => {
          if (!next) setDeleting(null);
        }}
        title={`Delete "${deleting?.name ?? ""}"?`}
        description="Its roster and assistant conversation are deleted too. This cannot be undone. To keep a copy, open it and download it first."
        confirmLabel="Delete schedule"
        busyLabel="Deleting…"
        variant="destructive"
        onConfirm={confirmDelete}
      />
    </section>
  );
}

function RenameForm({
  row,
  busy,
  onSave,
  onCancel,
}: {
  row: Row;
  busy: boolean;
  onSave: (title: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(row.title ?? "");
  const inputId = `rename-${row.scenarioId}`;
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(draft);
      }}
    >
      <label htmlFor={inputId} className="text-meta font-semibold text-ink">
        Schedule name
      </label>
      <Input
        id={inputId}
        autoFocus
        value={draft}
        maxLength={120}
        placeholder={row.autoName}
        aria-describedby={`${inputId}-hint`}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") onCancel();
        }}
      />
      <span id={`${inputId}-hint`} className="text-meta text-ink3">
        Leave empty to use &ldquo;{row.autoName}&rdquo;.
      </span>
      <div className="flex gap-2">
        <Button size="sm" type="submit" disabled={busy}>
          Save name
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
