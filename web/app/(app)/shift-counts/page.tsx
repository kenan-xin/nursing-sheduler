// Shift Counts screen (T12 seed, spec 05) — replaces the T08 placeholder.
// The editor is a client component (it binds the durable scenario store); this
// route module just mounts it.

import { CountsEditor } from "@/components/counts/counts-editor";

export default function ShiftCountsPage() {
  return <CountsEditor />;
}
