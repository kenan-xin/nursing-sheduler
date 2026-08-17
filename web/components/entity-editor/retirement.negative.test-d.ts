// NEGATIVE TYPE FIXTURES for the EntityEditor retirement (custom-AST ticket 6, row 5).
//
// These replace the `existsSync` half of `retirement.test.ts`. That check asked whether a
// FILE was present at a path; this one asks whether a SPECIFIER RESOLVES TO A MODULE,
// which is the guarantee DR-5 actually makes and which the compiler already owns. It also
// covers spellings a path check cannot see: an extension variant, a directory module with
// an `index`, or a re-export chain all resolve or fail here exactly as an import would.
//
// Every `@ts-expect-error` FAILS THE BUILD if the error stops occurring (TS2578, unused
// `@ts-expect-error`), so each line is a live claim rather than a comment. Checked by the
// ordinary `tsc --noEmit` gate; `.test-d.ts` is not collected by vitest, so nothing here
// executes and no test file is imported into a running suite.
//
// WHAT THIS FILE CANNOT DO. It proves module RESOLUTION, not the absence of an equivalent
// component under a different name. "People and Shift Types are bespoke screens" is a
// design fact owned by their own rendered tests, not by this fixture. The complement here
// is `retirement.test.ts`, which proves the kept substrate is real and working, so a
// vacuous pass caused by a renamed or emptied directory fails there.

// --- the retired shell does not resolve, in either spelling --------------------

// @ts-expect-error TS2307 -- the generic EntityEditor shell is retired (DR-5).
export type RetiredShell = typeof import("./entity-editor");

// @ts-expect-error TS2307 -- and its component test went with it.
export type RetiredShellTest = typeof import("./entity-editor.test");

// --- non-vacuity: the SAME construct resolves for the kept substrate ----------
//
// Without these, a change that broke module resolution for this whole directory would
// make the two assertions above pass for entirely the wrong reason.

export type KeptCore = typeof import("./core");
export type KeptGroupsSection = typeof import("./groups-section").GroupsSection;
export type KeptTransferList = typeof import("./transfer-list").TransferList;
export type KeptWorkingTimeFields = typeof import("./working-time-fields").WorkingTimeFields;

// And a named export, not merely the module, so an emptied file is not a pass.
export type KeptCoreApi = [
  typeof import("./core").entityKey,
  typeof import("./core").validateWorkingTimeDraft,
];
