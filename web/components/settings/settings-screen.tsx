"use client";

// Settings (T04).
//
// The app had no Settings screen before this ticket: display preferences live on
// the side nav and scenario preferences on Save & Load, so nothing had needed one.
// The assistant does -- the enablement flow makes "Settings → AI assistant" the
// only place the feature can be discovered while it is off, which is the mechanism
// that keeps an optional feature genuinely invisible until a user opts in.
//
// It is deliberately a thin host for one card rather than a home for every existing
// preference. Moving theme, accent or mode here would re-open decisions those
// surfaces already settled, and none of it is T04's to change.

import { AiAssistantCard } from "./ai-assistant-card";

export function SettingsScreen() {
  return (
    <div className="flex flex-col gap-6" data-testid="settings-screen">
      <div className="flex flex-col gap-1">
        <h1 className="font-heading text-h2 font-semibold tracking-[-0.015em]">Settings</h1>
        <p className="text-body text-ink2">
          Optional features. Everything here is off unless you turn it on, and scheduling works
          fully without any of it.
        </p>
      </div>
      <AiAssistantCard />
    </div>
  );
}
