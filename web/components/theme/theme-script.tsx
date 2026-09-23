// Applies the persisted theme + accent to <html> before first paint so there is
// no flash of the wrong theme or accent. Kept as a standalone inline script (not
// a client component with an effect) because it must run synchronously in <head>.
// The keys, allowlist and defaults here must match theme-store.ts.
//
// The two axes are read in INDEPENDENTLY guarded operations. A browser that
// blocks or throws on storage access (Safari private mode, a hardened profile, a
// denied partitioned context) must still get system theme plus the teal accent;
// one failing read may never abort the other axis, and neither may leave <html>
// unpainted.
//
// This script never writes. An unsupported stored accent is ignored and left
// untouched in storage — there is no allowlist migration, no version key, and no
// one-time reset (adoption record D4b). Likewise `ns-density` from a prior
// session is left in place rather than read; nothing consumes it (bmw.8).
const script = `(function () {
  var d = document.documentElement;

  var t = null;
  try { t = localStorage.getItem("ns-theme"); } catch (e) {}
  if (t !== "light" && t !== "dark") {
    t = "light";
    try {
      if (window.matchMedia("(prefers-color-scheme: dark)").matches) t = "dark";
    } catch (e) {}
  }
  d.classList.toggle("dark", t === "dark");

  var a = null;
  try { a = localStorage.getItem("ns-accent"); } catch (e) {}
  if (a !== "teal" && a !== "sage" && a !== "rose" && a !== "plum") a = "teal";
  d.setAttribute("data-accent", a);
})();`;

export function ThemeScript() {
  return <script dangerouslySetInnerHTML={{ __html: script }} />;
}

// Exported for the contract test, which executes the exact string that ships.
export const THEME_SCRIPT_SOURCE = script;
