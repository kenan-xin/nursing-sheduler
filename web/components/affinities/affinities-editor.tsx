"use client";

// Shift Affinities editor (T12 M1 clone, spec 05). The orchestrator composes the
// shared ScreenCards chrome (eyebrow, display title, full subtitle, inline
// top-right Add), the persistent "exact constraints" info strip, the add/edit
// form, the list heading with a live rule count, the centred empty state (shown
// only with no cards AND no open draft), and the saved-card list. The store
// slice remains the single source of truth; the form is a transient draft that
// only touches state through the `useAffinities` operations (one tracked
// mutation each).

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
import type { AffinityCard } from "@/lib/scenario";
import { AffinityForm } from "./affinity-form";
import { AffinityCardList } from "./affinity-card-list";
import { useAffinities } from "./use-affinities";
import {
  affinityToForm,
  emptyAffinityForm,
  isEditableAffinityCard,
  type AffinityFormState,
} from "./affinities-model";

type Draft =
  | { mode: "add"; uid: null; form: AffinityFormState }
  | { mode: "edit"; uid: string; form: AffinityFormState };

const EYEBROW = "CONSTRAINT · AFFINITIES";
const TITLE = "Affinities";
const SUBTITLE =
  "Encourage or discourage groups of people working the same shift together. For enforced preceptor supervision, use Shift type coverings instead.";
const ADD_LABEL = "Add Affinity";
const LIST_TITLE = "Current Affinities";
const EMPTY_MESSAGE = 'No affinities defined yet. Click "Add Affinity" to get started.';
const INSTRUCTIONS = [
  "Define affinity preferences to encourage or discourage people working together",
  "Select the dates when this affinity rule applies",
  "Select the first group of people (People 1)",
  "Select the second group of people (People 2)",
  "Select which shift types this affinity applies to",
  "Set positive weight to encourage working together and negative weight to discourage it",
  "Navigate using the tabs or keyboard shortcuts (1, 2, etc.) to continue setup",
] as const;

export function AffinitiesEditor() {
  const {
    state,
    affinities,
    add,
    update,
    remove,
    duplicate,
    move,
    reorder,
    setDisabled,
    getCards,
  } = useAffinities();
  const [draft, setDraft] = useState<Draft | null>(null);
  // FR-PR-06: arm the shared open-draft navigation guard while a form is visible.
  useCardEditorDraftGuard("affinities", !!draft);
  const { isStale } = useCardEditorStaleGuard<AffinityCard>({
    cards: affinities,
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
    setDraft(draft ? null : { mode: "add", uid: null, form: emptyAffinityForm() });
  }

  function openEdit(uid: string) {
    const card = affinities.find((c) => c.uid === uid);
    // A multi-term "advanced" affinity (FR-PR-55a-style fallback) is never
    // openable here — the list omits its Edit button, so this is a defensive
    // guard against ever flattening+collapsing its selectors.
    if (!card || !isEditableAffinityCard(card)) return;
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
    setDraft({ mode: "edit", uid, form: affinityToForm(card) });
  }

  function save(form: AffinityFormState) {
    if (isStale()) {
      setDraft(null);
      return;
    }
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
    <CardEditorScreen screen="Shift Affinities">
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

      {draft && (
        <AffinityForm
          // Remount on target change so the form resets cleanly per draft.
          key={draft.uid ?? "add"}
          state={state}
          mode={draft.mode}
          initialForm={draft.form}
          onSave={save}
          onCancel={cancel}
        />
      )}

      <CardListHeading title={LIST_TITLE} count={affinities.length} />

      {affinities.length === 0 && !draft ? (
        <CardEditorEmptyState title={EMPTY_MESSAGE} addLabel={ADD_LABEL} onAdd={openAdd} />
      ) : affinities.length > 0 ? (
        <AffinityCardList
          affinities={affinities}
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
