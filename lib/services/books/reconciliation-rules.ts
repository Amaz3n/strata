/**
 * The pure rules behind the reconciliation spine.
 *
 * Kept out of `reconciliation.ts` for the same reason `posting-rules.ts` is kept
 * out of the ledger service: this is where the money decisions are made, and they
 * are testable only if they do not need a database.
 */

/**
 * Categories emitted by the ledger tie-outs.
 *
 * The close checklist keeps dedicated blocking checks for the job-cost, AR, and AP
 * tie-outs, so its catch-all `accounting_drift` gate excludes these to avoid failing a
 * close twice for one underlying problem. Widening what the spine writes must never
 * silently widen what blocks a close.
 */
export const TIE_OUT_ITEM_CATEGORIES = [
  "tie_out_trial_balance",
  "tie_out_balance_sheet",
  "tie_out_job_cost_control",
  "tie_out_ar_control",
  "tie_out_ap_control",
  "tie_out_retainage_receivable_control",
  "tie_out_retainage_payable_control",
  "tie_out_customer_deposits_control",
  "tie_out_debt_register_control",
  "tie_out_fixed_assets_control",
  "tie_out_accumulated_depreciation_control",
] as const

/**
 * Categories no sweep of the org's own records can produce.
 *
 * These are written by the nightly projection repair (`books-maintenance`), which
 * is the only thing that knows whether a source record still fails to project. The
 * spine must leave them alone: resolving a finding it cannot reproduce would clear
 * a real, unfixed problem every night.
 */
export const PROJECTION_ITEM_CATEGORIES = [
  "projection_blocked_by_closed_period",
  "projection_failed",
] as const

/**
 * One finding, as produced by a sweep. A finding is a *current* observation; its
 * persisted status is decided by the lifecycle below, never by the producer.
 */
export type ReconciliationFinding = {
  category: string
  entityType?: string
  entityId?: string
  /**
   * Disambiguates two findings that share a category and an entity. The project
   * integrity checks emit several distinct exceptions per project under one kind,
   * and without this they would collapse onto one row.
   */
  findingKey?: string
  /** Arc's side of the comparison — the general ledger, for a tie-out. */
  localAmountCents?: number
  /** What Arc is being tied to: a subledger, or an external accounting system. */
  externalAmountCents?: number
  differenceCents?: number
  details: Record<string, unknown>
}

/** The four dispositions the table's check constraint allows. */
export type ReconciliationItemStatus = "open" | "explained" | "resolved" | "ignored"

export type PersistedReconciliationItem = {
  id: string
  category: string
  entityType: string | null
  entityId: string | null
  findingKey: string | null
  status: ReconciliationItemStatus
  differenceCents: number | null
}

export type ReconciliationSyncPlan = {
  insert: ReconciliationFinding[]
  carryForward: Array<{
    id: string
    finding: ReconciliationFinding
    status: ReconciliationItemStatus
    reopened: boolean
  }>
  /** Rows the sweep no longer reproduces, plus duplicates of a live finding. */
  resolveIds: string[]
  /** Findings a person has not seen before: newly opened, or reopened. */
  newFindingCount: number
}

function findingIdentity(
  item: Pick<ReconciliationFinding, "category" | "entityType" | "entityId" | "findingKey">,
) {
  return `${item.category}:${item.entityType ?? ""}:${item.entityId ?? ""}:${item.findingKey ?? ""}`
}

function persistedIdentity(item: PersistedReconciliationItem) {
  return `${item.category}:${item.entityType ?? ""}:${item.entityId ?? ""}:${item.findingKey ?? ""}`
}

/**
 * The item lifecycle.
 *
 * Items used to be write-only: every run inserted its findings and nothing ever
 * closed them, so the blocking `accounting_drift` close check — which counted open
 * rows across all runs, all time — could never go green again once an org had a
 * single discrepancy. Curing the underlying problem did nothing; last night's row
 * stayed open forever, and tonight's run added another one beside it.
 *
 * A finding therefore has a stable identity, and each run reconciles the persisted
 * set against what it just observed:
 *
 *  - **recurs** → the existing row carries forward onto this run with fresh amounts;
 *    a human disposition (`explained`, `ignored`) survives, because that is the point
 *    of accepting a known difference.
 *  - **no longer reproduces** → resolved by the machine. The caller leaves
 *    `resolved_by` null, which is what distinguishes it from a person closing it.
 *  - **an accepted difference changes size** → reopened. The amount somebody signed
 *    off on is not the amount in front of them now.
 *  - **duplicates** → every extra row sharing one identity is resolved, which is also
 *    how the backlog accumulated by the write-only era drains on the first pass.
 *
 * Resolution is per occurrence: a finding that returns after being resolved opens a
 * NEW row rather than resurrecting the closed one, so the trail keeps when each
 * occurrence was seen — and `existing` is therefore only ever the unresolved set.
 */
