"use client";

// Guided Rules screen (T14c) — a real, directly-routable /rules surface.
// Sidebar/Home/crumb exposure now come from the shared nav-config registry
// (T08d); this route module supplies the one shell-owned integration seam
// `RulesScreen` itself doesn't own: "Edit in Advanced" performs the DL12 §2
// step-5 inverse transaction (switch to Advanced + navigate) atomically,
// guarded the same way as any other navigation.

import { RulesScreen } from "@/components/guided-rules/rules-screen";
import { useModeTransition } from "@/components/shell/use-mode-transition";

export default function RulesPage() {
  const { requestModeChangeToRoute } = useModeTransition();
  return <RulesScreen onOpenAdvanced={(route) => requestModeChangeToRoute("advanced", route)} />;
}
