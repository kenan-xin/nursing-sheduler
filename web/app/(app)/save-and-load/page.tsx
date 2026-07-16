import { PlaceholderScreen } from "@/components/shell/placeholder-screen";
import { FaFloppyDisk } from "@/components/icons";

export default function SaveAndLoadPage() {
  return (
    <PlaceholderScreen
      title="Save and Load"
      description="Save the scenario to YAML or load an existing one."
      icon={FaFloppyDisk}
    />
  );
}
