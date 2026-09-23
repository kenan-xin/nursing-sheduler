"use client";

// Shift Requests screen (T11, spec 04; prototype ScreenRequests.dc.html). The
// orchestrator composes the toolbar, the quick-paint panel, the clear-data
// panel, the legend + leave-pin note, the virtualized matrix, the derived
// "Current shift requests"/"Current people history" tables, and the four
// modals. Mode/preset/modal/clear-confirm state is local (`useState`) — never
// in the durable store; every actual mutation routes through `useRequests`
// (one tracked store write per operation).

import { useEffect, useMemo, useRef, useState } from "react";
import { GuardedLink } from "@/components/shell/guarded-link";
import { toast } from "sonner";
import { FaCircleInfo, FaLayerGroup, FaTableCells } from "@/components/icons";
// Not re-exported from the icon barrel (icons.tsx is owned by a concurrently
// edited ticket) — imported directly per the project's react-icons/fa6
// convention (see requests-toolbar.tsx).
import { FaThumbtack } from "react-icons/fa6";
import { RESERVED_SHIFT_TYPE, type DateRef, type PersonRef } from "@/lib/scenario";
import { useScenarioStore } from "@/lib/store";
import { Surface } from "@/components/ui/surface";
import { RequestsToolbar } from "./requests-toolbar";
import { QuickPaintPanel, type PaintTarget } from "./quick-paint-panel";
import { parseQuickPaintWeight } from "./quick-paint-status";
import { ClearDataPanel, type ClearButton } from "./clear-data-panel";
import { ClearConfirmDialog } from "./clear-confirm-dialog";
import { RequestsMatrix } from "./requests-matrix";
import { CellPreferenceEditor, type WeightTarget } from "./cell-preference-editor";
import { HistoryEditor, type HistoryOption } from "./history-editor";
import { RequestsCsvModal } from "./requests-csv-modal";
import { CurrentRequestsTable, type CurrentRequestRow } from "./current-requests-table";
import { CurrentHistoryTable, type CurrentHistoryPerson } from "./current-history-table";
import { cellPreferenceSet, resolveDayStatePrecedence, weightDisplayLabel } from "./requests-model";
import { validatePeopleHistoryCsv, validateShiftRequestCsv } from "./requests-csv";
import { useRequests } from "./use-requests";

type ConfirmState = { text: string; onConfirm: () => void } | null;
type CsvKind = "requests" | "history" | null;
// `origin` is the exact matrix element that opened the editor. It is held
// ALONGSIDE the coordinate, never derived from it: after a commit the matrix
// re-renders and a coordinate-shaped `querySelector` could resolve to a
// different node (or, once virtualization recycles the row, to none), so the
// element itself is the only honest focus-restoration target.
type CellEditorState = { person: PersonRef; date: DateRef; origin: HTMLElement } | null;
type HistoryEditorState = {
  personId: PersonRef;
  historyIndex: number;
  origin: HTMLElement;
} | null;

const RESERVED_TARGET_LABELS: Record<string, string> = {
  OFF: "Off / rest day",
  LEAVE: "Paid leave (pin)",
  ALL: "All worked shifts",
};

