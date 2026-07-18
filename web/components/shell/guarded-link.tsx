"use client";

// Guarded internal link (T08b, DL12 §1). A plain Next `<Link>` pushes straight
// through the router, bypassing the shared navigation-intent guard entirely —
// so an open losable draft would be discarded silently. This renders a real
// `<a href>` (so hover/copy-link/inspect behave normally) and intercepts ONLY
// an unmodified, primary, same-origin `_self` click — routing that one case
// through `useGuardedNavigation().navigate`, staging the shell's confirm
// dialog exactly like the sidebar and Home CTAs. Every other activation
// (Ctrl/Cmd/Shift/Alt-click, middle/right click, `target="_blank"`,
// `download`, or an external destination) is left to the browser's native
// anchor behavior (T08f P2) — a guard is only meaningful for an in-app SPA
// navigation, never for "open in new tab" or leaving the app entirely.

import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from "react";
import { useGuardedNavigation } from "./use-guarded-navigation";

export interface GuardedLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string;
  children: ReactNode;
}

/** Whether `href` is an internal, same-origin destination this guard may
 *  intercept — the full path/query/hash is retained and handed to `navigate`
 *  unmodified either way. Exported for focused unit testing. */
export function isSameOriginInternalHref(href: string): boolean {
  if (href.startsWith("//")) return false; // protocol-relative → external
  if (href.startsWith("/")) return true; // root-relative → internal
  try {
    return new URL(href, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

/** Exported for focused unit testing. */
export function isPlainLeftClick(e: MouseEvent<HTMLAnchorElement>): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

export function GuardedLink({
  href,
  children,
  onClick,
  target,
  download,
  ...rest
}: GuardedLinkProps) {
  const { navigate } = useGuardedNavigation();
  return (
    <a
      href={href}
      target={target}
      download={download}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented) return;
        if (
          !isPlainLeftClick(e) ||
          (target !== undefined && target !== "_self") ||
          download !== undefined ||
          !isSameOriginInternalHref(href)
        ) {
          return; // let the browser handle it natively
        }
        e.preventDefault();
        navigate(href);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}
