"use client";

// Staffing Requirements editor (T12 M1 clone, spec 05). The orchestrator composes
// the shared ScreenCards chrome (eyebrow, display title, full subtitle, inline
// top-right Add), the persistent "exact constraints" info strip, the
// coverage-warning banner (FR-PR-28/40..42, shown above the form whenever there
// are undefined/duplicate `(date, shiftType)` pairs), the add/edit form, the list
// heading with a live rule count, the centred empty state (shown only with no
// cards AND no open draft), and the saved-card list. The store slice remains the
// single source of truth; the form is a transient draft that only touches state
// through the `useRequirements` operations (one tracked mutation each).

import { useLayoutEffect, useRef, useState } from "react";
import {
  CardEditorScreen,
  CardEditorHeader,
  CardEditorInfoStrip,
  CardEditorInstructions,
  CardListHeading,
  CardEditorEmptyState,
  useCardEditorDraftGuard,
  useCardEditorStaleGuard,
} from "@/components/card-editor/card-editor-shell";
import type { RequirementCard } from "@/lib/scenario";
import { FaTriangleExclamation } from "@/components/icons";
import { RequirementForm } from "./requirement-form";
import { RequirementCardList } from "./requirement-card-list";
import { useRequirements } from "./use-requirements";
import {
  buildRequirementShiftTypeDomain,
  computeCoverageWarnings,
  emptyRequirementForm,
  hasCoverageWarnings,
  requirementToForm,
  type RequirementFormState,
} from "./requirements-model";

type Draft =
  | { mode: "add"; uid: null; form: RequirementFormState }
  | { mode: "edit"; uid: string; form: RequirementFormState };

const EYEBROW = "CONSTRAINT · REQUIREMENTS";
const TITLE = "Staffing Requirements";
const SUBTITLE =
  "How many qualified people each shift type needs, per date. Set a preferred headcount above the required minimum to make extra staffing a soft goal.";
const ADD_LABEL = "Add Requirement";
const LIST_TITLE = "Current Requirements";
const EMPTY_MESSAGE = 'No requirements defined yet. Click "Add Requirement" to get started.';
const INSTRUCTIONS = [
  'Define requirements for specific shift types (e.g., "Night shifts need 3 senior nurses")',
  "Select one shift type or group that this requirement applies to",
  "Set the required number of people for each instance of the shift type",
  "Optionally specify which people or groups are qualified for this requirement",
  "Optionally set a preferred number of people when extra staffing is useful",
  "Optionally specify specific dates this requirement applies to",
  "Set weight only when the preferred number of people differs from the required number",
  "Navigate using the tabs or keyboard shortcuts (1, 2, etc.) to continue setup",
] as const;

