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

/** Puts focus back in the composer. Provided by the dock; a no-op outside it. */
export const ComposerFocusContext = createContext<() => void>(() => {});

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
  /** Take focus when the card appears. */
  autoFocus?: boolean;
  /** Shown between the title and the rows. */
  children?: ReactNode;
}

/** Someone is mid-sentence in a text field: a new card must not steal the caret. */
function isTyping(): boolean {
  const active = document.activeElement;
  return (
    (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) &&
    active.value !== ""
  );
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
  children,
  ...props
}: DockCardProps) {
  const titleId = useId();
  const focusComposer = useContext(ComposerFocusContext);
  // By index, not label: two options may share a label.
  const [checked, setChecked] = useState<readonly number[]>([]);
  const [text, setText] = useState("");
  // Every row, in order, with the typed row last.
  const rows = useRef<(HTMLButtonElement | HTMLInputElement | null)[]>([]);

  const usable = (row: HTMLButtonElement | HTMLInputElement | null | undefined) =>
    row != null && !row.disabled;

  useEffect(() => {
    if (!autoFocus || isTyping()) return;
    rows.current.find(usable)?.focus();
    // Once, when the card appears; a re-render must not pull focus back.
  }, []);

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
    const inField = event.target instanceof HTMLInputElement && event.target.type !== "checkbox";
    if (event.key === "Escape") {
      onClose?.();
      focusComposer();
    } else if (event.key === "ArrowDown" && !inField) move(1);
    else if (event.key === "ArrowUp") move(-1);
    else if (!inField && /^[1-9]$/.test(event.key) && Number(event.key) <= options.length) {
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
          {multiple ? (
            <Button
              size="sm"
              aria-label="Send selected"
              disabled={multiple.disabled || (checked.length === 0 && trimmed === "")}
              onClick={sendMultiple}
            >
              Send
            </Button>
          ) : trimmed !== "" ? (
            <Button
              size="sm"
              aria-label={other.sendLabel}
              disabled={other.disabled}
              onClick={() => other.onSend(trimmed)}
            >
              Send
            </Button>
          ) : onSkip ? (
            <Button size="sm" variant="secondary" onClick={onSkip}>
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
