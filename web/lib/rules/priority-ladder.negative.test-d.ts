// NEGATIVE TYPE FIXTURE for the priority ladder (bead rnrt, spec section 7).
//
// `LadderRules` is a mapped type over every card kind in `CardsByKind` plus requests,
// so a ladder that leaves one kind out is a COMPILE error. A new card kind added to
// `CardsByKind` therefore fails `tsc --noEmit` at `LADDER` until it is placed in a tier.
//
// Checked by `tsc --noEmit`; `.test-d.ts` is not collected by vitest. If the type ever
// stops requiring every kind, the `@ts-expect-error` below becomes the error.

import { LADDER, type LadderRules } from "./priority-ladder";

const { coverings, ...withoutCoverings } = LADDER;

// Positive control: the full ladder, rebuilt from its parts, is a `LadderRules`.
const complete: LadderRules = { ...withoutCoverings, coverings };
void complete;

// @ts-expect-error a ladder with no tier rule for supervision cards is incomplete.
const incomplete: LadderRules = withoutCoverings;
void incomplete;

const { requests: _requests, ...withoutRequests } = LADDER;
// @ts-expect-error requests are placed on the ladder too.
const noRequests: LadderRules = withoutRequests;
void noRequests;
