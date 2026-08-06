"use client";

// Shared card-editor shell — the design prototype's ScreenCards chrome
// (docs/design_prototype/source/ScreenCards.dc.html). It is the common frame every
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
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Surface, surfaceVariants } from "@/components/ui/surface";
import {
  FaPlus,
  FaXmark,
  FaCircleInfo,
  FaCheck,
  FaLock,
  FaGripVertical,
  FaChevronUp,
  FaChevronDown,
} from "@/components/icons";
import { useLosableDraft } from "@/components/shell/use-losable-draft";

/** Outer screen wrapper — the L0 app plane for every card editor, with the standard
 *  screen gap. It sets no width, margin or page padding: the app shell owns those
 *  for every screen at one place (`app-shell.tsx`, `max-w-[1240px]` — bmw.6). The
 *  940px cap that used to be justified here belongs to `CardEditorForm`'s body,
 *  which still carries it.
 *
 *  The `page` role is what the F4 matrix pins for all five routes: the screen root
 *  must RESOLVE `--bg` rather than inherit a transparent box, so the ladder starts
 *  from a real L0 plane instead of from whatever happens to be painted behind it. */
export function CardEditorScreen({
  screen,
  children,
}: {
  screen: string;
  children: React.ReactNode;
}) {
  return (
    <Surface
      level="page"
      geometry="square"
      data-testid="screen"
      data-screen={screen}
      className="flex flex-col gap-4"
    >
      {children}
    </Surface>
  );
}

/**
 * Register the shared losable-draft guard while a card-editor add/edit form is
 * visible (FR-PR-06). An open draft holds unsaved work that is not a durable
 * scenario mutation, so the dirty-only guard would let a sidebar click discard it
 * silently; this registers the draft under `kind` so leaving prompts. Every card
 * editor (Counts seed + the R/S/A clones) calls this with its own kind + `!!draft`.
 */
