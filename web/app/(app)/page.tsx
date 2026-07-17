// Home / dashboard entry (T08). A thin route entry that mounts the client
// HomeScreen — the two-mode (Guided/Advanced) roster dashboard rebuilt from the
// prototype's ScreenHome. All content is derived from the durable scenario store.

import { HomeScreen } from "@/components/home/home-screen";

export default function HomePage() {
  return <HomeScreen />;
}
