// Shift Type Successions screen (T12 M1 clone, spec 05) — replaces the T08
// placeholder. The editor is a client component (it binds the durable scenario
// store); this route module just mounts it.

import { SuccessionsEditor } from "@/components/successions/successions-editor";

export default function ShiftTypeSuccessionsPage() {
  return <SuccessionsEditor />;
}
