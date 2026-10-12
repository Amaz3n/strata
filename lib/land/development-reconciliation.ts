/**
 * Development cost reconciled to phases and lots.
 *
 * A development job is an ordinary project: its budget, commitments and posted
 * job cost are the job's. Books moves that cost onto lots through reviewed
 * allocations. This lines the two up — what the job planned, committed and
 * spent; how much of it reached lots; what is still sitting on the job — for
 * every phase the job develops.
 *
 * Pure, so the money rules are tested here and the service only reads rows.
 *
 * - Actual cost is GROSS job cost. Posting an allocation writes a negative
 *   `inventory_event` job cost row on the job (the cost left it for the lots);
 *   summing it would report actual = spent − allocated and hide the allocation
 *   twice. Those rows are excluded here, and allocations are read on their own.
 * - Unallocated = actual − allocated, shown as is. A negative figure means more
 *   reached the lots than the job recorded, and is flagged, not clamped.
 * - A job may serve several phases. Its budget, commitments and actual are the
 *   job's, reported once per job; allocations land on each phase by its lots.
 */

/** Job cost rows that are allocations of cost out to lots, not cost incurred. */
export const ALLOCATION_COST_SOURCE_TYPE = "inventory_event"

export interface DevelopmentPhaseInput {
  id: string
  developmentProjectId: string | null
}

export interface DevelopmentJobInput {
  projectId: string
  budgetCents: number
  committedCents: number
}

export interface DevelopmentCostEntryInput {
  projectId: string
  sourceType: string | null
  costCents: number
}

export interface DevelopmentAllocationInput {
  projectId: string
  status: "proposed" | "approved" | "rejected"
  shares: ReadonlyArray<{ lotId: string; amountCents: number }>
}

export interface DevelopmentLotInput {
  id: string
  phaseId: string | null
  delivered: boolean
}

export type DevelopmentFlag = "over_budget" | "allocated_exceeds_actual" | "delivered_without_allocation"

export interface DevelopmentJobLedger {
  projectId: string
  phaseIds: string[]
  budgetCents: number
  committedCents: number
  actualCents: number
  allocatedCents: number
  unallocatedCents: number
  flags: DevelopmentFlag[]
}

export interface DevelopmentPhaseLedger {
  phaseId: string
  projectId: string | null
  /** Other phases the same job develops: its job figures are shared with them. */
  sharedWithPhaseIds: string[]
  lots: number
  deliveredLots: number
  /** Development cost allocated onto this phase's lots. */
  allocatedCents: number
  flags: DevelopmentFlag[]
}

export function reconcileDevelopment(input: {
  phases: readonly DevelopmentPhaseInput[]
  jobs: readonly DevelopmentJobInput[]
  costEntries: readonly DevelopmentCostEntryInput[]
  allocations: readonly DevelopmentAllocationInput[]
  lots: readonly DevelopmentLotInput[]
}): { jobs: DevelopmentJobLedger[]; phases: DevelopmentPhaseLedger[] } {
  const lotPhase = new Map(input.lots.map((lot) => [lot.id, lot.phaseId]))
  const phasesByJob = new Map<string, string[]>()
  for (const phase of input.phases) {
    if (!phase.developmentProjectId) continue
    phasesByJob.set(phase.developmentProjectId, [...(phasesByJob.get(phase.developmentProjectId) ?? []), phase.id])
  }

  const actualByJob = new Map<string, number>()
  for (const entry of input.costEntries) {
    if (entry.sourceType === ALLOCATION_COST_SOURCE_TYPE) continue
    actualByJob.set(entry.projectId, (actualByJob.get(entry.projectId) ?? 0) + entry.costCents)
  }

  const allocatedByJob = new Map<string, number>()
  const allocatedByPhase = new Map<string, number>()
  for (const allocation of input.allocations) {
    if (allocation.status !== "approved") continue
    for (const share of allocation.shares) {
      allocatedByJob.set(allocation.projectId, (allocatedByJob.get(allocation.projectId) ?? 0) + share.amountCents)
      const phaseId = lotPhase.get(share.lotId)
      if (phaseId) allocatedByPhase.set(phaseId, (allocatedByPhase.get(phaseId) ?? 0) + share.amountCents)
    }
  }

  const jobs = input.jobs
    .filter((job) => phasesByJob.has(job.projectId))
    .map((job): DevelopmentJobLedger => {
      const actualCents = actualByJob.get(job.projectId) ?? 0
      const allocatedCents = allocatedByJob.get(job.projectId) ?? 0
      const flags: DevelopmentFlag[] = []
      if (job.budgetCents > 0 && actualCents > job.budgetCents) flags.push("over_budget")
      if (allocatedCents > actualCents) flags.push("allocated_exceeds_actual")
      return {
        projectId: job.projectId,
        phaseIds: phasesByJob.get(job.projectId) ?? [],
        budgetCents: job.budgetCents,
        committedCents: job.committedCents,
        actualCents,
        allocatedCents,
        unallocatedCents: actualCents - allocatedCents,
        flags,
      }
    })
  const jobById = new Map(jobs.map((job) => [job.projectId, job]))

  const phases = input.phases.map((phase): DevelopmentPhaseLedger => {
    const phaseLots = input.lots.filter((lot) => lot.phaseId === phase.id)
    const deliveredLots = phaseLots.filter((lot) => lot.delivered).length
    const allocatedCents = allocatedByPhase.get(phase.id) ?? 0
    const job = phase.developmentProjectId ? jobById.get(phase.developmentProjectId) : undefined
    const flags: DevelopmentFlag[] = []
    if (job && deliveredLots > 0 && allocatedCents === 0 && job.actualCents > 0) flags.push("delivered_without_allocation")
    return {
      phaseId: phase.id,
      projectId: phase.developmentProjectId,
      sharedWithPhaseIds: (job?.phaseIds ?? []).filter((id) => id !== phase.id),
      lots: phaseLots.length,
      deliveredLots,
      allocatedCents,
      flags,
    }
  })

  return { jobs, phases }
}
