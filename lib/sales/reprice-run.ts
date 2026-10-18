/**
 * Repricing a sheet runs as a series of slices, and a later slice can fail after
 * earlier ones landed. A run therefore fixes its targets (and the price each
 * started from) when it begins, and records which have been sent, so a retry
 * resumes where it stopped instead of re-deriving targets from prices that have
 * already moved — which would apply a percentage twice.
 */

export type RepriceMove = { mode: "percent" | "amount"; value: number }

export interface RepriceTarget {
  availabilityId: string
  /** The price the row showed when the run started. */
  basisCents: number
}

export interface RepriceRun {
  move: RepriceMove
  targets: RepriceTarget[]
  /** Availability ids already sent and answered; never sent again. */
  completed: string[]
}

export function startRepriceRun(move: RepriceMove, targets: RepriceTarget[]): RepriceRun {
  return { move, targets, completed: [] }
}

/** The next batch still owed, in the order the run was started. */
export function nextRepriceSlice(run: RepriceRun, size: number): RepriceTarget[] {
  const done = new Set(run.completed)
  return run.targets.filter((target) => !done.has(target.availabilityId)).slice(0, size)
}

export function completeRepriceSlice(run: RepriceRun, slice: RepriceTarget[]): RepriceRun {
  return { ...run, completed: [...run.completed, ...slice.map((target) => target.availabilityId)] }
}

export function repriceRunRemaining(run: RepriceRun): number {
  return run.targets.length - new Set(run.completed).size
}
