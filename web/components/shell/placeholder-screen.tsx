// Placeholder screen scaffold (T08). The nav owner provides a reachable entry
// point for every capability now (acceptance row 5 / critique #8), while the
// editors themselves land with their own tickets (People/Dates/Shift types →
// T07; the Rules-layer editors → T14; Export Layout → T15). Each route renders
// this header + an honest empty state so the capability is navigable and named,
// without faking functionality that isn't built yet.

import type { IconType } from "@/components/icons";

export function PlaceholderScreen({
  title,
  description,
  icon: Icon,
}: {
  title: string;
  description: string;
  icon: IconType;
}) {
  return (
    <div
      data-testid="screen"
      data-screen={title}
      className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-5 py-8"
    >
      <header className="flex items-center gap-3">
        <span className="flex size-9 items-center justify-center border border-line bg-panel text-ink2">
          <Icon className="size-4" />
        </span>
        <div className="flex flex-col gap-0.5">
          <h1 className="font-heading text-title font-semibold tracking-tight">{title}</h1>
          <p className="text-meta text-ink2">{description}</p>
        </div>
      </header>

      <div className="flex flex-col items-start gap-2 border border-dashed border-line bg-surface p-6">
        <p className="text-body text-ink2">
          This screen is part of the parity rebuild and lands with its editor ticket.
        </p>
        <p className="text-meta text-ink3">Reachable now so the workflow is complete end to end.</p>
      </div>
    </div>
  );
}