export function useCardEditorDraftGuard(kind: string, active: boolean): void {
  useLosableDraft(`card-editor:${kind}`, active, `${kind} editor`);
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
            {/* Display: Figtree 700 / 1.15 / -0.015em (DESIGN.md §3). v1 ran 800 at
                1.05 and -0.02em; v2 is deliberately one weight step lighter with a
                slightly opener line. Sizes, copy and wrapping are unchanged — only
                the weight/line-height/tracking recipe moves. */}
            <h1 className="font-heading text-display font-bold leading-[1.15] tracking-[-0.015em]">
              {title}
            </h1>
            {instructions ? (
              <Button
                variant="outline"
                size="sm"
                title="Toggle instructions"
                aria-expanded={helpOpen}
                aria-controls="card-editor-instructions"
                data-testid="card-editor-help-toggle"
                onClick={() => setHelpOpen((v) => !v)}
              >
                <FaCircleInfo /> {helpLabel}
              </Button>
            ) : null}
          </div>
          <p className="m-0 max-w-[64ch] text-ink2">{subtitle}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <Button
            variant={formOpen ? "outline" : "default"}
            size="lg"
            data-testid="add-card-toggle"
            aria-expanded={formOpen}
            onClick={onAdd}
          >
            {formOpen ? <FaXmark /> : <FaPlus />} {addLabel}
          </Button>
          {secondaryAction ? (
            <Button
              variant={secondaryAction.formOpen ? "outline" : "default"}
              size="lg"
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
        <Surface
          level="well"
          geometry="control"
          id="card-editor-instructions"
          data-testid="card-editor-instructions"
          className="mb-1 px-4 py-3.5"
        >
          {instructions}
        </Surface>
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

/** The persistent shared strip explaining Advanced ↔ guided Rules equivalence — an
 *  inset note strip, which DESIGN.md §4 puts on the `well` level rather than giving
 *  it a card's hairline-and-drop-shadow box. */
export function CardEditorInfoStrip() {
  return (
    <Surface level="well" geometry="control" className="mb-1 flex items-start gap-2.5 px-3.5 py-3">
      <FaCircleInfo className="mt-0.5 flex-none text-ink3" />
      <div className="text-meta text-ink2">
        These are the exact constraints behind the plain-English <b>Rules</b>. Editing here gives
        you full control; the guided Rules screen is the friendly view of the same data.
      </div>
    </Surface>
  );
}

/** The brand-bordered add/edit panel: tinted heading, body, right-aligned footer.
 *  An open draft IS the active editor card, so it takes the `selected` role — the
 *  `--brand` border and `--sh-2` lift DESIGN.md §4 reserves for exactly that. Both
 *  the tinted heading band and the footer are full-bleed and therefore square;
 *  `overflow-hidden` on the panel is what clips them to its card radius instead of
 *  leaving a sliver of page background in each corner. */
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
      className={cn(
        "mb-2 overflow-hidden",
        surfaceVariants({ role: "selected", geometry: "card" }),
      )}
      data-testid="card-editor-form"
      onKeyDown={onKeyDown}
    >
      <div className="border-b border-line2 bg-brandtint px-[18px] py-3.5">
        {/* Headline: Figtree 600 / 1.2 / -0.015em. The line-height is explicit
            because `--text-cardhead` carries a SIZE only — without it this div
            inherited the body's 1.5, which is a paragraph rhythm on a card header. */}
        <div className="font-heading text-cardhead font-semibold leading-[1.2] tracking-[-0.015em] text-brandink">
          {heading}
        </div>
      </div>
      {/* `.ns-formbody` — 18px, then 26/28px at 720px (source/Nurse Scheduling v2.dc.html:207-208).
          Both are the class's own literals, so they stay literal rather than stepping
          on the 0.9 scale; `px-7`/`py-6` resolved to 25.2/21.6px. The pivot is
          `formgrid:` (720px), the same breakpoint the grid INSIDE this body uses — it
          was `sm:` (640px), splitting 80px early. */}
      <div className="flex max-w-[940px] flex-col gap-5 p-[18px] formgrid:px-[28px] formgrid:py-[26px]">
        {children}
      </div>
      <div className="flex justify-end gap-2.5 border-t border-line2 px-[18px] py-3.5">
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button data-testid="card-editor-submit" onClick={onSubmit}>
          <FaCheck /> {submitLabel}
        </Button>
      </div>
    </div>
  );
}

/** The locked hard-rule note shown in place of a weight control (coverings) — an
 *  inset note strip on the `well` level, like the shared info strip. */
export function CardEditorHardRuleNote({ children }: { children: React.ReactNode }) {
  return (
    <Surface
      level="well"
      geometry="control"
      className="flex max-w-lg items-start gap-2.5 px-3.5 py-3"
      data-testid="card-editor-hard-note"
    >
      <FaLock className="mt-0.5 flex-none text-ink3" />
      <div className="text-meta text-ink2">{children}</div>
    </Surface>
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
    // Dashed is the zero-data affordance, so this keeps a hand-authored border
    // rather than the `surface` role's solid hairline (the same call the shared
    // entity-editor empty state makes). Radius still follows the card role.
    <div
      className="flex flex-col items-center gap-3.5 rounded-card border border-dashed border-line bg-surface px-10 py-12 text-center"
      data-testid="card-editor-empty"
    >
      <div className="flex size-[54px] items-center justify-center rounded-control border border-dashed border-line text-2xl leading-none text-faint">
        ∅
      </div>
      <div className="flex flex-col items-center gap-1.5">
        <div className="font-heading text-title font-bold text-ink2">{title}</div>
        {body ? <div className="max-w-[44ch] text-meta text-ink3">{body}</div> : null}
      </div>
      <Button className="mt-0.5" onClick={onAdd}>
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
 *  insert-at-index behavior unchanged.
 *
 *  Every visual state is a ROLE on the shared surface recipe rather than a local
 *  fork, which is also why none of them is spelled out in `className` here:
 *    • `accent="brand"` (the Contracted Hours treatment) is `selected` — the
 *      `--brand` border + `--sh-2` lift DESIGN.md §4 reserves for a marked card.
 *      The old hand-drawn 3px left rule is retired with it;
 *    • a drag candidate is `drop-target`, deliberately NOT `selected`, so "release
 *      here" and "this is the one" stay distinguishable;
 *    • a DISABLED card recedes to the `well` tone instead of the whole card being
 *      faded. `opacity` on a card dims its text along with everything else, which
 *      costs the contrast every label in it has to clear; tone-first is the v2
 *      answer, and the `Disabled` badge is the redundant signal beside it. */
export function CardListItem({
  index,
  title,
  badges,
  fields,
  actions,
  footer,
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
  /** Optional slot below the action row (e.g. an inline Convert confirm panel).
   *  Backward compatible: consumers that omit it render exactly as before. */
  footer?: React.ReactNode;
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
      className={cn(
        "p-5",
        surfaceVariants({
          role: isOver
            ? "drop-target"
            : disabled
              ? "well"
              : accent === "brand"
                ? "selected"
                : "surface",
          geometry: "card",
          interaction: isDragging ? "dragging" : draggable ? "grabbable" : undefined,
        }),
      )}
      data-testid={testId}
      data-disabled={disabled ? "true" : undefined}
      // Drag state is otherwise only an opacity class. Exposed so a test can wait
      // for React to have registered the drag instead of sleeping on a guess.
      data-dragging={isDragging ? "true" : undefined}
    >
      <div className="mb-4 flex items-center gap-3">
        <div
          className={`flex size-8 flex-none items-center justify-center rounded-chip border border-line2 bg-panel font-mono text-label-md font-semibold text-ink2 ${
            draggable ? "flex items-center gap-1" : ""
          }`}
        >
          {draggable && <FaGripVertical aria-hidden className="size-2.5 text-ink3" />}
          {index + 1}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2.5">
            {/* Title: Figtree 600 / 1.25 / -0.015em. v1 used 800 at -0.01em, which
                both over-weighted the card title against the page h1 and broke the
                Negative-Tracking Rule's single -0.015em value for heading faces. */}
            <span className="font-heading text-title font-semibold leading-[1.25] tracking-[-0.015em]">
              {title}
            </span>
            {badges}
          </div>
        </div>
      </div>
      {/* A field grid is a data surface: hairline seams, flush cells, and
          explicitly square corners (DESIGN.md §5 — don't round data structure). */}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(130px,1fr))] gap-px rounded-none border border-line2 bg-line2">
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
      {footer}
    </li>
  );
}

/** A labelled action-row button for a saved card (Disable/Edit/Duplicate/Delete),
 *  on the shared `Button` contract so it inherits the pill shape, the L1 fill
 *  DESIGN.md §4 rule 4 requires of a non-primary action, and a real 44x44 target on
 *  a coarse pointer instead of a 32px-tall hand-rolled box.
 *  `danger` gives the destructive outline treatment (Delete). `disabled` renders a
 *  non-interactive treatment; `disabledReason` (e.g. an advanced-array card whose
 *  Convert is YAML-gated) is then shown as PERSISTENT adjacent text — a native
 *  `disabled` button is unfocusable, so a `title`-only reason is invisible to
 *  keyboard and screen-reader users. The reason is also wired via `aria-describedby`
 *  and kept as the `title`. Backward compatible: consumers that omit it are unchanged. */
export function CardActionButton({
  icon,
  children,
  danger,
  onClick,
  testId,
  ariaLabel,
  disabled,
  disabledReason,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  danger?: boolean;
  onClick: () => void;
  testId?: string;
  ariaLabel?: string;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const showReason = Boolean(disabled && disabledReason);
  const reasonId = showReason && testId ? `${testId}-reason` : undefined;
  const button = (
    <Button
      variant={danger ? "destructive-outline" : "outline"}
      size="sm"
      data-testid={testId}
      aria-label={ariaLabel}
      title={disabled ? disabledReason : undefined}
      disabled={disabled}
      aria-disabled={disabled || undefined}
      aria-describedby={reasonId}
      onClick={onClick}
    >
      {icon} {children}
    </Button>
  );
  if (!showReason) return button;
  return (
    <span className="inline-flex items-center gap-2">
      {button}
      <span id={reasonId} className="text-meta italic text-ink3" data-testid={reasonId}>
        {disabledReason}
      </span>
    </span>
  );
}

/** The KEYBOARD half of the shared card-list reorder, for the action row of a
 *  `draggable` `CardListItem`.
 *
 *  Native HTML5 drag has no keyboard equivalent, so a card list whose only
 *  reorder path is `onDrop` is unusable without a pointer. This is the same
 *  drag + Up/Down pairing `people-table` and `shift-type-grid` already ship, kept
 *  in ONE place so all five card editors cannot drift apart on it.
 *
 *  It drives the SAME `onReorder(from, to, position)` the drop handler does —
 *  "up" is `before` the previous card, "down" is `after` the next one — so a
 *  keyboard move and a drag are byte-identical commits (one undo entry), and no
 *  consumer needs a second index-swapping mutation on its controller. Both ends
 *  are `disabled` rather than silently no-op, so the boundary is visible. */
export function CardMoveActions<TCard extends { uid: string }>({
  cards,
  index,
  onReorder,
  testIdPrefix,
  subject,
}: {
  /** The rendered list, in current order. */
  cards: readonly TCard[];
  index: number;
  onReorder: (fromUid: string, toUid: string, position: DropPosition) => void;
  /** Card-kind test-id prefix, e.g. `"count"` ⇒ `count-up-0` / `count-down-0`. */
  testIdPrefix: string;
  /** Singular noun for the accessible name, e.g. `"shift count"`. */
  subject: string;
}) {
  const card = cards[index];
  const previous = cards[index - 1];
  const next = cards[index + 1];
  return (
    <>
      <CardActionButton
        icon={<FaChevronUp className="size-3" />}
        onClick={() => previous && onReorder(card.uid, previous.uid, "before")}
        testId={`${testIdPrefix}-up-${index}`}
        ariaLabel={`Move ${subject} up`}
        disabled={previous === undefined}
      >
        Up
      </CardActionButton>
      <CardActionButton
        icon={<FaChevronDown className="size-3" />}
        onClick={() => next && onReorder(card.uid, next.uid, "after")}
        testId={`${testIdPrefix}-down-${index}`}
        ariaLabel={`Move ${subject} down`}
        disabled={next === undefined}
      >
        Down
      </CardActionButton>
    </>
  );
}
