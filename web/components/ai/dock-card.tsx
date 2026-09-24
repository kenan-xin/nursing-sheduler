"use client";

// The one card shape in the dock above the composer (`assistant-card-dock.tsx`).
// A question and a decision read the same way: a heading, numbered answer rows, and a
// last row the user can type into. Up/Down move between rows, Enter picks the focused
// one (it is a real button), 1-9 pick directly, and Esc hands focus back to the
// composer. Nothing here knows what a pick means; each card passes its own handlers.

import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { FaCheck, FaPen, FaXmark } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Surface } from "@/components/ui/surface";
import { cn } from "@/lib/utils";

/** What the dock gives its cards. No-ops outside the dock. */
export interface DockServices {
  /** Puts focus back in the composer. */
  focusComposer: () => void;
  /** Says a new card (or pager step) out loud to screen readers. */
  announce: (text: string) => void;
}

export const DockServicesContext = createContext<DockServices>({
  focusComposer: () => {},
  announce: () => {},
});

export interface DockOption {
  label: string;
  detail?: string | null;
  /** The one row that changes something: its marker is filled. */
  primary?: boolean;
  disabled?: boolean;
  /** Single-choice rows only; a multi-select row toggles instead. */
  onPick?: () => void;
  testId?: string;
}

/** The typed last row: its placeholder is also its accessible name. */
export interface DockOther {
  label: string;
  /** The Send button's accessible name; the visible text is just "Send". */
  sendLabel: string;
  disabled: boolean;
  onSend: (text: string) => void;
}

export interface DockCardProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  title: ReactNode;
  /** A small line above the title (a step label). */
  eyebrow?: ReactNode;
  /** Beside the title: a pager, badges. */
  aside?: ReactNode;
  /** Shows the close (x) control. Esc does the same, then returns to the composer. */
  onClose?: () => void;
  closeLabel?: string;
  options?: readonly DockOption[];
  /** Rows become checkboxes; the last row's Send sends them in option order. */
  multiple?: { disabled: boolean; onSend: (picked: readonly number[], other: string) => void };
  other?: DockOther | null;
  /** A Skip button on the empty last row. */
  onSkip?: () => void;
  /** Names the rows as one group ("Your decision"). */
  rowsLabel?: string;
  /**
   * Take focus when the card appears. Focus goes to the card itself, with no row
   * picked, and moves to the `focusRow` option once that row is usable -- unless the
   * user has put focus somewhere else in the meantime.
   */
  autoFocus?: boolean;
  /**
   * The option that takes focus by default. Only a row that is safe to pick by
   * reflex: the primary action, or the first answer to a question. Never a row that
   * sets a change aside or drops it. Omitted: the card itself takes focus.
   */
  focusRow?: number;
  /** What a screen reader hears when the card appears; defaults to a string title. */
  announcement?: string;
  /** Shown between the title and the rows. */
  children?: ReactNode;
}

/**
 * Whether a new card may take focus: only from inside the assistant panel (marked
 * `data-assistant-panel`) or from nothing at all, and never from a text field the
 * user is mid-sentence in. Focus on the main screen -- a roster cell, a form field --
 * stays put; the dock's live region still announces the card.
 */
function mayTakeFocus(): boolean {
  const active = document.activeElement;
  if (active === null || active === document.body) return true;
  const typing =
    (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) &&
    active.value !== "";
  return !typing && active.closest("[data-assistant-panel]") !== null;
}

