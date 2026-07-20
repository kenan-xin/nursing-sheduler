// T16d — public surface of the optimization progress chart.
//
// The chart accepts already-normalized `RunProgressPoint[]` from the T16a run
// view model. Range/domain/format/scale helpers are re-exported for tests and
// for T16e's screen composition, which may want to introspect the same slice.

export { ProgressChart, DOT_THRESHOLD, type ProgressChartProps } from "./progress-chart";
export {
  RANGE_PRESETS,
  getDomain,
  getVisibleRange,
  shouldShowDots,
  type RangePreset,
  type RangePresetDef,
  type VisibleRange,
  type Domain,
} from "./range";
export {
  formatCompact,
  formatComments,
  formatElapsedSeconds,
  formatScore,
  formatSolutionIndex,
  MISSING_VALUE_TEXT,
} from "./format";
export {
  autoDomain,
  createLinearScale,
  generateTicks,
  pixelToScale,
  scaleToPixel,
  type LinearScale,
} from "./scales";
