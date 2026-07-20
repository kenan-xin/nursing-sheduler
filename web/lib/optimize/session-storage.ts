// The single accessor for the real tab-scoped `sessionStorage`, shared by the
// T16a submission controller and the T16b recovery layer so both read and write
// the one durable record through the exact same `Storage` (and the same key).
//
// A browser that denies access (private mode / a `SecurityError` on the
// `sessionStorage` getter) yields a throwing stand-in rather than `null`, so the
// guarded storage primitives in `session-transaction.ts` classify the failure as
// unreadable/unavailable instead of dereferencing a missing object.

import type { SessionTransactionStorage } from "./session-transaction";

function throwingStorage(): SessionTransactionStorage {
  const throwing = (): never => {
    throw new Error("sessionStorage is unavailable.");
  };
  return { getItem: throwing, setItem: throwing, removeItem: throwing };
}

/** The real `sessionStorage`, or a throwing stand-in when the browser denies it. */
export function acquireSessionStorage(): SessionTransactionStorage {
  let storage: Storage;
  try {
    storage = globalThis.sessionStorage;
  } catch {
    return throwingStorage();
  }
  if (!storage) return throwingStorage();
  return storage;
}
