"use client";

// One Guided rule row (T14c) — faithful to docs/design_prototype/ScreenRules.dc.html
// rows 108-193: a switch, title + lock/pinned badges, summary, an Advanced link
// (or "Set up in Advanced" for a not-yet-authored built-in), a config pill, and
// Adjust/Edit-shortcut/Unpin actions. The inline Adjust panel is a dashed-top
// drawer beneath the row, matching the prototype's expand-in-place behavior.

import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  FaArrowRight,
  FaCheck,
  FaLock,
  FaPen,
  FaShieldHalved,
  FaSliders,
  FaThumbtack,
  FaXmark,
} from "@/components/icons";
import type { GuidedRuleRow } from "./types";

export interface RuleRowProps {
  row: GuidedRuleRow;
  admin: boolean;
  adjustOpen: boolean;
  onToggleAdjust: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  onOpenAdvanced: () => void;
  onEditShortcut: () => void;
  onUnpin: () => void;
  /** Returns a validation error, or `undefined` on success (already committed). */
  onAdjustField: (key: string, value: number) => string | undefined;
}

export function RuleRow({
  row,
  admin,
  adjustOpen,
  onToggleAdjust,
  onToggleEnabled,
  onOpenAdvanced,
  onEditShortcut,
  onUnpin,
  onAdjustField,
}: RuleRowProps) {
  const canAdjust = row.quickFields.length > 0 && row.enabled && !row.locked;
  const isPinned = row.source === "record" && row.pin !== undefined;

  return (
    <li
      className={`border-t border-line2 first:border-t-0 ${row.enabled ? "" : "opacity-60"}`}
      data-testid={`rule-row-${row.id}`}
      data-disabled={row.enabled ? undefined : "true"}
    >
      <div className="flex items-start gap-3.5 px-[18px] py-4">
        <Switch
          aria-label={`Toggle ${row.title}`}
          checked={row.enabled}
          disabled={row.locked}
          onCheckedChange={onToggleEnabled}
          data-testid={`rule-toggle-${row.id}`}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`text-body font-bold ${row.enabled ? "text-ink" : "text-ink2"}`}>
              {row.title}
            </span>
            {row.locked && (
              <span title="Always on" className="text-ink3">
                <FaLock className="size-2.5" />
              </span>
            )}
            {isPinned && (
              <Badge variant="brand" data-testid={`rule-pinned-badge-${row.id}`}>
                <FaThumbtack className="size-2" /> Pinned
              </Badge>
            )}
          </div>
          <p className="mt-0.5 text-meta text-ink2">{row.summary}</p>
          {row.source === "record" && !row.unsupportedReason && (
            <button
              type="button"
              onClick={onOpenAdvanced}
              className="mt-1.5 inline-flex items-center gap-1.5 bg-transparent p-0 text-label font-semibold uppercase tracking-[0.03em] text-brandink hover:underline"
              data-testid={`rule-open-advanced-${row.id}`}
            >
              ↳ Constraint <FaArrowRight className="size-2.5" />
            </button>
          )}
          {row.source === "builtin" && (
            <div className="mt-1.5 inline-flex items-center gap-1.5 text-label font-semibold uppercase tracking-[0.03em] text-ink3">
              <FaShieldHalved className="size-2.5" /> Built-in
            </div>
          )}
        </div>
        <div className="flex flex-none flex-col items-end gap-2">
          <span
            className={`px-2.5 py-1 font-mono text-label font-semibold tracking-[0.03em] ${
              row.enabled ? "bg-brandtint text-brandink" : "bg-panel text-ink3"
            }`}
          >
            {row.enabled ? "ON" : "OFF"}
          </span>
          <div className="flex items-center gap-1.5">
            {canAdjust && (
              <Button
                variant={adjustOpen ? "secondary" : "outline"}
                size="sm"
                onClick={onToggleAdjust}
                data-testid={`rule-adjust-toggle-${row.id}`}
              >
                <FaSliders className="size-2.5" /> {adjustOpen ? "Close" : "Adjust"}
              </Button>
            )}
            {admin && isPinned && (
              <Button
                variant="outline"
                size="icon"
                className="size-7"
                aria-label="Edit shortcut"
                title="Edit shortcut"
                onClick={onEditShortcut}
                data-testid={`rule-edit-shortcut-${row.id}`}
              >
                <FaPen className="size-2.5" />
              </Button>
            )}
            {isPinned && (
              <Button
                variant="outline"
                size="icon"
                className="size-7"
                aria-label="Unpin"
                title="Unpin — keeps the constraint in Advanced"
                onClick={onUnpin}
                data-testid={`rule-unpin-${row.id}`}
              >
                <FaXmark className="size-3" />
              </Button>
            )}
          </div>
        </div>
      </div>
      {row.unsupportedReason && (
        <div className="mx-[18px] mb-3.5 flex items-start gap-2 border border-line2 bg-panel px-3.5 py-2.5 text-meta text-ink2">
          <FaLock className="mt-0.5 size-2.5 flex-none text-ink3" />
          <span>
            {row.unsupportedReason}{" "}
            {row.source === "record" && (
              <button
                type="button"
                onClick={onOpenAdvanced}
                className="font-semibold text-brandink hover:underline"
                data-testid={`rule-open-advanced-unsupported-${row.id}`}
              >
                Edit in Advanced
              </button>
            )}
          </span>
        </div>
      )}
      {adjustOpen && canAdjust && (
        <AdjustPanel row={row} onAdjustField={onAdjustField} onDone={onToggleAdjust} />
      )}
    </li>
  );
}

