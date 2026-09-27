"use client";

// Guided Rules screen (T14c) — a real, directly-routable /rules surface.
// Sidebar/Home/crumb exposure now come from the shared nav-config registry
// (T08d); this route module supplies the one shell-owned integration seam
// `RulesScreen` itself doesn't own: "Edit in Advanced" performs the DL12 §2
// step-5 inverse transaction (switch to Advanced + navigate) atomically,
// guarded the same way as any other navigation.
//
// qq0.14.1: an Advanced → Guided redirect lands here and leaves a one-shot
// note of the editor it left (guided-arrival.ts). Snapshot it into state on
// mount, then consume it so a later ordinary visit shows nothing stale.

import { useEffect, useState } from "react";
import { RulesScreen } from "@/components/guided-rules/rules-screen";
import { useModeTransition } from "@/components/shell/use-mode-transition";
import { clearGuidedArrival, peekGuidedArrival } from "@/components/shell/guided-arrival";

export default function RulesPage() {
  const { requestModeChangeToRoute } = useModeTransition();
  const [from] = useState(peekGuidedArrival);
  useEffect(clearGuidedArrival, []);
  return (
    <RulesScreen
      advancedSource={from}
      onOpenAdvanced={(route) => requestModeChangeToRoute("advanced", route)}
    />
  );
}