function CoverageWarningBanner({
  warnings,
}: {
  warnings: ReturnType<typeof computeCoverageWarnings>;
}) {
  if (!hasCoverageWarnings(warnings)) return null;
  return (
    <div
      className="mb-1 border border-warn bg-warntint px-4 py-3.5"
      data-testid="requirement-coverage-warnings"
    >
      <div className="mb-1.5 flex items-center gap-2 text-body font-bold text-warn">
        <FaTriangleExclamation className="size-3.5" /> Requirement coverage warnings
      </div>
      {warnings.undefinedSection && (
        <div className="mb-2" data-testid="requirement-coverage-undefined">
          <p className="mb-1.5 text-meta text-ink2">{warnings.undefinedSection.message}</p>
          <ul className="m-0 flex flex-col gap-0.5 pl-5">
            {warnings.undefinedSection.items.map((item) => (
              <li key={item} className="font-mono text-label font-semibold text-warn">
                {item}
              </li>
            ))}
          </ul>
        </div>
      )}
      {warnings.duplicateSection && (
        <div data-testid="requirement-coverage-duplicate">
          <p className="mb-1.5 text-meta text-ink2">{warnings.duplicateSection.message}</p>
          <ul className="m-0 flex flex-col gap-0.5 pl-5">
            {warnings.duplicateSection.items.map((item, i) => (
              <li key={`${item}-${i}`} className="font-mono text-label font-semibold text-warn">
                {item}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function RequirementsEditor() {
  const {
    state,
    requirements,
    add,
    update,
    remove,
    duplicate,
    move,
    reorder,
    setDisabled,
    getCards,
  } = useRequirements();
  const [draft, setDraft] = useState<Draft | null>(null);
  // FR-PR-06: arm the shared open-draft navigation guard while a form is visible.
  useCardEditorDraftGuard(!!draft);
  const { isStale } = useCardEditorStaleGuard<RequirementCard>({
    cards: requirements,
    draftOpen: !!draft,
    readLiveCards: getCards,
    onStale: () => setDraft(null),
  });
  // FR-PR-07: starting an edit records the scroll offset (add does not) and scrolls
  // to the top; Save/Cancel of that edit restores the offset. The app shell scrolls
  // an inner `overflow-y-auto` container (not the window), so we operate on the
  // nearest scrollable ancestor of a top-of-screen sentinel. The restore MUST run
  // after the form has unmounted and layout has collapsed back.
  const topRef = useRef<HTMLDivElement>(null);
  const pendingRestore = useRef<{ el: HTMLElement | null; top: number } | null>(null);

  function scrollContainer(): HTMLElement | null {
    let el: HTMLElement | null = topRef.current?.parentElement ?? null;
    while (el) {
      const overflowY = getComputedStyle(el).overflowY;
      if (overflowY === "auto" || overflowY === "scroll") return el;
      el = el.parentElement;
    }
    return null;
  }

  useLayoutEffect(() => {
    if (draft !== null || pendingRestore.current === null) return;
    const { el, top } = pendingRestore.current;
    pendingRestore.current = null;
    if (el) el.scrollTo({ top, behavior: "instant" });
    else window.scrollTo({ top, behavior: "instant" });
  }, [draft]);

  function openAdd() {
    // The Add toggle also closes an open draft (spec 05 FR-PR-01/03). Add does not
    // save/restore scroll (FR-PR-07).
    setDraft(draft ? null : { mode: "add", uid: null, form: emptyRequirementForm() });
  }

  function openEdit(uid: string) {
    const card = requirements.find((c) => c.uid === uid);
    if (!card) return;
    const scroller = scrollContainer();
    if (pendingRestore.current === null) {
      pendingRestore.current = {
        el: scroller,
        top: scroller ? scroller.scrollTop : window.scrollY,
      };
    }
    if (scroller) scroller.scrollTo({ top: 0, behavior: "instant" });
    else window.scrollTo({ top: 0, behavior: "instant" });
    const domain = buildRequirementShiftTypeDomain(state);
    setDraft({ mode: "edit", uid, form: requirementToForm(card, domain) });
  }

  function save(form: RequirementFormState) {
    if (isStale()) {
      setDraft(null);
      return;
    }
    if (draft?.mode === "edit") update(draft.uid, form);
    else add(form);
    setDraft(null);
  }

  function cancel() {
    setDraft(null);
  }

  // List ops cancel any open draft first (spec 05 EDGE-PR-02).
  function withDraftDismissed(op: () => void) {
    setDraft(null);
    op();
  }

  const warnings = computeCoverageWarnings(state, requirements);

  return (
    <CardEditorScreen screen="Staffing Requirements">
      <div ref={topRef} aria-hidden className="sr-only" />
      <CardEditorHeader
        eyebrow={EYEBROW}
        title={TITLE}
        subtitle={SUBTITLE}
        addLabel={ADD_LABEL}
        formOpen={!!draft}
        onAdd={openAdd}
        instructions={<CardEditorInstructions items={INSTRUCTIONS} />}
      />
      <CardEditorInfoStrip />
      <CoverageWarningBanner warnings={warnings} />

      {draft && (
        <RequirementForm
          // Remount on target change so the form resets cleanly per draft.
          key={draft.uid ?? "add"}
          state={state}
          mode={draft.mode}
          initialForm={draft.form}
          onSave={save}
          onCancel={cancel}
        />
      )}

      <CardListHeading title={LIST_TITLE} count={requirements.length} />

      {requirements.length === 0 && !draft ? (
        <CardEditorEmptyState title={EMPTY_MESSAGE} addLabel={ADD_LABEL} onAdd={openAdd} />
      ) : requirements.length > 0 ? (
        <RequirementCardList
          requirements={requirements}
          onEdit={openEdit}
          onDuplicate={(uid) => withDraftDismissed(() => duplicate(uid))}
          onDelete={(uid) => withDraftDismissed(() => remove(uid))}
          onMove={(uid, direction) => withDraftDismissed(() => move(uid, direction))}
          onReorder={(fromUid, toUid, position) =>
            withDraftDismissed(() => reorder(fromUid, toUid, position))
          }
          onSetDisabled={(uid, value) => withDraftDismissed(() => setDisabled(uid, value))}
        />
      ) : null}
    </CardEditorScreen>
  );
}
