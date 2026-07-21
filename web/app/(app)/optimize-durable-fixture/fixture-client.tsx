"use client";

// T16f durable acceptance harness — see ./page.tsx for the gating rationale.
//
// Seeds the minimum required-data readiness (a roster range, one person, one
// shift type) into the REAL scenario store so the Optimize button enables, then
// mounts the real screen. The only injected controller seam is `prepare`, which
// returns a canned prep so the journey never depends on hand-building a fully
// valid canonical scenario — the scenario→YAML transform is proven separately
// by the T16q unit tests. Everything downstream (submission transaction, POST,
// SSE stream, reconnect, poll, terminal download/restore, cleanup DELETE,
// recovery) stays real and is stubbed only at the HTTP boundary by the
// Playwright spec (or left fully real for the assembled Compose gate).
//
// Window-flag overrides (`__NS_DURABLE_FIXTURE_YAML` / `_PEOPLE_COUNT` /
// `_REVERSE_MAP` / `_ANONYMIZE`) let the assembled gate inject a REAL solvable
// YAML and a real one-person reverse map so the genuine Browser → Next →
// FastAPI path produces a real workbook with a restorable person id.

import { useEffect, useState } from "react";
import { OptimizeAndExportScreen } from "@/components/optimize/optimize-and-export-screen";
import { useScenarioStore } from "@/lib/store";
import type {
  PrepareOptimizeSubmissionOptions,
  PrepareOptimizeSubmissionResult,
} from "@/lib/scenario";
import type { CanonicalScenarioDocument } from "@/lib/scenario/types";

interface DurableFixtureWindow extends Window {
  __NS_DURABLE_FIXTURE_YAML?: string;
  __NS_DURABLE_FIXTURE_PEOPLE_COUNT?: number;
  __NS_DURABLE_FIXTURE_REVERSE_MAP?: [string, string | number][];
}

/** A canned, always-valid prep. The real scenario→YAML transform is exercised
 *  by the T16q unit tests; this harness only needs a deterministic prep so the
 *  assembled browser journey reaches the POST. When the window flags are set
 *  (assembled Compose gate / anonymized reload journey), the canned YAML and
 *  reverse map come from the test harness so the real backend solves a real
 *  problem and the downloaded workbook carries a restorable id. */
function cannedPrepare(
  _document: CanonicalScenarioDocument,
  options: PrepareOptimizeSubmissionOptions,
): PrepareOptimizeSubmissionResult {
  const w = (typeof window !== "undefined" ? window : {}) as DurableFixtureWindow;
  const yaml = w.__NS_DURABLE_FIXTURE_YAML ?? "workspaceVersion: 1\n";
  const peopleCount = w.__NS_DURABLE_FIXTURE_PEOPLE_COUNT ?? 0;
  const reverseMap = w.__NS_DURABLE_FIXTURE_REVERSE_MAP ?? [];
  return {
    ok: true,
    prep: {
      yaml,
      peopleCount,
      reverseMap,
      anonymized: options.anonymize,
    },
  };
}

export default function OptimizeDurableFixtureClient() {
  const [seeded, setSeeded] = useState(false);

  useEffect(() => {
    // Merge the readiness fields onto the already fully-initialized store so the
    // required-data gate passes; every other slice keeps its valid initial shape.
    useScenarioStore.getState().mutateScenario({
      rangeStart: "2026-01-01",
      rangeEnd: "2026-01-07",
      staff: [{ id: "P1", description: "", history: [] }],
      shifts: [
        {
          id: "Day",
          description: "",
          startTime: "08:00",
          endTime: "16:00",
          restMinutes: 0,
          durationMinutes: 480,
        },
      ],
    });
    setSeeded(true);
  }, []);

  if (!seeded) {
    return <div data-testid="optimize-durable-seeding">Seeding fixture…</div>;
  }

  return (
    <div data-testid="optimize-durable-fixture">
      <OptimizeAndExportScreen controllerDeps={{ prepare: cannedPrepare }} />
    </div>
  );
}
