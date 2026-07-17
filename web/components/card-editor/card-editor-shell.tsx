"use client";

// Shared card-editor shell — the design prototype's ScreenCards chrome
// (docs/design_prototype/ScreenCards.dc.html). It is the common frame every
// Advanced constraint editor mounts: an eyebrow/title/subtitle header with an
// inline top-right Add, the persistent "exact constraints" info strip, a
// brand-bordered add/edit form panel (tinted header · body · right-aligned
// footer), the list heading + rule count, the centred empty state, and the
// numbered saved-card frame with a labelled field grid and an action row.
//
// T13 (shift-type coverings) is the FIRST consumer; T12 (requirements /
// successions / counts / affinities) reuses the same pieces. Everything here is
// presentational and fully controlled — no store access, no domain logic.

import * as React from "react";
import { Button } from "@/components/ui/button";
import { FaPlus, FaXmark, FaCircleInfo, FaCheck, FaLock, FaGripVertical } from "@/components/icons";
import { useNavGuardStore } from "@/components/shell/nav-guard-store";
/** Outer screen wrapper — centred column wide enough for the 940px form body. */
export function CardEditorScreen({
  screen,
  children,
}: {
  screen: string;
  children: React.ReactNode;
}) {
  return (
    <div
      data-testid="screen"
      data-screen={screen}
      className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-5 py-8"
    >
      {children}
    </div>
  );
}

/**
 * Arm the shared open-draft navigation guard while a card-editor add/edit form is
 * visible (FR-PR-06). An open draft holds unsaved work that is not a durable
 * scenario mutation, so the dirty-only guard would let a sidebar click discard it
 * silently; this feeds the draft-open state into the shared guard so leaving
 * prompts. Every card editor (Counts seed + the R/S/A clones) calls this with its
 * own `!!draft`, and the effect clears the flag on unmount/close.
 */
export function useCardEditorDraftGuard(active: boolean): void {
  const setDraftOpen = useNavGuardStore((s) => s.setDraftOpen);
  React.useEffect(() => {
    setDraftOpen(active);
    return () => setDraftOpen(false);
  }, [active, setDraftOpen]);
}

/**
 * Stale-open-edit guard for the card-editor family — the analogue of the
 * entity-editor's proven `isStale` pattern (`entity-editor.tsx:227-256`). When a
 * draft OPENS we capture the cards-slice reference it was formed against (the
 * "form-open token"), held across rerenders. ONE synchronous predicate — `isStale`
 * — re-reads the LIVE store via `readLiveCards` and reports whether that slice has
 * changed since open (undo/redo temporal travel, or a T07/T06 cascade
 * rename/delete from elsewhere). It is consulted by BOTH the close-on-external
 * effect below AND every submit handler (callers run `if (isStale()) { close; return; }`
 * before committing), so "what closes the form" and "what blocks a stale Save"
 * are the same relevance condition.
 *
 * The token is captured SYNCHRONOUSLY on the closed⇄open transition during render
 * (the `wasOpen` ref trick, mirroring entity-editor) so it is in place before any
 * effect runs. Self-Save closes the draft in the same tick (caller clears
 * `draft` and the token clears on the next render's transition check), so the
 * close-on-external effect never fires for the form's own commit. List ops that
 * mutate the slice (duplicate/delete/reorder/move/setDisabled) all dismiss the
 * draft FIRST (`withDraftDismissed`), so they never trip their own guard.
 *
 * Store-agnostic by design: the shell owns the token + predicate + effect, the
 * caller supplies the live-slice reader (`readLiveCards`) and close callback
 * (`onStale`), so this file stays free of any scenario-store import.
 */
