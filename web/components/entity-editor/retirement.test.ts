import { describe, expect, it } from "vitest";

import {
  entityKey,
  paidMinutesFor,
  sameEntityId,
  validateWorkingTimeDraft,
} from "@/components/entity-editor/core";

// DR-5 boundary guard. The generic `EntityEditor` shell is retired — People and Shift
// Types are bespoke screens (`PeopleTable` / `ShiftTypeGrid`) over the shared
// `entity-editor/core`. The `core`, `groups-section`, `transfer-list` and
// `working-time-fields` modules are the kept, still-shared substrate.
//
// WHAT CHANGED (custom-AST ticket 2). The second half of this file used to walk `app`,
// `components` and `lib`, read every source file, and match a hand-built regular
// expression covering `from`, bare `import`, dynamic `import()`, `require()` and
// `export … from` against a specifier grammar written out by hand. That whole
// apparatus was proving something the toolchain already proves: a module that does not
// exist cannot be imported. `tsc --noEmit` reports TS2307 for a static import, a
// re-export and a dynamic `import()` alike, and it resolves the specifier properly
// rather than pattern-matching its spelling — aliases, nested relative paths and
// extensions included.
//
// WHAT CHANGED AGAIN (custom-AST ticket 6, reader-ledger row 5). Ticket 2 kept the
// DELETION half as a filesystem fact: two `existsSync` calls for the retired module and
// four more as a kept-substrate control. Row 5 is classified `Migrate; no exception`, so
// that reader had to go rather than be granted one — and `existsSync` was the weaker
// mechanism anyway. It answers "is there a file at this path", which an empty file, a
// stub or a directory all satisfy. The compiler answers "does this specifier resolve to a
// module", which is the actual guarantee.
//
// So the guarantee now splits three ways:
//
//   • the module stays UNRESOLVABLE — `retirement.negative.test-d.ts`, where every
//     `@ts-expect-error` fails the build the moment the error stops occurring, so a
//     resurrection cannot pass silently;
//   • nothing imports it — owned by the compiler (TS2307) and by an Oxlint restricted
//     pattern naming the retired specifier, so a resurrection produces a boundary
//     message rather than a bare "cannot find module";
//   • the substrate the bespoke screens share is still REAL — asserted below at runtime.
//
// The runtime half is what keeps the compile-time half honest. A negative fixture over a
// directory that had been renamed or emptied would pass for the wrong reason; a working
// `core` API proves the neighbourhood the retired shell used to live in still exists.
// `core` is imported rather than the three presenter components because it is plain `.ts`
// with no React dependency, so this stays a node-environment suite.

describe("EntityEditor retirement (DR-5)", () => {
  it("has kept the substrate the bespoke screens still share, working", () => {
    // Not "these modules exist" but "these exports behave", which is strictly more than
    // the six `existsSync` calls this replaces could establish.
    expect(entityKey("p1")).toBe("string:p1");
    expect(entityKey(7)).toBe("number:7");
    expect(sameEntityId("p1", "p1")).toBe(true);
    expect(sameEntityId("p1", "p2")).toBe(false);

    // An unauthored working time is valid; a 08:00-16:00 span less a 30-minute break is
    // 450 paid minutes.
    const unauthored = validateWorkingTimeDraft({});
    expect(unauthored.ok).toBe(true);
    expect(unauthored.issues).toEqual([]);
    expect(paidMinutesFor("08:00", "16:00", 30)).toBe(450);

    // And it REJECTS. Without this half every assertion above would also hold for a
    // stubbed-out validator that returned `{ ok: true, issues: [] }` unconditionally.
    const offGrid = validateWorkingTimeDraft({ startTime: "08:07", endTime: "16:00" });
    expect(offGrid.ok).toBe(false);
    expect(offGrid.issues.map((issue) => issue.field)).toContain("startTime");
    expect(paidMinutesFor("08:07", "16:00", 30)).toBeNull();
  });
});
