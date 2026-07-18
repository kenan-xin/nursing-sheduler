"use client";

// Guarded navigation (T08a/b, FR-PR-06). Every in-app navigation path — nav
// links, the mobile sheet, guarded links, programmatic pushes — routes through
// `navigate()`/`replace()`, which dispatch a typed `push`/`replace` intent
// (see nav-guard-store.ts). When no losable draft is open the intent commits
// immediately; when one is open it stages the shell's single confirm dialog.
//
// DL12 scope (T08b): internal navigation ONLY reads losable-draft state. It no
// longer reads backup freshness (the workspace-YAML fingerprint), solver
// readiness, or local persistence status — a committed edit is already durable
// through T04 autosave, so there is nothing to warn about on an internal route
// change. (The old whole-scenario "leave without saving?" warning against the
// backup fingerprint was product behavior superseded by DL12/DL13 — T08e will
// give that fingerprint its own honest "Backup out of date" display, never a
// route guard.)
//
// Two browser-level guards are separate hooks, both mounted once in the shell:
//   • `useDirtyBeforeUnload` — refresh / tab close / external nav. Arms on an
//     open losable draft OR local persistence status `saving`/`error` (T08a's
//     shell-neutral persistence-status store) — never on backup freshness.
//   • `useBrowserBackGuard` — intercepts the physical Back button via a
//     same-URL history sentinel while a draft is open.

