"use client";

// Shift Successions editor (T12 M1 clone, spec 05). The orchestrator composes
// the shared ScreenCards chrome (eyebrow, display title, full subtitle, inline
// top-right Add), the persistent "exact constraints" info strip, the add/edit
// form, the list heading with a live rule count, the centred empty state (shown
// only with no cards AND no open draft), and the saved-card list. The store
// slice remains the single source of truth; the form is a transient draft that
// only touches state through the `useSuccessions` operations (one tracked
// mutation each). Mirrors `counts-editor.tsx`, including the edit scroll
// save/restore (FR-PR-07).

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
import type { SuccessionCard } from "@/lib/scenario";
import { SuccessionForm } from "./succession-form";
import { SuccessionCardList } from "./succession-card-list";
import { useSuccessions } from "./use-successions";
import {
  emptySuccessionForm,
  isEditableSuccessionCard,
  successionToForm,
  type SuccessionFormState,
} from "./successions-model";

type Draft =
  | { mode: "add"; uid: null; form: SuccessionFormState }
  | { mode: "edit"; uid: string; form: SuccessionFormState };

const EYEBROW = "CONSTRAINT · SUCCESSIONS";
const TITLE = "Shift Successions";
const SUBTITLE =
  "Encourage or forbid one shift type following another for the same person, across an ordered sequence of shift types. Positive weight encourages the pattern, negative discourages it.";
const ADD_LABEL = "Add Succession";
const LIST_TITLE = "Current Successions";
const EMPTY_MESSAGE = 'No successions defined yet. Click "Add Succession" to get started.';
const INSTRUCTIONS = [
  'Define shift type succession preferences (e.g., "Forbid Evening -> Day succession")',
  "Select one or more people or groups this preference applies to",
  "Define the pattern of shift types in succession (minimum 2 shift types required)",
  "Specify specific dates this succession applies to",
  "Set positive weight to encourage successions and negative weight to discourage them",
  "Navigate using the tabs or keyboard shortcuts (1, 2, etc.) to continue setup",
] as const;

export function SuccessionsEditor() {
  const {
    state,
    successions,
    add,
    update,
    remove,
    duplicate,
    move,
    reorder,
    setDisabled,
    getCards,
  } = useSuccessions();
  const [draft, setDraft] = useState<Draft | null>(null);
  // FR-PR-06: arm the shared open-draft navigation guard while a form is visible.
  useCardEditorDraftGuard(!!draft);
  const { isStale } = useCardEditorStaleGuard<SuccessionCard>({
    cards: successions,
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
    setDraft(draft ? null : { mode: "add", uid: null, form: emptySuccessionForm() });
  }

  function openEdit(uid: string) {
    const card = successions.find((c) => c.uid === uid);
    // An advanced (nested-aggregate) pattern is never openable here — the list
    // omits its Edit button, so this is a defensive guard against corrupting the
    // aggregate through `flattenPattern`/`buildSuccessionCard`.
    if (!card || !isEditableSuccessionCard(card)) return;
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
    setDraft({ mode: "edit", uid, form: successionToForm(card) });
  }

  function save(form: SuccessionFormState) {
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
    <CardEditorScreen screen="Shift Successions">
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
        <SuccessionForm
          // Remount on target change so the form resets cleanly per draft.
          key={draft.uid ?? "add"}
          state={state}
          mode={draft.mode}
          initialForm={draft.form}
          onSave={save}
          onCancel={cancel}
        />
      )}

      <CardListHeading title={LIST_TITLE} count={successions.length} />

      {successions.length === 0 && !draft ? (
        <CardEditorEmptyState title={EMPTY_MESSAGE} addLabel={ADD_LABEL} onAdd={openAdd} />
      ) : successions.length > 0 ? (
        <SuccessionCardList
          successions={successions}
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
