// Structural sharing for the post-commit projection (T03).
//
// WHY THIS EXISTS. Before the cutover, a mutation was a Zustand `set` of a PATCH:
// slices the patch did not name kept their exact references. A great deal of the
// app depends on that, and not incidentally:
//
//   • the editors' "form-open token" staleness guards compare the live slice
//     against the reference captured when the form opened (`shift-type-grid.tsx`,
//     `entity-editor/*`). Reference inequality IS their definition of "something
//     changed elsewhere";
//   • every `useMemo` derivation and every `useScenarioStore((s) => s.slice)`
//     subscription treats a new reference as a real change and re-renders.
//
// A durable commit now round-trips the whole document through IndexedDB, which
// structured-clones it — so EVERY array and object comes back with a fresh
// identity, including the parts nothing touched. Published raw, a rename of one
// shift would look to every open editor like the world moved under it, and would
// re-render every subscriber on the screen.
//
// So the adapter republishes the committed value THROUGH this function: the result
// is deep-equal to the committed document, but every sub-value that did not
// actually change keeps the reference the projection already had. Identity tracks
// VALUE change again, which is the invariant the app was written against.
//
// This is not a cache and not an optimisation shortcut: the returned value always
// equals `next`. It only chooses which of two equal representations to publish.

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A value deep-equal to `next`, reusing `prev`'s references wherever the two
 * agree. Returns `prev` itself when the two are deep-equal all the way down.
 *
 * Scenario documents hold only JSON-shaped data plus `±Infinity` weights, so a
 * structural walk is complete for them; anything it does not recognise (a class
 * instance, a function) is passed through from `next` untouched rather than
 * guessed at.
 */
export function shareStructure<T>(prev: unknown, next: T): T {
  if (prev === next) return next;

  if (Array.isArray(next)) {
    if (!Array.isArray(prev)) return next;
    let unchanged = prev.length === next.length;
    const shared = next.map((item, index) => {
      const value = shareStructure(prev[index], item);
      if (index >= prev.length || value !== prev[index]) unchanged = false;
      return value;
    });
    return (unchanged ? prev : shared) as T;
  }

  if (isPlainObject(next)) {
    if (!isPlainObject(prev)) return next;
    const keys = Object.keys(next);
    // Same key COUNT plus every key present and equal ⇒ the two objects agree.
    // Counting is what catches a key `prev` has and `next` dropped.
    let unchanged = keys.length === Object.keys(prev).length;
    const shared: Record<string, unknown> = {};
    for (const key of keys) {
      const value = shareStructure(prev[key], next[key]);
      shared[key] = value;
      if (!(key in prev) || value !== prev[key]) unchanged = false;
    }
    return (unchanged ? prev : shared) as T;
  }

  return next;
}
