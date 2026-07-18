// Guided Rules screen (T14c) — a real, directly-routable /rules surface. The
// screen is a client component (it binds the durable scenario store); this route
// module just mounts it. Sidebar/Home/crumb exposure and mode-aware routing are
// T08d's job (tech-plan §2) — this route is complete and reachable on its own.

import { RulesScreen } from "@/components/guided-rules/rules-screen";

export default function RulesPage() {
  return <RulesScreen />;
}