export function DockCard({
  title,
  eyebrow,
  aside,
  onClose,
  closeLabel = "Close",
  options = [],
  multiple,
  other,
  onSkip,
  rowsLabel,
  autoFocus = true,
  focusRow,
  announcement,
  children,
  ...props
}: DockCardProps) {
  const titleId = useId();
  const { focusComposer, announce } = useContext(DockServicesContext);
  const root = useRef<HTMLDivElement>(null);
  // By index, not label: two options may share a label.
  const [checked, setChecked] = useState<readonly number[]>([]);
  const [text, setText] = useState("");
  // Every row, in order, with the typed row last.
  const rows = useRef<(HTMLButtonElement | HTMLInputElement | null)[]>([]);

  const usable = (row: HTMLButtonElement | HTMLInputElement | null | undefined) =>
    row != null && !row.disabled;

  const spoken = announcement ?? (typeof title === "string" ? title : "");
  // Once, when the card appears; a re-render must not pull focus back.
  useEffect(() => {
    if (spoken) announce(spoken);
    if (autoFocus && mayTakeFocus()) root.current?.focus();
  }, []);

  // Cards appear mid-turn with their rows disabled. When the default row becomes
  // usable (the turn ended), focus moves onto it -- but only if focus is still on the
  // card itself or nowhere, never away from something the user chose since.
  const focusable = focusRow !== undefined && !options[focusRow]?.disabled && !multiple?.disabled;
  useEffect(() => {
    if (!autoFocus || !focusable || focusRow === undefined) return;
    const active = document.activeElement;
    if (active === root.current || active === document.body || active === null) {
      rows.current[focusRow]?.focus();
    }
  }, [autoFocus, focusable, focusRow]);

  const move = (step: 1 | -1) => {
    const list = rows.current.slice(0, options.length + (other ? 1 : 0));
    const from = list.findIndex((row) => row === document.activeElement);
    for (let n = 1; n <= list.length; n += 1) {
      const next = list[(from + step * n + list.length * 2) % list.length];
      if (usable(next)) return next?.focus();
    }
  };

  const toggle = (index: number) =>
    setChecked((current) =>
      current.includes(index) ? current.filter((i) => i !== index) : [...current, index],
    );

  const pick = (index: number) => {
    const option = options[index];
    if (!option || option.disabled || multiple?.disabled) return;
    if (multiple) toggle(index);
    else option.onPick?.();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const inField =
      (target instanceof HTMLInputElement && target.type !== "checkbox") ||
      target instanceof HTMLTextAreaElement ||
      target.isContentEditable;
    const otherRow = target === rows.current[options.length];
    const modified = event.altKey || event.ctrlKey || event.metaKey;
    if (event.key === "Escape") {
      // Handled HERE: the panel closes on any Escape that reaches the document.
      event.stopPropagation();
      onClose?.();
      focusComposer();
    } else if (
      event.key === "Enter" &&
      event.target instanceof HTMLButtonElement &&
      rows.current.includes(event.target)
    ) {
      // Picked here rather than left to the button's own activation, which not every
      // input path delivers; preventDefault below stops a second, native click.
      event.target.click();
    } else if (event.key === "ArrowDown" && !inField) move(1);
    else if (event.key === "ArrowUp" && (!inField || otherRow)) move(-1);
    else if (
      !inField &&
      !modified &&
      /^[1-9]$/.test(event.key) &&
      Number(event.key) <= options.length
    ) {
      pick(Number(event.key) - 1);
    } else return;
    event.preventDefault();
  };

  const trimmed = text.trim();
  const sendMultiple = () =>
    multiple?.onSend(
      options.map((_, index) => index).filter((index) => checked.includes(index)),
      trimmed,
    );

  const rowList = (
    <ul className="flex flex-col">
      {options.map((option, index) => {
        const on = checked.includes(index);
        return (
          <li key={index}>
            <button
              ref={(node) => {
                rows.current[index] = node;
              }}
              type="button"
              role={multiple ? "checkbox" : undefined}
              aria-checked={multiple ? on : undefined}
              data-testid={option.testId}
              disabled={option.disabled || multiple?.disabled}
              onClick={() => pick(index)}
              className="flex w-full items-start gap-3 rounded-control px-2 py-1.5 text-left hover:bg-panel-alt focus:bg-panel-alt focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:min-h-touch"
            >
              <span
                aria-hidden
                className={cn(
                  "grid size-6 shrink-0 place-items-center rounded-chip text-meta font-medium tabular-nums",
                  option.primary || on
                    ? "bg-brand text-onbrand"
                    : multiple
                      ? "border border-rule bg-surface"
                      : "bg-panel text-ink2",
                )}
              >
                {multiple ? on ? <FaCheck className="size-3" /> : null : index + 1}
              </span>
              <span className="flex min-w-0 flex-col pt-0.5">
                <span className="text-body text-ink">{option.label}</span>
                {option.detail ? (
                  <span className="text-meta text-ink3">{option.detail}</span>
                ) : null}
              </span>
            </button>
          </li>
        );
      })}
      {other ? (
        <li className="flex items-center gap-3 px-2 py-1.5">
          <span
            aria-hidden
            className="grid size-6 shrink-0 place-items-center rounded-chip bg-panel text-ink3"
          >
            <FaPen className="size-3" />
          </span>
          <Input
            ref={(node) => {
              rows.current[options.length] = node;
            }}
            aria-label={other.label}
            placeholder={other.label}
            value={text}
            disabled={other.disabled}
            className="h-control-sm"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
              event.preventDefault();
              if (multiple) {
                if (trimmed !== "" || checked.length > 0) sendMultiple();
              } else if (trimmed !== "") other.onSend(trimmed);
            }}
          />
          {multiple && (checked.length > 0 || trimmed !== "" || !onSkip) ? (
            <Button
              size="sm"
              aria-label="Send selected"
              disabled={multiple.disabled || (checked.length === 0 && trimmed === "")}
              onClick={sendMultiple}
            >
              Send
            </Button>
          ) : !multiple && trimmed !== "" ? (
            <Button
              size="sm"
              aria-label={other.sendLabel}
              disabled={other.disabled}
              onClick={() => other.onSend(trimmed)}
            >
              Send
            </Button>
          ) : onSkip ? (
            <Button size="sm" variant="secondary" disabled={other.disabled} onClick={onSkip}>
              Skip
            </Button>
          ) : null}
        </li>
      ) : null}
    </ul>
  );

  return (
    <Surface
      level="surface"
      geometry="card"
      className="flex min-h-0 shrink-0 flex-col gap-2 p-3"
      ref={root}
      // Focusable only by script: the card holds focus, with no row picked, until
      // its default row is usable.
      tabIndex={-1}
      role="group"
      aria-labelledby={titleId}
      onKeyDown={onKeyDown}
      {...props}
    >
      <header className="flex items-start gap-2 px-1">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {eyebrow}
          <h3
            id={titleId}
            className="font-heading text-body font-semibold tracking-[-0.015em] text-ink"
          >
            {title}
          </h3>
        </div>
        {aside}
        {onClose ? (
          <button
            type="button"
            aria-label={closeLabel}
            onClick={onClose}
            className="grid size-7 shrink-0 place-items-center rounded-pill text-ink3 hover:bg-panel-alt hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-brand pointer-coarse:size-touch"
          >
            <FaXmark className="size-3.5" />
          </button>
        ) : null}
      </header>
      {children}
      {options.length > 0 || other ? (
        rowsLabel ? (
          <div role="group" aria-label={rowsLabel}>
            {rowList}
          </div>
        ) : (
          rowList
        )
      ) : null}
    </Surface>
  );
}
