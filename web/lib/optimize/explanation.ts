// Run explanations from the backend (beads qb5v, a5pb): why a proven-infeasible run has
// no roster. The backend names rules by preference index and people by submitted (maybe
// anonymised) id.

/** One hard rule unit in an infeasibility core: a request cell, a staffing slot, a nurse's cap... */
export interface CoreMember {
  rule: number;
  kind:
    | "request"
    | "leave"
    | "staffing"
    | "skill_mix"
    | "qualification"
    | "cap"
    | "count"
    | "contracted_hours"
    | "succession"
    | "covering"
    | "affinity"
    | "other";
  nurse?: string | number;
  date?: string;
  shift?: string[];
  need?: number;
  expression?: string;
  target?: number;
}

export interface InfeasibleCore {
  members: CoreMember[];
  /** Every member proven necessary within the time budget. */
  minimal: boolean;
  solves: number;
  guards: number;
  seconds: number;
}

export type RunExplanation = {
  kind: "infeasible";
  /** `main_run`, or `feasibility_check:<s>` when a no-objective check proved it. */
  proof: string;
  /** Null when the core solve ran out of time: the run is still proven infeasible. */
  core: InfeasibleCore | null;
};