import { useCallback, useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { getPersistenceStatus } from "./persistence-status";
import { dispatchNavIntent, hasLosableDrafts, useNavGuardStore } from "./nav-guard-store";

// Bridged from `useBrowserBackGuard` below to `navigate`/`replace`'s commits —
// the back guard mounts exactly once (app-shell.tsx) for the app's lifetime, so
// this module-level handle is a safe stand-in for prop drilling between the two
// hooks in this file. See those commits for why they're needed (T08g/T08h).
let isBackGuardSentinelArmed: () => boolean = () => false;
// Marks the sentinel already consumed — synchronously, before the router
// transition starts — so a real draft's unmount cleanup racing that transition
// (e.g. the source route's `useLosableDraft` tearing down) can never observe a
// stale "armed" flag and pop the entry a guarded push/replace just collapsed
// into (T08h). Deliberately separate from `armSentinel`/`disarmSentinel`: this
// path never called `history.back()` — the entry was already overwritten by
// `router.replace` — so there is nothing to pop, only the flag to clear.
let consumeBackGuardSentinel: () => void = () => {};

export interface GuardedNavigation {
  /** Push to `path`, staging the guard first if a losable draft is open. */
  navigate: (path: string) => void;
  /** Replace with `path`, staging the guard first if a losable draft is open. */
  replace: (path: string) => void;
}

export function useGuardedNavigation(): GuardedNavigation {
  const router = useRouter();
  const pathname = usePathname();

  const navigate = useCallback(
    (path: string) => {
      if (path === pathname) return; // same-route clicks are no-ops
      dispatchNavIntent({
        kind: "push",
        commit: () => {
          // The current route's shielding sentinel (if armed) is still the
          // active history entry when this commits — a plain `push` would
          // stack the new route on top of it, stranding the sentinel as a
          // permanent duplicate underneath every future route (T08g). Since
          // we're already sitting on that duplicate entry, `replace`
          // collapses it away for free instead. The destination still gets
          // its own fresh sentinel once its own draft registers there — see
          // the pathname-reset effect in `useBrowserBackGuard`.
          //
          // `consumeBackGuardSentinel()` must run BEFORE `router.replace` —
          // synchronously, not in a later effect — because the source route's
          // real draft (e.g. `useLosableDraft`) unmounts as part of this same
          // transition. If its cleanup fires while the flag still reads
          // "armed", it reads the collapsed entry as poppable and calls
          // `history.back()`, undoing the confirmed navigation (T08h).
          if (isBackGuardSentinelArmed()) {
            consumeBackGuardSentinel();
            router.replace(path);
          } else {
            router.push(path);
          }
        },
      });
    },
    [router, pathname],
  );

  const replace = useCallback(
    (path: string) => {
      if (path === pathname) return;
      dispatchNavIntent({
        kind: "replace",
        commit: () => {
          // Same T08h race as `navigate` above: a guarded replace also lands
          // on the currently-armed sentinel's entry, so the flag must be
          // consumed before the transition, not left for a later effect.
          if (isBackGuardSentinelArmed()) consumeBackGuardSentinel();
          router.replace(path);
        },
      });
    },
    [router, pathname],
  );

  return { navigate, replace };
}

// Browser-level guard: warns before refresh / tab close / external nav while a
// losable draft is open OR the last tracked write hasn't settled (`saving`) or
// failed (`error`). Committed-and-saved edits never warn — autosave already
// made them durable (T04); the prompt is only ever about work that could still
// be lost. The native prompt string is browser-controlled; setting
// `returnValue` is what triggers it.
export function useDirtyBeforeUnload(): void {
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      const status = getPersistenceStatus();
      if (hasLosableDrafts() || status === "saving" || status === "error") {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);
}

// Browser Back interception via one same-URL history sentinel.
//
// While a losable draft is open, a physical Back press must not leave
// silently. We arm by pushing a duplicate-URL history entry the moment a draft
// registers, so that press only pops OUR sentinel (same URL, no visible nav) —
// which we detect via `popstate`. The confirm dialog stays SHIELDED the whole
// time it's open (T08f P1): every interception immediately re-arms a fresh
// sentinel before staging/reusing the intent, so a repeated Back press before
// the user decides just pops that fresh sentinel too (harmless, no visible
// change) instead of ever reaching the real prior route out from under an open
// dialog. `nav-guard-store`'s `requestIntent` already refuses to stage a
// second intent while one is pending, so re-dispatching here on a repeat press
// is a no-op — only the re-arm matters.
//
// Consequences of always-shielded:
//   • Cancel needs no action — the dialog was already re-armed when it opened.
//   • Confirm must consume TWO real backs: one for the shielding sentinel
//     (silent, same URL), one for the actual prior route. Both are chained
//     through `ignorePopstateCount` so neither re-triggers the guard.
//
// Two more failure modes fixed here (T08f P1):
//   • Closing the LAST open draft with no further navigation left a stray
//     sentinel behind, silently consuming the next physical Back. Disarming
//     (popping it) the instant the registry empties fixes the same-page case.
//   • A stale `armed` flag surviving a push/replace to a new route would skip
//     arming a fresh sentinel for a draft opened THERE, leaving that page's
//     Back button completely unguarded. Resetting on every pathname change
//     fixes the cross-page case — any sentinel left behind on the old page is
//     no longer this hook's concern once the route has moved on.
export function useBrowserBackGuard(): void {
  const pathname = usePathname();
  const sentinelArmedRef = useRef(false);
  const pathnameRef = useRef(pathname);

  useEffect(() => {
    if (pathnameRef.current === pathname) return;
    pathnameRef.current = pathname;
    sentinelArmedRef.current = false;
  }, [pathname]);

  useEffect(() => {
    let ignorePopstateCount = 0;
    isBackGuardSentinelArmed = () => sentinelArmedRef.current;
    consumeBackGuardSentinel = () => {
      sentinelArmedRef.current = false;
    };

    const armSentinel = () => {
      if (sentinelArmedRef.current) return;
      window.history.pushState({ __nsBackGuardSentinel: true }, "", window.location.href);
      sentinelArmedRef.current = true;
    };

    // Pop our own shielding sentinel, silently — only valid while nothing else
    // has navigated since it was armed (same-page draft close).
    const disarmSentinel = () => {
      if (!sentinelArmedRef.current) return;
      ignorePopstateCount = 1;
      sentinelArmedRef.current = false;
      window.history.back();
    };

    const unsubscribe = useNavGuardStore.subscribe((state, prev) => {
      if (state.drafts.size > 0 && prev.drafts.size === 0) armSentinel();
      else if (state.drafts.size === 0 && prev.drafts.size > 0) disarmSentinel();
    });
    if (hasLosableDrafts()) armSentinel();

    const handlePopState = () => {
      if (ignorePopstateCount > 0) {
        ignorePopstateCount--;
        if (ignorePopstateCount > 0) {
          window.history.back(); // still consuming a committed multi-back chain
        } else {
          sentinelArmedRef.current = false; // this final pop is the real navigation
        }
        return;
      }
      if (!hasLosableDrafts()) {
        sentinelArmedRef.current = false;
        return; // nothing to guard — let this Back stand
      }
      // Our sentinel was just consumed (or this is a stray unshielded press) —
      // re-arm immediately so the dialog stays shielded for any repeat press,
      // then (re-)stage the intent; a second stage while one is already
      // pending is a no-op (nav-guard-store.requestIntent).
      sentinelArmedRef.current = false;
      armSentinel();
      dispatchNavIntent({
        kind: "back",
        commit: () => {
          ignorePopstateCount = 2; // the shielding sentinel, then the real route
          window.history.back();
        },
      });
    };

    window.addEventListener("popstate", handlePopState);
    return () => {
      unsubscribe();
      window.removeEventListener("popstate", handlePopState);
      isBackGuardSentinelArmed = () => false;
      consumeBackGuardSentinel = () => {};
    };
  }, []);
}
