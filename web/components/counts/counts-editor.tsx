"use client";

// Shift Counts editor (T12 seed, spec 05). The orchestrator composes the shared
// ScreenCards chrome (eyebrow, display title, full subtitle, inline top-right
// Add), the persistent "exact constraints" info strip, the add/edit form, the
// list heading with a live rule count, the centred empty state (shown only with
// no cards AND no open draft), and the saved-card list. The store slice remains
// the single source of truth; the form is a transient draft that only touches
// state through the `useCounts` operations (one tracked mutation each).
//
// M1 seed scope: this editor authors ONLY generic shift counts (the
// `OrdinaryCountCardBody` shape). There is deliberately no second "Add Contracted
// Hours" action, no policy toggle, and no refresh/guard/convert flow — those are
// M2. An imported contracted-hours or generic-array-fallback card still renders
// (read-only) in the list via `CountCardList`, and Edit is simply not offered for
// those shapes (so the scalar form is never opened on a card it cannot author).

import { useLayoutEffect, useRef, useState } from "react";
import {
  CardEditorScreen,
  CardEditorHeader,
  CardEditorInfoStrip,
  CardListHeading,
  CardEditorEmptyState,
  useCardEditorDraftGuard,
} from "@/components/card-editor/card-editor-shell";
import { CountForm } from "./count-form";
import { CountCardList } from "./count-card-list";
import { useCounts } from "./use-counts";
import {
  countToForm,
  buildCountShiftTypeDomain,
  emptyCountForm,
  isEditableCountCard,
  type CountFormState,
} from "./counts-model";

type Draft =
  | { mode: "add"; uid: null; form: CountFormState }
  | { mode: "edit"; uid: string; form: CountFormState };

const EYEBROW = "CONSTRAINT · SHIFT COUNTS";
const TITLE = "Shift Counts";
const SUBTITLE =
  "Targets for how many of a shift type each person works over a set of dates — including a monthly contracted-hours target, where each worked shift and paid-leave day contributes its coefficient. Positive weight encourages, negative discourages.";
const ADD_LABEL = "Add shift count";
const LIST_TITLE = "Current shift counts";
const EMPTY_TITLE = "No shift counts defined yet.";
const EMPTY_BODY = "Add your first shift count to define this constraint.";

export function CountsEditor() {
  const { state, counts, add, update, remove, duplicate, move, reorder, setDisabled } = useCounts();
  const [draft, setDraft] = useState<Draft | null>(null);
  // FR-PR-06: arm the shared open-draft navigation guard while a form is visible.
  useCardEditorDraftGuard(!!draft);
  // FR-PR-07: starting an edit records the scroll offset (add does not) and scrolls
  // to the top; Save/Cancel of that edit restores the offset. The app shell scrolls
  // an inner `overflow-y-auto` container (not the window), so we operate on the
  // nearest scrollable ancestor of a top-of-screen sentinel. The restore MUST run
  // after the form has unmounted and layout has collapsed back — doing it in the
  // synchronous click handler restores against the still-expanded layout and lands
  // short — so it is deferred to a `useLayoutEffect` keyed on the draft closing.
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

  // Restore the recorded offset once the edit form has been removed from the DOM
  // and the list layout has settled (post-commit, pre-paint). Only fires when a
  // restore is pending (edit-open recorded one) AND the draft is now closed.
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
    setDraft(draft ? null : { mode: "add", uid: null, form: emptyCountForm() });
  }

  function openEdit(uid: string) {
    const card = counts.find((c) => c.uid === uid);
    // A contracted-hours (M2) or unmarked generic-array (FR-PR-55a) card is never
    // openable here — the list omits its Edit button, so this is a defensive guard.
    if (!card || !isEditableCountCard(card)) return;
    // Record the pre-edit offset ONCE (an edit→edit switch keeps the original), then
    // scroll to the top so the form is in view. Restore happens on close.
    const scroller = scrollContainer();
    if (pendingRestore.current === null) {
      pendingRestore.current = {
        el: scroller,
        top: scroller ? scroller.scrollTop : window.scrollY,
      };
    }
    if (scroller) scroller.scrollTo({ top: 0, behavior: "instant" });
    else window.scrollTo({ top: 0, behavior: "instant" });
    const domain = buildCountShiftTypeDomain(state);
    setDraft({ mode: "edit", uid, form: countToForm(card, domain) });
  }

  function save(form: CountFormState) {
    // Closing the draft triggers the layout-effect restore (no synchronous restore —
    // the form must unmount first so the list collapses back to its edit-time height).
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

  return (
    <CardEditorScreen screen="Shift Counts">
      <div ref={topRef} aria-hidden className="sr-only" />
      <CardEditorHeader
        eyebrow={EYEBROW}
        title={TITLE}
        subtitle={SUBTITLE}
        addLabel={ADD_LABEL}
        formOpen={!!draft}
        onAdd={openAdd}
      />
      <CardEditorInfoStrip />

      {draft && (
        <CountForm
          // Remount on target change so the form resets cleanly per draft.
          key={draft.uid ?? "add"}
          state={state}
          mode={draft.mode}
          initialForm={draft.form}
          onSave={save}
          onCancel={cancel}
        />
      )}

      <CardListHeading title={LIST_TITLE} count={counts.length} />

      {counts.length === 0 && !draft ? (
        <CardEditorEmptyState
          title={EMPTY_TITLE}
          body={EMPTY_BODY}
          addLabel={ADD_LABEL}
          onAdd={openAdd}
        />
      ) : counts.length > 0 ? (
        <CountCardList
          counts={counts}
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