export function RequestsEditor() {
  const state = useScenarioStore((s) => s);
  const [mode, setMode] = useState<"normal" | "quick">("normal");
  const [quickSelectedIds, setQuickSelectedIds] = useState<string[]>([]);
  const [quickWeightText, setQuickWeightText] = useState("0");
  const [clearOpen, setClearOpen] = useState(false);
  const [csvOpen, setCsvOpen] = useState<CsvKind>(null);
  const [confirm, setConfirm] = useState<ConfirmState>(null);
  const [cellEditor, setCellEditor] = useState<CellEditorState>(null);
  const [historyEditor, setHistoryEditor] = useState<HistoryEditorState>(null);

  const {
    rows,
    columns,
    people,
    reqData,
    historyCount,
    historyLabels,
    shiftTypeOrderIndex,
    hasRequiredData,
    missingRequirement,
    stagedKeys,
    onCellPointerDown,
    onCellPointerEnter,
    onHistoryPointerDown,
    onHistoryPointerEnter,
    commitCellEdit,
    clearCell,
    commitHistorySet,
    commitHistoryClear,
    applyRequestsCsv,
    applyHistoryCsv,
    clearAllRequests,
    clearAllHistory,
    clearRequestsByShape,
  } = useRequests({
    quickPaintSelectedIds: quickSelectedIds,
    quickPaintWeightText: quickWeightText,
  });

  // FR-SR-34: BOTH CSV uploads are Quick-paint-only — the toolbar renders them
  // only in quick mode. Within quick mode the Requests CSV applies at the
  // shared quick-paint weight, so it needs a *parseable* weight — 0 is a valid
  // (removal) weight, so only an unparsed/invalid entry disables it.
  const requestsCsvDisabled = parseQuickPaintWeight(quickWeightText) === null;
  const requestsCsvDisabledReason = "Set a valid weight to import shift requests.";

  const paintTargets: PaintTarget[] = useMemo(
    () => [
      ...state.shifts.map((s) => ({ id: String(s.id), name: s.description ?? String(s.id) })),
      { id: "OFF", name: RESERVED_TARGET_LABELS.OFF },
      { id: "LEAVE", name: RESERVED_TARGET_LABELS.LEAVE },
      ...state.shiftGroups.map((g) => ({ id: g.id, name: g.description ?? g.id })),
      { id: "ALL", name: RESERVED_TARGET_LABELS.ALL },
    ],
    [state.shifts, state.shiftGroups],
  );

  const cellEditorTargets: WeightTarget[] = useMemo(
    () => [
      ...state.shifts.map((s) => ({
        id: String(s.id),
        name: s.description ?? String(s.id),
        isGroup: false,
      })),
      ...state.shiftGroups.map((g) => ({ id: g.id, name: g.description ?? g.id, isGroup: true })),
    ],
    [state.shifts, state.shiftGroups],
  );

  const historyOptions: HistoryOption[] = useMemo(
    () => [
      ...state.shifts.map((s) => ({ id: String(s.id), label: String(s.id) })),
      { id: "OFF", label: "OFF" },
      { id: "LEAVE", label: "LEAVE" },
    ],
    [state.shifts],
  );

  // --- FR-SR-39/40 derived tables ----------------------------------------
  const personLookup = useMemo(() => {
    const map = new Map<PersonRef, { label: string; isGroup: boolean }>();
    rows.forEach((r) => map.set(r.id, { label: r.label, isGroup: r.isGroup }));
    return map;
  }, [rows]);

  const columnLookup = useMemo(() => {
    const map = new Map<DateRef, { label: string; isGroup: boolean }>();
    columns.forEach((c) => map.set(c.ref, { label: c.label, isGroup: c.kind === "date-group" }));
    return map;
  }, [columns]);

  // FR-SR-39 + the conflict/preservation boundary: the derived table reads
  // `reqData` through the SAME day-state precedence the matrix renders (LEAVE >
  // OFF > worked), so an imported day-state+request conflict at one coordinate
  // yields ONE row (the surviving day-state), not a row per raw cell. The
  // resolved list also backs the footer count so the two always agree.
  const resolvedCells = useMemo(() => resolveDayStatePrecedence(reqData), [reqData]);

  const currentRequestRows: CurrentRequestRow[] = useMemo(() => {
    return resolvedCells.map((cell, index) => {
      const person = personLookup.get(cell.person);
      const date = columnLookup.get(cell.date);
      const personLabel = person?.label ?? String(cell.person);
      const dateLabel = date?.label ?? String(cell.date);
      const key = cell.uid ?? `${String(cell.person)}:${String(cell.date)}:${cell.kind}:${index}`;
      if (cell.kind === "leave") {
        return {
          key,
          person: personLabel,
          personIsGroup: person?.isGroup ?? false,
          dateLabel,
          dateIsGroup: date?.isGroup ?? false,
          shiftLabel: "LEAVE",
          weightLabel: "pinned",
          weightTone: "pin",
          caption: "paid leave · hard pin",
        };
      }
      if (cell.kind === "off") {
        const w = cell.weight;
        return {
          key,
          person: personLabel,
          personIsGroup: person?.isGroup ?? false,
          dateLabel,
          dateIsGroup: date?.isGroup ?? false,
          shiftLabel: "OFF",
          weightLabel: weightDisplayLabel(w),
          weightTone: w > 0 ? "positive" : w < 0 ? "negative" : "neutral",
          caption: w > 0 ? "wants off" : w < 0 ? "avoids off" : "requests off",
        };
      }
      return {
        key,
        person: personLabel,
        personIsGroup: person?.isGroup ?? false,
        dateLabel,
        dateIsGroup: date?.isGroup ?? false,
        shiftLabel: cell.shiftType,
        weightLabel: weightDisplayLabel(cell.weight),
        weightTone: cell.weight > 0 ? "positive" : "negative",
        caption: cell.weight > 0 ? "wants" : "avoids",
      };
    });
  }, [resolvedCells, personLookup, columnLookup]);

  const currentHistoryPeople: CurrentHistoryPerson[] = useMemo(() => {
    return people
      .filter((p) => (p.history?.length ?? 0) > 0)
      .map((p) => {
        const history = p.history!;
        return {
          key: String(p.id),
          person: String(p.id),
          entries: history.map((val, j) => {
            const n = history.length - j;
            const kind =
              val === "LEAVE"
                ? ("leave" as const)
                : val === "OFF"
                  ? ("off" as const)
                  : ("worked" as const);
            const label = val === "LEAVE" ? "Lv" : val === "OFF" ? "Off" : val;
            return { hn: `H-${n}`, label, kind };
          }),
        };
      });
  }, [people]);

  // --- CSV -----------------------------------------------------------------
  function handleRequestsCsvFile(text: string) {
    const parsedWeight = parseQuickPaintWeight(quickWeightText);
    const result = validateShiftRequestCsv(text, {
      peopleIds: state.staff.map((p) => String(p.id)),
      dateItemIds: columns.filter((c) => c.kind === "date-item").map((c) => c.ref as string),
      validShiftTypeIds: [
        ...state.shifts.map((s) => String(s.id)),
        ...state.shiftGroups.map((g) => g.id),
      ],
      weight: parsedWeight ?? quickWeightText,
    });
    if (!result.ok) {
      toast.error(`CSV validation failed: ${result.error}`);
      return;
    }
    if (result.data.length === 0) {
      toast.error("No valid shift preferences found in CSV file.");
      return;
    }
    applyRequestsCsv(result.data, parsedWeight!);
    setCsvOpen(null);
    toast.success(`Successfully processed CSV file with ${result.data.length} shift preferences!`);
  }

  function handleHistoryCsvFile(text: string) {
    // FR-SR-37 parity: history may hold worked items + the reserved OFF/LEAVE
    // (the old app validates people-history CSV against `shiftTypeData.items`,
    // which includes the AUTO_GENERATED_ITEMS OFF/LEAVE) — never groups.
    const result = validatePeopleHistoryCsv(text, {
      peopleIds: state.staff.map((p) => String(p.id)),
      validShiftTypeItemIds: [
        ...state.shifts.map((s) => String(s.id)),
        RESERVED_SHIFT_TYPE.off,
        RESERVED_SHIFT_TYPE.leave,
      ],
    });
    if (!result.ok) {
      toast.error(`CSV validation failed: ${result.error}`);
      return;
    }
    if (result.data.length === 0) {
      toast.error("No valid entries found in the people history CSV file.");
      return;
    }
    applyHistoryCsv(result.data);
    setCsvOpen(null);
    toast.success(
      `Successfully processed ${result.data.length} shift type entries from people history CSV!`,
    );
  }

  // --- Clear data ------------------------------------------------------------
  function askConfirm(text: string, onConfirm: () => void) {
    setConfirm({ text, onConfirm });
  }

  // Labels + order match the canonical set (ScreenRequests.dc.html:607-614):
  // all-history, all-requests, then the four person/group x individual/group
  // shapes with a right arrow between the two axes.
  const clearButtons: ClearButton[] = [
    {
      label: "All people history",
      onClick: () =>
        askConfirm("Are you sure you want to clear all people history?", clearAllHistory),
    },
    {
      label: "All requests",
      onClick: () =>
        askConfirm("Are you sure you want to clear ALL shift requests?", clearAllRequests),
    },
    {
      label: "Person → individual dates",
      onClick: () =>
        askConfirm(
          "Are you sure you want to clear all requests between individual people and individual dates?",
          () => clearRequestsByShape("individual", "individual"),
        ),
    },
    {
      label: "Group → individual dates",
      onClick: () =>
        askConfirm(
          "Are you sure you want to clear all requests between people groups and individual dates?",
          () => clearRequestsByShape("group", "individual"),
        ),
    },
    {
      label: "Person → date groups",
      onClick: () =>
        askConfirm(
          "Are you sure you want to clear all requests between individual people and date groups?",
          () => clearRequestsByShape("individual", "group"),
        ),
    },
    {
      label: "Group → date groups",
      onClick: () =>
        askConfirm(
          "Are you sure you want to clear all requests between people groups and date groups?",
          () => clearRequestsByShape("group", "group"),
        ),
    },
  ];

  // --- Cell / history editor wiring ------------------------------------------
  //
  // Focus restoration (F3): both editors promise focus back to the matrix cell
  // that opened them. Base UI restores focus to whatever was focused when the
  // dialog opened, which is only the right element because the matrix cells are
  // now real keyboard controls that take focus on activation — but the parent
  // unmounts these editors outright rather than animating them closed, so the
  // restoration is made explicit here instead of being left to that ordering.
  //
  // The element is stashed on close and focused from an effect, i.e. after React
  // has committed the unmount, so focus is never handed to a node while the
  // overlay still owns the focus trap. A stale origin (its row scrolled out of
  // the virtualizer, its person deleted) is simply dropped: focusing `body` or
  // the nearest lookalike cell would be worse than leaving focus where it is.
  const pendingRefocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const origin = pendingRefocus.current;
    if (!origin) return;
    pendingRefocus.current = null;
    if (origin.isConnected) origin.focus();
  }, [cellEditor, historyEditor]);

  function openCellEditor(person: PersonRef, date: DateRef, origin: HTMLElement) {
    setCellEditor({ person, date, origin });
  }
  function openHistoryEditor(person: PersonRef, historyIndex: number, origin: HTMLElement) {
    setHistoryEditor({ personId: person, historyIndex, origin });
  }
  /** Every Cell Preference close path — Escape, backdrop, Cancel, Save, Clear. */
  function closeCellEditor() {
    pendingRefocus.current = cellEditor?.origin ?? null;
    setCellEditor(null);
  }
  /** Every History close path — Escape, backdrop, X, Done, option select, Clear. */
  function closeHistoryEditor() {
    pendingRefocus.current = historyEditor?.origin ?? null;
    setHistoryEditor(null);
  }

  const activeCellCells = cellEditor
    ? cellPreferenceSet(reqData, cellEditor.person, cellEditor.date)
    : [];
  const activeHistoryPerson = historyEditor
    ? people.find((p) => p.id === historyEditor.personId)
    : undefined;
  const activeHistoryValue =
    historyEditor && activeHistoryPerson
      ? ((activeHistoryPerson.history ?? [])[
          historyEditor.historyIndex - (historyCount - (activeHistoryPerson.history?.length ?? 0))
        ] ?? null)
      : null;

  if (!hasRequiredData) {
    return (
      <Surface
        level="page"
        geometry="square"
        data-testid="screen"
        data-screen="Shift Requests"
        className="flex flex-col gap-6"
      >
        <header className="flex items-center gap-3">
          <span className="flex size-9 items-center justify-center rounded-control border border-line bg-panel text-ink2">
            <FaTableCells className="size-4" />
          </span>
          <div className="flex flex-col gap-0.5">
            <h1 className="font-heading text-title font-semibold tracking-[-0.015em]">
              Requests &amp; Leave
            </h1>
            <p className="text-meta text-ink2">
              Record per-person shift requests, leave, and preferences.
            </p>
          </div>
        </header>
        <div
          className="flex flex-col items-start gap-2 rounded-card border border-dashed border-line bg-surface p-6 shadow-1"
          data-testid="requests-required-data-gate"
        >
          {missingRequirement === "dates" && (
            <p className="text-body text-ink2">
              Set a roster date range on the{" "}
              <GuardedLink href="/dates" className="font-semibold text-brandink underline">
                Dates
              </GuardedLink>{" "}
              screen before authoring shift requests.
            </p>
          )}
          {missingRequirement === "people" && (
            <p className="text-body text-ink2">
              Add at least one person on the{" "}
              <GuardedLink href="/people" className="font-semibold text-brandink underline">
                Staff
              </GuardedLink>{" "}
              screen before authoring shift requests.
            </p>
          )}
          {missingRequirement === "shiftTypes" && (
            <p className="text-body text-ink2">
              Add at least one shift type on the{" "}
              <GuardedLink href="/shift-types" className="font-semibold text-brandink underline">
                Shifts
              </GuardedLink>{" "}
              screen before authoring shift requests.
            </p>
          )}
        </div>
      </Surface>
    );
  }

  return (
    <Surface
      level="page"
      geometry="square"
      data-testid="screen"
      data-screen="Shift Requests"
      className="flex flex-col gap-4"
    >
      <header className="mb-2 flex flex-wrap items-end gap-4">
        <div className="min-w-[240px] flex-1">
          <div className="mb-2 text-label font-semibold uppercase tracking-[0.03em] text-brandink">
            Step 5 · Requests &amp; Leave
          </div>
          {/* Display: Figtree 700 / 1.15 / -0.015em (DESIGN.md §3). v1 ran 800
              at 1.05 and -0.02em; v2 is one weight step lighter with an opener line. */}
          <h1 className="mb-2 font-heading text-display font-bold leading-[1.15] tracking-[-0.015em]">
            Requests &amp; Leave
          </h1>
          <p className="max-w-[66ch] text-ink2">
            Pin approved paid leave, set off-days, and enter shift preferences. Use Quick paint to
            drag presets across cells, or Edit to open a cell and set a precise weight per shift.
          </p>
        </div>
      </header>

      <RequestsToolbar
        mode={mode}
        onSetMode={setMode}
        onOpenRequestsCsv={() => setCsvOpen("requests")}
        onOpenHistoryCsv={() => setCsvOpen("history")}
        clearOpen={clearOpen}
        onToggleClear={() => setClearOpen((v) => !v)}
        requestsCsvDisabled={requestsCsvDisabled}
        requestsCsvDisabledReason={requestsCsvDisabledReason}
      />

      {mode === "quick" && (
        <QuickPaintPanel
          targets={paintTargets}
          selectedIds={quickSelectedIds}
          onToggle={(id) =>
            setQuickSelectedIds((ids) =>
              ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id],
            )
          }
          weight={quickWeightText}
          onWeightChange={setQuickWeightText}
          onSetPosInf={() => setQuickWeightText("∞")}
          onSetNegInf={() => setQuickWeightText("-∞")}
        />
      )}

      {clearOpen && <ClearDataPanel buttons={clearButtons} />}

      <div className="mb-3 flex flex-wrap items-center gap-3.5 text-meta font-medium text-ink2">
        <span className="inline-flex items-center gap-1.5">
          <span className="size-3 border border-brand bg-brandtint" /> Paid leave (pin)
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-3 border border-error bg-errortint" /> Off
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-3 border border-success bg-successtint" /> Prefers (+)
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-3 border border-warn bg-warntint" /> Avoid (−)
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-3 border border-warn bg-warntint" /> H-n · recent history
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-3 border border-brand bg-brandtint" /> Date-group column
        </span>
      </div>
      {/* Full-bleed note strips are square and flat (DESIGN.md §4 rule 2): the
          shortcut strip is a --panel band with its prototype hairline, and the
          paid-leave strip is a borderless --brandtint callout (ScreenRequests
          authors it without a border). Neither takes a radius or a well shadow. */}
      <div className="mb-3 flex items-start gap-2.5 rounded-none border border-line bg-panel p-3.5">
        <FaLayerGroup className="mt-0.5 size-3 text-brandink" />
        <div className="text-meta text-ink2">
          <b>Shortcut rows &amp; columns.</b> The top people-group rows set one preference for every
          nurse in the group at once. Date-group columns (ALL, WEEKDAY, WEEKEND, and your own
          groups) apply to every date in the group. H-n columns capture recent history — click a
          slot to edit it. Group rows have no history.
        </div>
      </div>
      <div className="mb-4 flex items-start gap-2.5 rounded-none bg-brandtint p-3.5">
        <FaThumbtack className="mt-0.5 size-3 text-brandink" />
        <div className="text-meta text-ink2">
          <b className="text-brandink">Paid leave is a hard pin.</b> A pinned Leave day is always
          honored and never fills a shift&apos;s coverage. It carries no built-in hours credit — any
          credit toward contracted-hours totals comes from your configured contracted-hours rules.
          Weight is ignored for leave — it is a pin, not a weighted request.
        </div>
      </div>

      <RequestsMatrix
        rows={rows}
        columns={columns}
        people={people}
        historyCount={historyCount}
        historyLabels={historyLabels}
        reqData={reqData}
        shiftTypeOrderIndex={shiftTypeOrderIndex}
        mode={mode}
        stagedKeys={stagedKeys}
        onCellClick={openCellEditor}
        onHistoryClick={openHistoryEditor}
        onCellPointerDown={onCellPointerDown}
        onCellPointerEnter={onCellPointerEnter}
        onHistoryPointerDown={onHistoryPointerDown}
        onHistoryPointerEnter={onHistoryPointerEnter}
      />

      <div
        className="mt-3 flex items-center gap-2 text-meta text-ink3"
        data-testid="requests-footer"
      >
        <FaCircleInfo className="size-3" />
        {resolvedCells.length} requests ·{" "}
        {mode === "quick"
          ? "Quick paint — drag across cells to apply the configured preset."
          : "Edit cells — click a cell to set precise preferences."}
      </div>

      <div className="mt-5">
        <CurrentRequestsTable rows={currentRequestRows} />
      </div>
      <div className="mt-4">
        <CurrentHistoryTable people={currentHistoryPeople} />
      </div>

      {cellEditor && (
        <CellPreferenceEditor
          open
          personLabel={personLookup.get(cellEditor.person)?.label ?? String(cellEditor.person)}
          dateLabel={columnLookup.get(cellEditor.date)?.label ?? String(cellEditor.date)}
          cells={activeCellCells}
          targets={cellEditorTargets}
          onSave={(result) => commitCellEdit(cellEditor.person, cellEditor.date, result)}
          onClear={() => clearCell(cellEditor.person, cellEditor.date)}
          onClose={closeCellEditor}
        />
      )}

      {historyEditor && (
        <HistoryEditor
          open
          who={String(historyEditor.personId)}
          positionLabel={historyLabels[historyEditor.historyIndex] ?? ""}
          currentValue={activeHistoryValue}
          options={historyOptions}
          onSet={(value) => {
            // FR-SR-19: a selection saves AND closes.
            commitHistorySet(historyEditor.personId, historyEditor.historyIndex, value);
            closeHistoryEditor();
          }}
          onClear={() => {
            commitHistoryClear(historyEditor.personId, historyEditor.historyIndex);
            closeHistoryEditor();
          }}
          onClose={closeHistoryEditor}
        />
      )}

      <RequestsCsvModal
        open={csvOpen !== null}
        kind={csvOpen}
        onFileText={csvOpen === "requests" ? handleRequestsCsvFile : handleHistoryCsvFile}
        onClose={() => setCsvOpen(null)}
      />

      <ClearConfirmDialog
        open={confirm !== null}
        text={confirm?.text ?? ""}
        onConfirm={() => {
          confirm?.onConfirm();
          setConfirm(null);
        }}
        onCancel={() => setConfirm(null)}
      />
    </Surface>
  );
}
