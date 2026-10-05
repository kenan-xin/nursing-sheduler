"use client";

// Bead rnrt: the priority ladder's pre-Run check (spec section 7). Each enabled rule
// whose weight is off its tier's band is listed as a non-blocking warning, so a run
// where a low-priority goal can beat a high one is never a surprise.

import { useMemo } from "react";
import { checkWeightOrder } from "@/lib/rules/priority-ladder";
import { useScenarioStore } from "@/lib/store";
import { Callout } from "./callout";

export function LadderPreflight() {
  const cardsByKind = useScenarioStore((state) => state.cardsByKind);
  const reqData = useScenarioStore((state) => state.reqData);
  const findings = useMemo(
    () => checkWeightOrder({ cardsByKind, reqData }),
    [cardsByKind, reqData],
  );
  if (findings.length === 0) return null;
  return (
    <Callout
      tone="warn"
      placement="page"
      data-testid="optimize-ladder-preflight"
      title="Some weights break the priority order"
    >
      <ul className="list-disc space-y-1 pl-5">
        {findings.map((finding) => (
          <li key={`${finding.kind}:${finding.ruleId ?? finding.weight}`} className="min-w-0">
            {finding.message}
          </li>
        ))}
      </ul>
      <p className="mt-2">
        A lower priority can then win over a higher one. Optimize still runs; ask the assistant to
        fix them, or change the weights on their screens.
      </p>
    </Callout>
  );
}
