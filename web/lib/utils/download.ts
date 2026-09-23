// A small browser download helper. Creates an object URL, clicks a synthesized
// anchor, and revokes the URL — the same pattern the scenario/export paths use
// inline (`scenario-file-card.tsx`, `use-optimize-terminal.ts`). Centralized so
// the roster export paths (roster file + edited XLSX) share one implementation
// and one place to guard SSR (no `document`).

/** Trigger a browser download of a Blob under the given filename. SSR-safe. */
export function downloadBlob(blob: Blob, filename: string): void {
  if (typeof document === "undefined") return;
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