export function planReconciliationItemSync(args: {
  findings: ReconciliationFinding[]
  existing: PersistedReconciliationItem[]
  ownsCategory: (category: string) => boolean
}): ReconciliationSyncPlan {
  const owned = args.existing.filter((item) => args.ownsCategory(item.category))
  const byIdentity = new Map<string, PersistedReconciliationItem[]>()
  for (const item of owned) {
    const key = persistedIdentity(item)
    byIdentity.set(key, [...(byIdentity.get(key) ?? []), item])
  }

  const insert: ReconciliationFinding[] = []
  const carryForward: ReconciliationSyncPlan["carryForward"] = []
  const resolveIds: string[] = []
  const seen = new Set<string>()

  for (const finding of args.findings) {
    if (!args.ownsCategory(finding.category)) continue
    const key = findingIdentity(finding)
    if (seen.has(key)) continue
    seen.add(key)
    const [canonical, ...duplicates] = byIdentity.get(key) ?? []
    for (const duplicate of duplicates) resolveIds.push(duplicate.id)
    if (!canonical) {
      insert.push(finding)
      continue
    }
    const differenceCents = finding.differenceCents ?? null
    const reopened = canonical.status !== "open" && canonical.differenceCents !== differenceCents
    carryForward.push({ id: canonical.id, finding, status: reopened ? "open" : canonical.status, reopened })
  }

  for (const item of owned) {
    if (seen.has(persistedIdentity(item))) continue
    resolveIds.push(item.id)
  }

  return {
    insert,
    carryForward,
    resolveIds,
    newFindingCount: insert.length + carryForward.filter((row) => row.reopened).length,
  }
}

/**
 * A run that could not look everywhere is not a clean run.
 *
 * `PROJECT_CHECK_CAP` bounds how much of a large org one pass inspects, and a
 * truncated pass that found nothing used to report `passed` — a clean bill of health
 * for projects it never opened.
 */
export function reconciliationRunStatus(args: { itemCount: number; projectsSkipped: number }) {
  if (args.itemCount > 0) return "warning" as const
  return args.projectsSkipped > 0 ? ("warning" as const) : ("passed" as const)
}

/**
 * Which projection failures a person can actually act on.
 *
 * The closed-period guard is its own cure: a bill edited after its period closed
 * makes the projector try to reverse an entry it is forbidden to touch, and that
 * fails identically on every pass, forever. Retrying is not a fix — someone has to
 * post an adjusting entry or reopen the period — so it is surfaced as its own item
 * rather than buried in a generic failure list nobody reads.
 */
export function classifyProjectionFailure(error: string) {
  return error.includes("Cannot post into a closed accounting period")
    ? ("projection_blocked_by_closed_period" as const)
    : ("projection_failed" as const)
}

/**
 * Retainage withheld on the pay applications vs. retainage the books carry.
 *
 * `prime_sov_lines.retainage_held_cents` is what a G702 shows the owner; the
 * `retainage` table is what Books, the AR retainage tie-out and the billing desk
 * show. Both are maintained by hand-written service code on different paths, and
 * nothing compared them — they can drift indefinitely with no alarm.
 *
 * Only contracts that actually have a schedule of values are compared: a residential
 * contract holds retainage without any SOV line, and measuring it against zero would
 * report every one of them as broken.
 */
export function planRetainageControlFindings(args: {
  sovLines: Array<{
    contract_id: string
    project_id: string
    retainage_held_cents: number | null
    retainage_released_cents: number | null
  }>
  heldRetainage: Array<{ contract_id: string; amount_cents: number | null }>
}): ReconciliationFinding[] {
  const sovByContract = new Map<string, { projectId: string; netCents: number }>()
  for (const line of args.sovLines) {
    const contractId = String(line.contract_id)
    const current = sovByContract.get(contractId) ?? { projectId: String(line.project_id), netCents: 0 }
    current.netCents += Number(line.retainage_held_cents ?? 0) - Number(line.retainage_released_cents ?? 0)
    sovByContract.set(contractId, current)
  }
  const heldByContract = new Map<string, number>()
  for (const row of args.heldRetainage) {
    const contractId = String(row.contract_id)
    heldByContract.set(contractId, (heldByContract.get(contractId) ?? 0) + Number(row.amount_cents ?? 0))
  }

  const findings: ReconciliationFinding[] = []
  for (const [contractId, sov] of sovByContract) {
    const heldCents = heldByContract.get(contractId) ?? 0
    const differenceCents = sov.netCents - heldCents
    if (differenceCents === 0) continue
    findings.push({
      category: "retainage_control",
      entityType: "contract",
      entityId: contractId,
      localAmountCents: sov.netCents,
      externalAmountCents: heldCents,
      differenceCents,
      details: {
        severity: "critical",
        project_id: sov.projectId,
        description:
          "Retainage held on the schedule of values does not match the retainage ledger the books read",
        href: `/projects/${sov.projectId}/financials/receivables`,
      },
    })
  }
  return findings
}
