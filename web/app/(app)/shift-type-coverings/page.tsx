// Shift Type Coverings screen (T13, spec 11) — replaces the T08 placeholder.
// The editor is a client component (it binds the durable scenario store); this
// route module just mounts it.

import { CoveringsEditor } from "@/components/coverings/coverings-editor";

export default function ShiftTypeCoveringsPage() {
  return <CoveringsEditor />;
}
