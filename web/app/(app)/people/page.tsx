"use client";

import { EntityEditor } from "@/components/entity-editor/entity-editor";
import { peopleDescriptor } from "@/components/people/people-descriptor";

export default function PeoplePage() {
  return <EntityEditor descriptor={peopleDescriptor} />;
}
