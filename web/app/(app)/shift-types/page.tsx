"use client";

import { EntityEditor } from "@/components/entity-editor/entity-editor";
import { shiftTypesDescriptor } from "@/components/shift-types/shift-types-descriptor";

export default function ShiftTypesPage() {
  return <EntityEditor descriptor={shiftTypesDescriptor} />;
}