export function useCardEditorStaleGuard<TCard>({
  cards,
  draftOpen,
  readLiveCards,
  onStale,
}: {
  cards: readonly TCard[];
  draftOpen: boolean;
  /** Read the LIVE cards slice at call time (NOT a render snapshot). The token is
   *  a ref captured at open; staleness is a ref-identity change of the live slice. */
  readLiveCards: () => readonly TCard[];
  /** Invoked by the close-on-external effect once an open draft goes stale. */
  onStale: () => void;
}): { isStale: () => boolean } {
  const openToken = React.useRef<readonly TCard[] | null>(null);
  const wasOpen = React.useRef(false);
  // Capture/clear synchronously on the closed⇄open transition (survives rerenders).
  if (draftOpen !== wasOpen.current) {
    wasOpen.current = draftOpen;
    openToken.current = draftOpen ? cards : null;
  }

  const isStale = React.useCallback(() => {
    const token = openToken.current;
    if (token === null) return false;
    return readLiveCards() !== token;
  }, [readLiveCards]);

  // `onStale` is only ever called from the effect below; keep its latest ref so
  // the effect can stay dependency-free (runs every render, like entity-editor).
  const onStaleRef = React.useRef(onStale);
  onStaleRef.current = onStale;

  // Visible close-on-external: once the live slice has changed under an open
  // draft, close it. The synchronous `isStale` guard in each submit path is what
  // blocks a stale Save in the render→effect window; this effect is the visible
  // follow-up. Runs every render so any external/cascade change is caught.
  React.useEffect(() => {
    if (draftOpen && isStale()) onStaleRef.current();
  });

  return { isStale };
}

/** Eyebrow · title · subtitle, with the inline top-right Add that toggles to a
 *  cancel affordance while the form is open (ScreenCards.dc.html:11-26). When
 *  `instructions` is provided, a help toggle beside the title (FR-PR-02,
 *  `title="Toggle instructions"`) reveals the per-editor instructions panel —
 *  collapsed by default. */
export function CardEditorHeader({
  eyebrow,
  title,
  subtitle,
  addLabel,
  formOpen,
  onAdd,
  secondaryAction,
  instructions,
  helpLabel = "Help",
}: {
  eyebrow: string;
  title: string;
  subtitle: string;
  addLabel: string;
  formOpen: boolean;
  onAdd: () => void;
  /** Optional second entry action rendered beside the primary Add (e.g. Counts'
   *  "Add Contracted Hours"). Backward-compatible: editors that omit it are
   *  unchanged. `formOpen` toggles the button's icon like the primary one. */
  secondaryAction?: {
    label: string;
    formOpen: boolean;
    onAdd: () => void;
    testId?: string;
  };
  /** Optional per-editor instructions panel (FR-PR-02). When present, a help
   *  toggle is rendered beside the title; the panel is collapsed by default. */
  instructions?: React.ReactNode;
  helpLabel?: string;
}) {
  // Collapsed by default per FR-PR-02 / the ScreenCards prototype. The header
  // remounts per page, so local state is the right scope (no cross-editor leak).
  const [helpOpen, setHelpOpen] = React.useState(false);
  return (
    <>
      <div className="mb-1 flex flex-wrap items-end gap-4">
        <div className="min-w-[240px] flex-1">
          <div className="mb-2 text-label font-semibold uppercase tracking-[0.03em] text-brandink">
            {eyebrow}
          </div>
          <div className="mb-2 flex flex-wrap items-center gap-2.5">
            <h1 className="font-heading text-display font-extrabold leading-[1.05] tracking-[-0.02em]">
              {title}
            </h1>
            {instructions ? (
              <button
                type="button"
                title="Toggle instructions"
                aria-expanded={helpOpen}
                aria-controls="card-editor-instructions"
                data-testid="card-editor-help-toggle"
                onClick={() => setHelpOpen((v) => !v)}
                className="inline-flex h-8 items-center gap-1.5 border border-line bg-transparent px-2.5 text-meta font-semibold text-ink2 hover:bg-panel"
              >
                <FaCircleInfo className="size-3" /> {helpLabel}
              </button>
            ) : null}
          </div>
          <p className="m-0 max-w-[64ch] text-ink2">{subtitle}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <Button
            variant={formOpen ? "outline" : "default"}
            className="h-11 px-[18px]"
            data-testid="add-card-toggle"
            aria-expanded={formOpen}
            onClick={onAdd}
          >
            {formOpen ? <FaXmark /> : <FaPlus />} {addLabel}
          </Button>
          {secondaryAction ? (
            <Button
              variant={secondaryAction.formOpen ? "outline" : "default"}
              className="h-11 px-[18px]"
              data-testid={secondaryAction.testId ?? "add-secondary-toggle"}
              aria-expanded={secondaryAction.formOpen}
              onClick={secondaryAction.onAdd}
            >
              {secondaryAction.formOpen ? <FaXmark /> : <FaPlus />} {secondaryAction.label}
            </Button>
          ) : null}
        </div>
      </div>
      {instructions && helpOpen ? (
        <div
          id="card-editor-instructions"
          data-testid="card-editor-instructions"
          className="mb-1 border border-line bg-panel px-4 py-3.5"
        >
          {instructions}
        </div>
      ) : null}
    </>
  );
}

