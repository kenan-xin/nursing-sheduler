// Applies the persisted theme + density to <html> before first paint so there is
// no flash of the wrong theme. Kept as a standalone inline script (not a client
// component with an effect) because it must run synchronously in <head>. The keys
// and defaults here must match theme-provider.tsx.
const script = `(function () {
  try {
    var d = document.documentElement;
    var t = localStorage.getItem("ns-theme");
    if (t !== "light" && t !== "dark") {
      t = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    d.classList.toggle("dark", t === "dark");
    var den = localStorage.getItem("ns-density");
    d.setAttribute("data-density", den === "spacious" || den === "compact" ? den : "comfortable");
    var a = localStorage.getItem("ns-accent");
    d.setAttribute("data-accent", a === "teal" || a === "magenta" || a === "slate" ? a : "blue");
  } catch (e) {}
})();`;

export function ThemeScript() {
  return <script dangerouslySetInnerHTML={{ __html: script }} />;
}
