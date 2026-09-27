"use client";

// Staff screen — "Temporary cover" section (d582, spec §6). The THIRD card on
// `/people`, below Staff groups: an L1 `Surface` with a header band (title, one-line
// description, secondary `+ Cover` button) over a square table — the prototype's
// section pattern (ScreenStaff.dc.html:116-135, the same markup the Staff groups card
// uses).
//
// A cover is a named nurse from another ward covering ONE shift on ONE date. She is
// never a solver person (spec §2): `lib/scenario/temporary-cover.ts` owns the
// arithmetic and this section only displays it. The Effect cell states what she
// lowers (`N on 14 Oct: 3 → 2 (All nurses)`) or, when she lowers nothing, the F1–F4
// warning. Name and group ids are arbitrary user text, so they truncate with an
// ellipsis and expose the full value on hover.
//
// Store discipline: Save and Delete are each ONE `scenarioCommands.mutate` — one undo
// entry. Validation lives in the pure module (`validateCover`), shared with the
// assistant host (Task 16). After Save or Delete, when a working roster exists, an
// info `Callout` offers `Run Optimize`, which only OPENS Optimize — it never starts a
// run (F8).

import * as React from "react";
import { useShallow } from "zustand/react/shallow";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { surfaceVariants } from "@/components/ui/surface";
import { Callout } from "@/components/optimize/callout";
import { GuardedLink } from "@/components/shell/guarded-link";
import { useLosableDraft } from "@/components/shell/use-losable-draft";
import { navRoutePath } from "@/components/shell/nav-route-paths";
import { cn } from "@/lib/utils";
import { formatShortDate } from "@/lib/dates/date-id";
import { isDayStateSelector, type ScenarioUiState, type UiTemporaryCover } from "@/lib/scenario";
import type { RosterDocument } from "@/lib/roster";
import { rosterStorage, scenarioCommands, useScenarioStore } from "@/lib/store";
import { changeKeys } from "@/lib/change-highlight/keys";
import { useChangeTarget } from "@/lib/change-highlight/store";
import {
  cardNeedOn,
  coverCardsOf,
  coverInputFrom,
  coverSlicesOf,
  coverStatuses,
  validateCover,
  type CoverFlag,
} from "@/lib/scenario/temporary-cover";
import { FaCheck, FaPen, FaPlus, FaTrash, FaXmark } from "@/components/icons";

const FLAG_TEXT: Record<CoverFlag, string> = {
  "out-of-period": "Outside the roster period",
  "unknown-shift": "Shift no longer exists",
  "unknown-group": "Group no longer exists",
  "no-card": "No rule she counts in",
};

type Editor = {
  /** Index into `state.temporaryCover`, or null when adding. */
  index: number | null;
  name: string;
  date: string;
  shiftType: string;
  groups: string[];
};

/** A transient "the roster should be re-planned" notice (F8). */
type Notice = { shiftLabel: string; iso: string; need: number; name: string };

/** The shift's display label: its description, else its id. */
function shiftLabelOf(state: Pick<ScenarioUiState, "shifts">, shiftType: string): string {
  const shift = state.shifts.find((candidate) => String(candidate.id) === shiftType);
  return shift?.description?.trim() || shiftType;
}

/** Whether a working roster exists (a plain DB read; failure degrades to "no"). */
async function workingRosterPresent(): Promise<boolean> {
  try {
    return (await rosterStorage.readWorking<RosterDocument>()) !== null;
  } catch {
    return false;
  }
}