/** The verbatim bulleted instructions list shown inside the FR-PR-02 instructions
 *  panel. Items are rendered exactly as authored (no reflow), one `<li>` each. */
export function CardEditorInstructions({ items }: { items: readonly string[] }) {
  return (
    <ul className="m-0 flex flex-col gap-1 pl-5">
      {items.map((text, i) => (
        <li key={i} className="text-meta leading-[1.45] text-ink2">
          {text}
        </li>
      ))}
    </ul>
  );
}

/** The persistent shared strip explaining Advanced ↔ guided Rules equivalence. */
export function CardEditorInfoStrip() {
  return (
    <div className="mb-1 flex items-start gap-2.5 border border-line bg-panel px-3.5 py-3">
      <FaCircleInfo className="mt-0.5 flex-none text-ink3" />
      <div className="text-meta text-ink2">
        These are the exact constraints behind the plain-English <b>Rules</b>. Editing here gives
        you full control; the guided Rules screen is the friendly view of the same data.
      </div>
    </div>
  );
}

/** The brand-bordered add/edit panel: tinted heading, body, right-aligned footer. */
export function CardEditorForm({
  heading,
  submitLabel,
  onSubmit,
  onCancel,
  onKeyDown,
  children,
}: {
  heading: string;
  submitLabel: string;
  onSubmit: () => void;
  onCancel: () => void;
  onKeyDown?: (event: React.KeyboardEvent) => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="mb-2 border border-brand bg-surface"
      data-testid="card-editor-form"
      onKeyDown={onKeyDown}
    >
      <div className="border-b border-line2 bg-brandtint px-[18px] py-3.5">
        <div className="font-heading text-cardhead font-extrabold tracking-[-0.02em] text-brandink">
          {heading}
        </div>
      </div>
      <div className="flex max-w-[940px] flex-col gap-5 p-[18px] sm:px-7 sm:py-6">{children}</div>
      <div className="flex justify-end gap-2.5 border-t border-line2 px-[18px] py-3.5">
        <Button variant="outline" className="h-10 px-[18px]" onClick={onCancel}>
          Cancel
        </Button>
        <Button className="h-10 px-5" data-testid="card-editor-submit" onClick={onSubmit}>
          <FaCheck /> {submitLabel}
        </Button>
      </div>
    </div>
  );
}

/** The locked hard-rule note shown in place of a weight control (coverings). */
export function CardEditorHardRuleNote({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="flex max-w-[520px] items-start gap-2.5 border border-line bg-panel px-3.5 py-3"
      data-testid="card-editor-hard-note"
    >
      <FaLock className="mt-0.5 flex-none text-ink3" />
      <div className="text-meta text-ink2">{children}</div>
    </div>
  );
}

/** Uppercase list heading + `N RULE(S)` count (ScreenCards.dc.html:457-460). */
export function CardListHeading({ title, count }: { title: string; count: number }) {
  return (
    <div className="mb-1 flex items-center gap-2.5">
      <span className="text-label font-semibold uppercase tracking-[0.03em] text-ink2">
        {title}
      </span>
      <span className="font-mono text-label text-ink3" data-testid="card-list-count">
        {count} {count === 1 ? "RULE" : "RULES"}
      </span>
    </div>
  );
}

/** The centred dashed zero-data state with a glyph, copy, and a second Add CTA.
 *  `body` is optional so an editor can show the single verbatim FR-PR-10 empty
 *  message as the title without a redundant helper line. */
export function CardEditorEmptyState({
  title,
  body,
  addLabel,
  onAdd,
}: {
  title: string;
  body?: string;
  addLabel: string;
  onAdd: () => void;
}) {
  return (
    <div
      className="flex flex-col items-center gap-3.5 border-[1.5px] border-dashed border-line px-10 py-12 text-center"
      data-testid="card-editor-empty"
    >
      <div className="flex size-[54px] items-center justify-center border-[1.5px] border-dashed border-line text-2xl leading-none text-faint">
        ∅
      </div>
      <div className="flex flex-col items-center gap-1.5">
        <div className="font-heading text-title font-bold text-ink2">{title}</div>
        {body ? <div className="max-w-[44ch] text-meta text-ink3">{body}</div> : null}
      </div>
      <Button className="mt-0.5 h-10 px-[18px]" onClick={onAdd}>
        <FaPlus /> {addLabel}
      </Button>
    </div>
  );
}

