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

import { useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { CountForm } from "./count-form";
import { ContractedForm } from "./contracted-form";
import { CountCardList } from "./count-card-list";
import { useCounts } from "./use-counts";
import {
  countToForm,
  buildCountShiftTypeDomain,
  emptyCountForm,
  isContractedHoursCard,
  isEditableCountCard,
  type CountFormState,
} from "./counts-model";
import {
  defaultContractedForm,
  toContractedForm,
  type ContractedFormState,
} from "./contracted-model";
import { convertContractedToGeneric, seedContractedFormFromGeneric } from "./convert-model";
import { findSavedUncreditedLeaveFindings, type CountCard } from "@/lib/scenario";

// A `kind` tag distinguishes the ordinary scalar draft from the guided
// contracted-hours draft so the right form renders and Save routes to the right
// store op. Each variant still carries the add/edit mode + uid.
type Draft =
  | { kind: "ordinary"; mode: "add"; uid: null; form: CountFormState }
  | { kind: "ordinary"; mode: "edit"; uid: string; form: CountFormState }
  | { kind: "contracted"; mode: "add"; uid: null; form: ContractedFormState }
  | { kind: "contracted"; mode: "edit"; uid: string; form: ContractedFormState };

const EYEBROW = "CONSTRAINT · SHIFT COUNTS";
const TITLE = "Shift Counts";
const SUBTITLE =
  "Targets for how many of a shift type each person works over a set of dates — including a monthly contracted-hours target, where each worked shift and paid-leave day contributes its coefficient. Positive weight encourages, negative discourages.";
const ADD_LABEL = "Add Shift Count";
const ADD_CONTRACTED_LABEL = "Add Contracted Hours";
const LIST_TITLE = "Current Shift Counts";
const EMPTY_MESSAGE =
  "No shift counts defined yet. Add a Shift Count or Contracted Hours rule to get started.";

// FR-PR-02 verbatim (spec 05 counts instructions).
const INSTRUCTIONS = [
  'Set up shift count rules for people (e.g., "Working shifts should be close to the average")',
  "Select one or more people that this constraint applies to",
  "Select which dates to count shifts for",
  "Select which shift types to count",
  "Choose a mathematical expression to evaluate (e.g., 'x >= T' means count should be at least the target)",
  "Set the numeric target value",
  "Set positive weight to encourage constraint matches and negative weight to discourage them",
  "Navigate using the tabs or keyboard shortcuts (1, 2, etc.) to continue setup",
] as const;

export function CountsEditor() {
  const {
    state,
    counts,
    add,
    update,
    addContracted,
    updateContracted,
    replaceCard,
    remove,
    duplicate,
    move,
    reorder,
    setDisabled,
    getCards,
  } = useCounts();
  const [draft, setDraft] = useState<Draft | null>(null);
  // The marked card whose convert-to-generic inline confirm panel is open. It is
  // mutually exclusive with an open form draft: opening one dismisses the other.
  const [convertToGenericUid, setConvertToGenericUid] = useState<string | null>(null);
  // FR-PR-06: arm the shared open-draft navigation guard while a form is visible.
  useCardEditorDraftGuard("counts", !!draft);
  // Stale-open-edit guard (the entity-editor `isStale` pattern, ported to the
  // card-editor family): a draft formed against a stale cards slice (undo/redo
  // temporal travel, or an external cascade) visibly closes, and its Submit is
  // blocked synchronously so a stale draft can never overwrite a newer card or
  // mint a spurious history entry.
  const { isStale } = useCardEditorStaleGuard<CountCard>({
    cards: counts,
    draftOpen: !!draft,
    readLiveCards: getCards,
    onStale: () => setDraft(null),
  });
  // FR-PR-07: starting an edit records the scroll offset (add does not) and scrolls
  // to the top; Save/Cancel of that edit restores the offset. The app shell scrolls
  // an inner `overflow-y-auto` container (not the window), so we operate on the
  // nearest scrollable ancestor of a top-of-screen sentinel. The restore MUST run
  // after the form has unmounted and layout has collapsed back — doing it in the
  // synchronous click handler restores against the still-expanded layout and lands
  // short — so it is deferred to a `useLayoutEffect` keyed on the draft closing.
  const topRef = useRef<HTMLDivElement>(null);
  const pendingRestore = useRef<{ el: HTMLElement | null; top: number } | null>(null);

  // qq0.23d saved-card guard: the set of marked-card uids whose current expansion
  // omits LEAVE while overlapping a leave pin. Recomputed FRESH from the live store
  // scenario (via the shared detector's saved adapter) on every scenario change and
  // joined by uid, so the "Leave not credited" badge follows a card through
  // reorder/duplicate and never rides a persisted count index.
  const leaveGuardUids = useMemo(() => {
    const findings = findSavedUncreditedLeaveFindings({
      staff: state.staff,
      staffGroups: state.staffGroups,
      shifts: state.shifts,
      shiftGroups: state.shiftGroups,
      rangeStart: state.rangeStart,
      rangeEnd: state.rangeEnd,
      dateGroups: state.dateGroups,
      reqData: state.reqData,
      counts,
    });
    return new Set(findings.keys());
  }, [state, counts]);

  // Bind the editor advisory + Add-LEAVE action to the source card's enablement
  // (qq0.23-UI critique P2): an "Add" draft is a new (enabled) contract; an edit/
  // convert draft inherits `!sourceCard.disabled`. A vanished source (mid-edit
  // replacement) resolves to `false`, so a disabled/absent contract shows no
  // advisory — matching the saved badge, which the same detector also suppresses.
  function contractedDraftEnabled(): boolean {
    if (draft?.kind !== "contracted") return false;
    if (draft.mode === "add") return true;
    const source = counts.find((card) => card.uid === draft.uid);
    return !!source && !source.disabled;
  }

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

  // The Add toggles also close an open draft (spec 05 FR-PR-01/03) and neither
  // records/restores scroll (FR-PR-07). Clicking a button whose own kind of form is
  // open closes it; clicking it while the OTHER kind is open switches to this kind.
  function openAdd() {
    setConvertToGenericUid(null);
    setDraft(
      draft?.kind === "ordinary"
        ? null
        : { kind: "ordinary", mode: "add", uid: null, form: emptyCountForm() },
    );
  }

  function openAddContracted() {
    setConvertToGenericUid(null);
    setDraft(
      draft?.kind === "contracted"
        ? null
        : { kind: "contracted", mode: "add", uid: null, form: defaultContractedForm(state) },
    );
  }

  // Record the pre-edit offset ONCE (an edit→edit switch keeps the original), then
  // scroll to the top so the just-opened form is in view. Restore happens on close.
  function scrollToFormTop() {
    const scroller = scrollContainer();
    if (pendingRestore.current === null) {
      pendingRestore.current = {
        el: scroller,
        top: scroller ? scroller.scrollTop : window.scrollY,
      };
    }
    if (scroller) scroller.scrollTo({ top: 0, behavior: "instant" });
    else window.scrollTo({ top: 0, behavior: "instant" });
  }

  function openEdit(uid: string) {
    const card = counts.find((c) => c.uid === uid);
    if (!card) return;
    // Resolve the draft BEFORE touching scroll state: an unmarked generic-array
    // (FR-PR-55a) card has no editor here (the list omits its Edit button — this is
    // a defensive guard), so it must not leave a dangling scroll-restore behind.
    const domain = buildCountShiftTypeDomain(state);
    let next: Draft | null = null;
    if (isContractedHoursCard(card)) {
      next = { kind: "contracted", mode: "edit", uid, form: toContractedForm(card, state) };
    } else if (isEditableCountCard(card)) {
      next = { kind: "ordinary", mode: "edit", uid, form: countToForm(card, domain) };
    }
    if (!next) return;
    setConvertToGenericUid(null);
    scrollToFormTop();
    setDraft(next);
  }

  // Convert a scalar generic count into a guided contracted draft, seeded from the
  // generic card (blank target). The draft opens in "edit" mode so Confirm routes
  // through `updateContracted` → replace-in-place (same uid + list index + markers),
  // one tracked mutation. Only a scalar editable count is eligible.
  function openConvertToContracted(uid: string) {
    const card = counts.find((c) => c.uid === uid);
    if (!card || !isEditableCountCard(card)) return;
    setConvertToGenericUid(null);
    scrollToFormTop();
    setDraft({
      kind: "contracted",
      mode: "edit",
      uid,
      form: seedContractedFormFromGeneric(card, state),
    });
  }

  // Convert-to-generic uses a minimal inline confirm panel (no form draft): opening
  // it dismisses any open draft, Confirm commits ONE replace-in-place mutation.
  function openConvertToGeneric(uid: string) {
    setDraft(null);
    setConvertToGenericUid(uid);
  }

  function confirmConvertToGeneric(uid: string) {
    const card = counts.find((c) => c.uid === uid);
    setConvertToGenericUid(null);
    if (!card || !isContractedHoursCard(card)) return;
    replaceCard(uid, convertContractedToGeneric(card));
  }

  // Synchronous stale-Save guard shared by both forms: if the cards slice changed
  // since this draft opened (temporal travel / external cascade), abort the write
  // entirely — no commit, no history entry — and let the close-on-external effect
  // dismiss the draft. Self-Save is never stale: drafts don't mutate the live slice.
  function saveOrdinary(form: CountFormState) {
    if (isStale()) {
      setDraft(null);
      return;
    }
    // Closing the draft triggers the layout-effect restore (no synchronous restore —
    // the form must unmount first so the list collapses back to its edit-time height).
    if (draft?.kind === "ordinary" && draft.mode === "edit") update(draft.uid, form);
    else add(form);
    setDraft(null);
  }

  function saveContracted(form: ContractedFormState) {
    if (isStale()) {
      setDraft(null);
      return;
    }
    if (draft?.kind === "contracted" && draft.mode === "edit") updateContracted(draft.uid, form);
    else addContracted(form);
    setDraft(null);
  }

  function cancel() {
    setDraft(null);
  }

  // List ops cancel any open draft (and any open convert confirm) first
  // (spec 05 EDGE-PR-02).
  function withDraftDismissed(op: () => void) {
    setDraft(null);
    setConvertToGenericUid(null);
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
        formOpen={draft?.kind === "ordinary"}
        onAdd={openAdd}
        secondaryAction={{
          label: ADD_CONTRACTED_LABEL,
          formOpen: draft?.kind === "contracted",
          onAdd: openAddContracted,
          testId: "add-contracted-toggle",
        }}
        instructions={<CardEditorInstructions items={INSTRUCTIONS} />}
      />
      <CardEditorInfoStrip />

      {draft?.kind === "ordinary" && (
        <CountForm
          // Remount on target change so the form resets cleanly per draft.
          key={`ordinary-${draft.uid ?? "add"}`}
          state={state}
          mode={draft.mode}
          initialForm={draft.form}
          onSave={saveOrdinary}
          onCancel={cancel}
        />
      )}

      {draft?.kind === "contracted" && (
        <ContractedForm
          key={`contracted-${draft.uid ?? "add"}`}
          state={state}
          mode={draft.mode}
          initialForm={draft.form}
          isEnabled={contractedDraftEnabled()}
          onSave={saveContracted}
          onCancel={cancel}
        />
      )}

      <CardListHeading title={LIST_TITLE} count={counts.length} />

      {counts.length === 0 && !draft ? (
        <CardEditorEmptyState title={EMPTY_MESSAGE} addLabel={ADD_LABEL} onAdd={openAdd} />
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
          onConvertToContracted={openConvertToContracted}
          onConvertToGeneric={openConvertToGeneric}
          convertToGenericUid={convertToGenericUid}
          onConfirmConvertToGeneric={confirmConvertToGeneric}
          onCancelConvertToGeneric={() => setConvertToGenericUid(null)}
          leaveGuardUids={leaveGuardUids}
        />
      ) : null}
    </CardEditorScreen>
  );
}
