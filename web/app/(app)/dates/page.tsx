import { PlaceholderScreen } from "@/components/shell/placeholder-screen";
import { FaCalendarDays } from "@/components/icons";

export default function DatesPage() {
  return (
    <PlaceholderScreen
      title="Dates"
      description="Define the scheduling period and any special date groups."
      icon={FaCalendarDays}
    />
  );
}