/** Where a drop lands relative to the hovered card, decided by the pointer's
 *  vertical position vs the card's midpoint (FR-PR-12). */
export type DropPosition = "before" | "after";

/** One saved-card frame: numbered square, title + badges, field grid, action row.
 *  Optional `drag` props enable native HTML5 reorder (the shared card-list pattern
 *  from the entity editor); when `draggable` is true the numbered square shows a
 *  grip and the row gains the grab cursor.
 *
 *  `onDrop` receives the pointer-half `DropPosition` (FR-PR-12) — additive: a
 *  consumer that ignores the argument (e.g. Coverings) keeps its prior
 *  insert-at-index behavior unchanged. `accent="brand"` gives the card a brand
 *  border + 3px left rule (the Contracted Hours treatment); the default `"none"`
 *  is the neutral `border-line` every existing consumer already gets. */
export function CardListItem({
  index,
  title,
  badges,
  fields,
  actions,
  disabled,
  testId,
  draggable,
  accent = "none",
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  isDragging,
  isOver,
}: {
  index: number;
  title: React.ReactNode;
  badges?: React.ReactNode;
  fields: { label: string; value: React.ReactNode }[];
  actions: React.ReactNode;
  disabled?: boolean;
  testId?: string;
  draggable?: boolean;
  accent?: "none" | "brand";
  onDragStart?: () => void;
  onDragOver?: () => void;
  onDrop?: (position: DropPosition) => void;
  onDragEnd?: () => void;
  isDragging?: boolean;
  isOver?: boolean;
}) {
  return (
    <li
      draggable={draggable}
      onDragStart={draggable ? onDragStart : undefined}
      onDragOver={
        draggable
          ? (e) => {
              e.preventDefault();
              onDragOver?.();
            }
          : undefined
      }
      onDrop={
        draggable
          ? (e) => {
              e.preventDefault();
              // FR-PR-12: upper half of the hovered card ⇒ drop BEFORE it, lower
              // half ⇒ drop AFTER it. Computed from the pointer Y vs the card mid.
              const rect = e.currentTarget.getBoundingClientRect();
              const position: DropPosition =
                e.clientY < rect.top + rect.height / 2 ? "before" : "after";
              onDrop?.(position);
            }
          : undefined
      }
      onDragEnd={draggable ? onDragEnd : undefined}
      className={`border bg-surface p-5 ${
        disabled ? "opacity-55" : ""
      } ${draggable ? "cursor-grab" : ""} ${isDragging ? "opacity-50" : ""} ${
        isOver ? "shadow-[inset_0_2px_0_var(--color-brand)]" : ""
      } ${accent === "brand" ? "border-brand border-l-[3px]" : "border-line"}`}
      data-testid={testId}
      data-disabled={disabled ? "true" : undefined}
    >
      <div className="mb-4 flex items-center gap-3">
        <div
          className={`flex size-8 flex-none items-center justify-center border border-line2 bg-panel font-mono text-label-md font-semibold text-ink2 ${
            draggable ? "flex items-center gap-1" : ""
          }`}
        >
          {draggable && <FaGripVertical aria-hidden className="size-2.5 text-ink3" />}
          {index + 1}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="font-heading text-title font-extrabold leading-[1.15] tracking-[-0.01em]">
              {title}
            </span>
            {badges}
          </div>
        </div>
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(130px,1fr))] gap-px border border-line2 bg-line2">
        {fields.map((f) => (
          <div key={f.label} className="bg-surface px-[15px] py-3">
            <div className="mb-[7px] text-label font-semibold uppercase tracking-[0.03em] text-ink3">
              {f.label}
            </div>
            <div className="font-heading text-body font-bold leading-[1.25] tracking-[-0.005em]">
              {f.value}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3.5 flex flex-wrap items-center gap-1.5">{actions}</div>
    </li>
  );
}

/** A labelled action-row button for a saved card (Disable/Edit/Duplicate/Delete).
 *  `danger` gives the destructive red treatment (Delete). */
export function CardActionButton({
  icon,
  children,
  danger,
  onClick,
  testId,
  ariaLabel,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  danger?: boolean;
  onClick: () => void;
  testId?: string;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={ariaLabel}
      onClick={onClick}
      className={`inline-flex h-8 items-center gap-[7px] border border-line bg-transparent px-3 text-meta font-semibold ${
        danger ? "text-error hover:bg-errortint" : "text-ink hover:bg-panel"
      }`}
    >
      {icon} {children}
    </button>
  );
}
