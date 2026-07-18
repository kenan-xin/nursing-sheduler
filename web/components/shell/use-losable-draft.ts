"use client";

// Shared losable-draft registration (T08a). Register a draft editor's open state
// with the navigation guard so leaving while it holds unsaved, not-yet-durable
// work prompts (FR-PR-06). An editor counts as losable the moment it opens, even
// before its first keystroke, matching the old app's editor-registration
// behavior — so this registers as soon as `active` is true, not on first edit.

import { useEffect } from "react";
import { useNavGuardStore } from "./nav-guard-store";

/**
 * Register/unregister a losable draft under `id` as `active` changes. Toggling
 * `active` false→true re-registers; unmounting while active cleans up. Two
 * owners with different ids are independent — one closing never disarms the
 * other (see `nav-guard-store`'s keyed registry).
 */
export function useLosableDraft(id: string, active: boolean, label: string): void {
  const registerDraft = useNavGuardStore((s) => s.registerDraft);
  useEffect(() => {
    if (!active) return;
    return registerDraft({ id, label });
  }, [id, active, label, registerDraft]);
}