function AdjustPanel({
  row,
  onAdjustField,
  onDone,
}: {
  row: GuidedRuleRow;
  onAdjustField: (key: string, value: number) => string | undefined;
  onDone: () => void;
}) {
  const [errors, setErrors] = React.useState<Record<string, string | undefined>>({});
  const [drafts, setDrafts] = React.useState<Record<string, string>>({});

  return (
    <div
      className="border-t border-dashed border-line bg-panel px-[18px] py-3.5"
      data-testid={`rule-adjust-panel-${row.id}`}
    >
      <div className="mb-3 text-label font-semibold uppercase tracking-[0.03em] text-ink2">
        Adjust parameters
      </div>
      <div className="flex flex-wrap gap-4">
        {row.quickFields.map((field) => {
          const draftValue = drafts[field.key] ?? String(field.value);
          const error = errors[field.key];
          return (
            <label key={field.key} className="block">
              <span className="mb-1.5 block text-meta text-ink2">{field.label}</span>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={field.min}
                  max={field.max}
                  value={draftValue}
                  className="w-24 font-mono font-bold"
                  aria-label={field.label}
                  data-testid={`rule-adjust-input-${row.id}-${field.key}`}
                  onChange={(e) => {
                    const raw = e.target.value;
                    setDrafts((d) => ({ ...d, [field.key]: raw }));
                    const parsed = Number(raw);
                    if (raw.trim() === "" || Number.isNaN(parsed)) {
                      setErrors((er) => ({ ...er, [field.key]: "Enter a number" }));
                      return;
                    }
                    const message = onAdjustField(field.key, parsed);
                    setErrors((er) => ({ ...er, [field.key]: message }));
                  }}
                />
                {field.unit && <span className="font-mono text-label text-ink3">{field.unit}</span>}
              </div>
              {error && (
                <p className="mt-1 text-label text-error" role="alert">
                  {error}
                </p>
              )}
            </label>
          );
        })}
      </div>
      <div className="mt-3.5">
        <Button size="sm" onClick={onDone} data-testid={`rule-adjust-done-${row.id}`}>
          <FaCheck className="size-2.5" /> Done
        </Button>
      </div>
    </div>
  );
}
