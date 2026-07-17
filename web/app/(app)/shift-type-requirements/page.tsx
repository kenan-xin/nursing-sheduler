// Staffing Requirements screen (T12 M1 clone, spec 05) — replaces the T08
// placeholder. The editor is a client component (it binds the durable scenario
// store); this route module just mounts it.

import { RequirementsEditor } from "@/components/requirements/requirements-editor";

export default function ShiftTypeRequirementsPage() {
  return <RequirementsEditor />;
}
