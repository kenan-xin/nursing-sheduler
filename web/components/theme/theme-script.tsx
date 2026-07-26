// Applies the persisted theme + accent to <html> before first paint so there is
// no flash of the wrong theme. Kept as a standalone inline script (not a client
// component with an effect) because it must run synchronously in <head>. The keys
// and defaults here must match theme-provider.tsx.
//
// Density is no longer persisted or applied (bmw.8); the 0.9 spacing/type scale it
// produced lives as literals in globals.css. A leftover `ns-density` localStorage
// key from a prior session is left in place rather than read — nothing consumes it.
const script = `(function () {
  try {
    var d = document.documentElement;
    var t = localStorage.getItem("ns-theme");
    if (t !== "light" && t !== "dark") {
      t = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    d.classList.toggle("dark", t === "dark");
    var a = localStorage.getItem("ns-accent");
    d.setAttribute("data-accent", a === "teal" || a === "magenta" || a === "slate" ? a : "blue");
  } catch (e) {}
})();`;

export function ThemeScript() {
  return <script dangerouslySetInnerHTML={{ __html: script }} />;
}
