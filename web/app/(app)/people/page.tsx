import { PlaceholderScreen } from "@/components/shell/placeholder-screen";
import { FaUsers } from "@/components/icons";

export default function PeoplePage() {
  return (
    <PlaceholderScreen
      title="People"
      description="Manage the nurses and people groups in the roster."
      icon={FaUsers}
    />
  );
}
