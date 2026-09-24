import { FLOW_CASES } from "./flows.case";
import { REGRESSION_CASES } from "./regressions.case";
import { REPAIR_CASES } from "./repair.case";
import { SAFETY_CASES } from "./safety.case";
import { SINGAPORE_CASES } from "./singapore.case";

export const ALL_CASES = [
  ...REPAIR_CASES,
  ...FLOW_CASES,
  ...SINGAPORE_CASES,
  ...SAFETY_CASES,
  ...REGRESSION_CASES,
];
