// Shift Affinities screen (T12 M1 clone, spec 05) — replaces the T08 placeholder.
// The editor is a client component (it binds the durable scenario store); this
// route module just mounts it.

import { AffinitiesEditor } from "@/components/affinities/affinities-editor";

export default function ShiftAffinitiesPage() {
  return <AffinitiesEditor />;
}
