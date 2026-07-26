"use client";

// The shared per-field shell for every card-editor form — the design prototype's
// field cell (docs/design_prototype/ScreenCards.dc.html:80-88): an uppercase label
// with an optional inline hint beside it, the control, and the verbatim validation
// error line.
//
// Extracted from five byte-identical copies (affinities / counts / coverings /
// requirements / successions), all of which laid the row out `justify-between` —
// which flings the hint to the far edge, reading as detached from its label once
// the hint is more than a word or two (contracted-hours passes hints up to ~74
// chars). One definition now means one label row everywhere.
//
// The label deliberately does NOT carry `white-space:nowrap`, even though the
// prototype's does (ScreenCards.dc.html:84). With a nowrap label + hint, the row
// overflows a half-width grid cell and paints outside the form panel — verified at
// the 0.9 type scale this app shipped (bmw.8 kept the prior persisted-Compact
// baseline as literals in globals.css rather than the 1.0 Comfortable the prototype
// uses). Wrapping is the graceful failure here: it costs nothing when the label +
// hint fit on one line, and saves the overflow when they do not.
//
// History note (bmw.8). This used to overdramatize the overflow as a "density range"
// effect: the prototype has two density multipliers (`--sp` for spacing, `--dens`
// for type, Nurse Scheduling.dc.html:25-26), but neither is ported as a knob — the
// match between the prototype's `--m-xs` × `--dens` and this app's `text-label` ×
// 0.9 is now a single fixed size. The wrap is kept because the overflow it prevents
// is still real at that fixed size.

import * as React from "react";
import { FaCircleExclamation } from "@/components/icons";

export interface FieldShellProps {
  label: string;
  /** Appends the red `*` to the label. */
  required?: boolean;
  /**
   * SHORT italic guidance rendered directly beside the label (the prototype's
   * `hints` map — "optional", "who must supervise"). Explanatory paragraphs do not
   * belong here: the label row is a single baseline-aligned line, so long copy
   * reads as detached from the field. Put it next to the control instead — the
   * prototype's `prefNote` treatment (ScreenCards.dc.html:212-217).
   */
  hint?: string;
  error?: string;
  children: React.ReactNode;
}

export function FieldShell({ label, required, hint, error, children }: FieldShellProps) {
  return (
    <div className="flex flex-col gap-1.5">
      {/* Prototype label row: the hint sits directly BESIDE the label (gap 8px),
          not pushed to the far edge — ScreenCards.dc.html:82-85. */}
      <div className="flex items-baseline gap-2">
        <span className="text-label font-semibold uppercase tracking-[0.03em] text-ink2">
          {label}
          {required && <span className="text-error"> *</span>}
        </span>
        {hint && <span className="text-meta italic text-ink3">{hint}</span>}
      </div>
      {children}
      {error && (
        <p className="flex items-center gap-1.5 text-meta font-semibold text-error" role="alert">
          <FaCircleExclamation className="size-3 flex-none" /> {error}
        </p>
      )}
    </div>
  );
}
