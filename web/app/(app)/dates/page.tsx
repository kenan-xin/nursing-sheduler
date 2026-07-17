// Dates tab (T10; spec 02). A thin server entry that mounts the client DatesScreen
// and pulls in the FullCalendar token restyle (global, scoped under
// `.ns-month-calendar`). All editing state lives in the durable scenario store via
// the client orchestrator.

import "@/components/dates/calendar.css";
import { DatesScreen } from "@/components/dates/dates-screen";

export default function DatesPage() {
  return <DatesScreen />;
}