export function TemporaryCoverSection() {
  // Two narrow subscriptions (see `coverSlicesOf`): a change to a card kind the
  // cover maths never reads must not re-render this section.
  const slices = useScenarioStore(useShallow(coverSlicesOf));
  const requirements = useScenarioStore(coverCardsOf);
  const state = coverInputFrom(slices, requirements);
  const statuses = coverStatuses(state);

  const [editor, setEditor] = React.useState<Editor | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<Notice | null>(null);

  useLosableDraft("temporary-cover", editor !== null, "Temporary cover");

  const workedShifts = state.shifts.filter((shift) => !isDayStateSelector(String(shift.id)));
  const rows = state.temporaryCover
    .map((cover, index) => ({ cover, index }))
    .sort((a, b) => (a.cover.date < b.cover.date ? -1 : a.cover.date > b.cover.date ? 1 : 0));

  /** The notice only means something when there is a roster to re-plan (F8). */
  const showNotice = (candidate: Notice | null) => {
    void (async () => setNotice((await workingRosterPresent()) ? candidate : null))();
  };

  const openAdd = () => {
    setError(null);
    setNotice(null);
    setEditor({
      index: null,
      name: "",
      date: state.rangeStart,
      shiftType: workedShifts.length > 0 ? String(workedShifts[0].id) : "",
      groups: [],
    });
  };

  const openEdit = (index: number, cover: UiTemporaryCover) => {
    setError(null);
    setNotice(null);
    setEditor({
      index,
      name: cover.name,
      date: cover.date,
      shiftType: String(cover.shiftType),
      groups: cover.groups.map(String),
    });
  };

  const closeEditor = () => {
    setEditor(null);
    setError(null);
  };

  const save = () => {
    if (!editor) return;
    const entry: UiTemporaryCover = {
      name: editor.name.trim(),
      date: editor.date,
      shiftType: editor.shiftType,
      groups: editor.groups,
    };
    const check = validateCover(state, entry, editor.index ?? undefined);
    if (!check.ok) {
      setError(check.message);
      return;
    }
    const at = editor.index;
    const next = [...state.temporaryCover];
    const target = at ?? next.length;
    if (at === null) next.push(entry);
    else next[at] = entry;
    // The Effect cell's own number, read off the post-save state, is exactly what the
    // notice states — so the two can never disagree.
    const effect = coverStatuses({ ...state, temporaryCover: next })[target]?.effects[0];
    void scenarioCommands.mutate(() => ({ temporaryCover: next }));
    closeEditor();
    showNotice(
      effect
        ? {
            shiftLabel: shiftLabelOf(state, entry.shiftType),
            iso: entry.date,
            need: effect.after,
            name: entry.name,
          }
        : null,
    );
  };

  const remove = (index: number, cover: UiTemporaryCover) => {
    const shiftId = String(cover.shiftType);
    const cardUid = statuses[index]?.effects[0]?.cardUid;
    const remaining = state.temporaryCover.filter((_, i) => i !== index);
    const card = cardUid
      ? state.cardsByKind.requirements.find((candidate) => candidate.uid === cardUid)
      : undefined;
    // The removed cover is gone from the post-delete slice, so the need she was
    // carrying has to be read off that slice.
    const need = card
      ? cardNeedOn({ ...state, temporaryCover: remaining }, card, cover.date, shiftId).required
      : null;
    void scenarioCommands.mutate(() => ({ temporaryCover: remaining }));
    closeEditor();
    showNotice(
      need === null
        ? null
        : {
            shiftLabel: shiftLabelOf(state, shiftId),
            iso: cover.date,
            need,
            name: cover.name,
          },
    );
  };

  return (
    <section
      data-testid="temporary-cover-section"
      className={cn("flex flex-col", surfaceVariants({ role: "surface", geometry: "card" }))}
    >
      {/* Head band — one bottom edge, so it stays square inside the rounded card. */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line2 px-5 py-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="font-heading text-cardhead font-semibold tracking-[-0.015em] text-ink">
            Temporary cover
          </h2>
          <p className="max-w-[60ch] text-meta text-ink2">
            Nurses from another ward for single shifts. Each one lowers that shift&rsquo;s staffing
            need by one.
          </p>
        </div>
        <Button
          variant="secondary"
          aria-pressed={editor !== null}
          data-testid="temporary-cover-add"
          onClick={() => (editor ? closeEditor() : openAdd())}
        >
          <FaPlus aria-hidden />
          Cover
        </Button>
      </div>

      <div className="flex flex-col gap-3.5 px-5 py-4">
        {editor !== null && (
          <div
            data-testid="temporary-cover-editor"
            className={cn(
              "flex flex-col gap-3 p-4",
              surfaceVariants({ role: "selected", geometry: "card" }),
            )}
          >
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex min-w-[200px] flex-col gap-1.5">
                <Label htmlFor="temporary-cover-name">Name</Label>
                <Input
                  id="temporary-cover-name"
                  data-testid="temporary-cover-name"
                  value={editor.name}
                  autoFocus
                  placeholder="Nurse name"
                  onChange={(e) => setEditor({ ...editor, name: e.target.value })}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="temporary-cover-date">Date</Label>
                {/* A native date input, bounded to the period (spec §6). */}
                <Input
                  id="temporary-cover-date"
                  data-testid="temporary-cover-date"
                  type="date"
                  min={state.rangeStart}
                  max={state.rangeEnd}
                  value={editor.date}
                  onChange={(e) => setEditor({ ...editor, date: e.target.value })}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="temporary-cover-shift">Shift</Label>
                {/* Worked shifts only — a cover on OFF or LEAVE is not a cover. */}
                <Select
                  id="temporary-cover-shift"
                  data-testid="temporary-cover-shift"
                  value={editor.shiftType}
                  onChange={(e) => setEditor({ ...editor, shiftType: e.target.value })}
                >
                  {workedShifts.length === 0 && <option value="">No shifts yet</option>}
                  {workedShifts.map((shift) => (
                    <option key={String(shift.id)} value={String(shift.id)}>
                      {shift.description?.trim() || String(shift.id)}
                    </option>
                  ))}
                </Select>
              </div>
            </div>

            {/* The same group toggles the ward staff rows use, none selected by default. */}
            {state.staffGroups.length > 0 && (
              <div
                role="group"
                aria-label="Groups she counts as"
                className="flex flex-wrap gap-1.5"
                data-testid="temporary-cover-group-toggles"
              >
                {state.staffGroups.map((group) => {
                  const id = String(group.id);
                  const on = editor.groups.includes(id);
                  return (
                    <Button
                      key={id}
                      size="sm"
                      variant={on ? "default" : "secondary"}
                      data-testid={`temporary-cover-group-${id}`}
                      aria-pressed={on}
                      onClick={() =>
                        setEditor({
                          ...editor,
                          groups: on
                            ? editor.groups.filter((candidate) => candidate !== id)
                            : [...editor.groups, id],
                        })
                      }
                    >
                      {/* Group ids are arbitrary user text: truncate, full value on hover. */}
                      <span className="max-w-[160px] truncate" title={id}>
                        {id}
                      </span>
                    </Button>
                  );
                })}
              </div>
            )}

            <p className="text-label text-ink3">
              She counts on rules open to everyone, and on rules for a group she is in.
            </p>

            {error !== null && (
              <div
                role="alert"
                data-testid="temporary-cover-error"
                className="text-label font-semibold text-errorink"
              >
                {error}
              </div>
            )}

            <div className="flex items-center gap-1.5">
              <Button data-testid="temporary-cover-save" onClick={save}>
                <FaCheck aria-hidden />
                Save
              </Button>
              <Button
                size="icon"
                variant="outline"
                aria-label="Cancel"
                data-testid="temporary-cover-cancel"
                onClick={closeEditor}
              >
                <FaXmark aria-hidden />
              </Button>
            </div>
          </div>
        )}

        {notice !== null && (
          <Callout
            tone="info"
            data-testid="temporary-cover-callout"
            actions={
              <GuardedLink
                href={navRoutePath("optimize-and-export")}
                data-testid="temporary-cover-run-optimize"
                className={cn(buttonVariants({ size: "sm" }), "font-bold")}
              >
                Run Optimize
              </GuardedLink>
            }
          >
            {`${notice.shiftLabel} on ${formatShortDate(notice.iso)} now needs ${notice.need} from the ward. Run Optimize again so the roster plans around ${notice.name}.`}
          </Callout>
        )}

        {rows.length === 0 ? (
          editor === null && (
            <div
              data-testid="temporary-cover-empty"
              className="flex flex-col items-center gap-3 border border-dashed border-line2 px-5 py-8 text-center"
            >
              <div className="flex size-11 items-center justify-center border border-dashed border-line2 text-title text-ink3">
                ∅
              </div>
              <div className="flex flex-col items-center gap-1">
                <div className="font-heading text-title font-semibold tracking-[-0.015em] text-ink2">
                  No temporary cover
                </div>
                <p className="max-w-[44ch] text-meta text-ink3">
                  Add a nurse from another ward for a shift they will work.
                </p>
              </div>
            </div>
          )
        ) : (
          // Clips to the card radius (DESIGN.md §4 rule 3); everything inside stays square.
          <div className="w-full overflow-x-auto">
            <table
              data-testid="temporary-cover-table"
              className="w-full min-w-[620px] border-collapse"
            >
              <caption className="sr-only">
                Temporary cover — nurses from another ward for single shifts, the shift they cover,
                and their effect on the staffing need.
              </caption>
              <thead>
                <tr className={surfaceVariants({ role: "band", geometry: "square" })}>
                  {["Name", "Shift", "Date", "Groups", "Effect"].map((label) => (
                    <th
                      key={label}
                      scope="col"
                      className="px-3 py-2.5 text-left text-label font-semibold uppercase tracking-[0.03em] text-ink2"
                    >
                      {label}
                    </th>
                  ))}
                  <th
                    scope="col"
                    className="w-[110px] px-3 py-2.5 text-right text-label font-semibold uppercase tracking-[0.03em] text-ink2"
                  >
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ cover, index }) => (
                  <CoverRow
                    key={`${cover.name}|${cover.date}|${cover.shiftType}`}
                    cover={cover}
                    index={index}
                    status={statuses[index]}
                    onEdit={() => openEdit(index, cover)}
                    onDelete={() => remove(index, cover)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

function CoverRow({
  cover,
  index,
  status,
  onEdit,
  onDelete,
}: {
  cover: UiTemporaryCover;
  index: number;
  status: ReturnType<typeof coverStatuses>[number] | undefined;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const name = cover.name;
  const shiftId = String(cover.shiftType);
  const changeTarget = useChangeTarget(changeKeys.cover(name, cover.date, shiftId));
  const effects = status?.effects ?? [];
  const restricted = status?.restrictedBy ?? [];
  const extra = status?.extra ?? 0;
  const flag = status?.flag ?? null;
  // A restricted cover lowers nothing, so `coverStatuses` gives it the generic
  // `no-card` flag; the restriction is the useful reason and takes its place.
  const flagBadge = flag !== null && !(flag === "no-card" && restricted.length > 0);

  return (
    <tr
      data-testid={`temporary-cover-row-${index}`}
      {...changeTarget}
      className="border-b border-line2 last:border-b-0"
    >
      <td className="px-3 py-2.5 align-top">
        {/* User-entered, so it truncates and shows the whole value on hover. */}
        <span className="block max-w-[220px] truncate font-semibold" title={name}>
          {name}
        </span>
      </td>
      <td className="px-3 py-2.5 align-top">
        <span className="block max-w-[120px] truncate font-mono text-meta" title={shiftId}>
          {shiftId}
        </span>
      </td>
      <td className="px-3 py-2.5 align-top whitespace-nowrap">{formatShortDate(cover.date)}</td>
      <td className="px-3 py-2.5 align-top">
        {cover.groups.length > 0 ? (
          <div className="flex flex-wrap gap-1.5" data-testid={`temporary-cover-groups-${index}`}>
            {cover.groups.map((group) => {
              const id = String(group);
              return (
                <Badge key={id} variant="neutral" casing="normal">
                  <span className="max-w-[140px] truncate" title={id}>
                    {id}
                  </span>
                </Badge>
              );
            })}
          </div>
        ) : (
          <span className="text-meta text-ink3">—</span>
        )}
      </td>
      <td className="px-3 py-2.5 align-top">
        <div className="flex flex-col gap-1">
          {effects.map((effect) => (
            <span key={effect.cardUid} data-testid={`temporary-cover-effect-${index}`}>
              {`${effect.shiftId} on ${formatShortDate(effect.iso)}: ${effect.before} → ${effect.after} (${effect.label})`}
            </span>
          ))}
          {flagBadge && (
            <Badge variant="warn" data-testid={`temporary-cover-flag-${index}`}>
              {FLAG_TEXT[flag]}
            </Badge>
          )}
          {restricted.map((rule) => (
            <span
              key={rule.cardUid}
              data-testid={`temporary-cover-restricted-${index}`}
              className="text-warnink"
            >
              {`Under ${rule.label}, only ${rule.group} work ${shiftId}. ${name} is not in ${rule.group}.`}
            </span>
          ))}
          {extra > 0 && effects.length > 0 && (
            <span data-testid={`temporary-cover-extra-${index}`} className="text-warnink">
              {`${effects[0].before + extra} covers are booked, so ${extra} ${extra === 1 ? "is" : "are"} extra.`}
            </span>
          )}
        </div>
      </td>
      <td className="px-3 py-2 text-right align-top">
        <div className="inline-flex items-center gap-1.5">
          <Button
            size="icon"
            variant="outline"
            aria-label={`Edit ${name}`}
            data-testid={`temporary-cover-edit-${index}`}
            onClick={onEdit}
          >
            <FaPen aria-hidden />
          </Button>
          <Button
            size="icon"
            variant="destructive-outline"
            aria-label={`Delete ${name}`}
            data-testid={`temporary-cover-delete-${index}`}
            onClick={onDelete}
          >
            <FaTrash aria-hidden />
          </Button>
        </div>
      </td>
    </tr>
  );
}
