// Shift Requests screen (T11) — replaces the T08 placeholder. The editor is a
// client component (it binds the durable scenario store); this route module
// just mounts it.

import { RequestsEditor } from "@/components/requests/requests-editor";

export default function ShiftRequestsPage() {
  return <RequestsEditor />;
}
