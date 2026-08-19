/**
 * Commitment position math — pure.
 *
 * A commitment's money lives across three tables: the commitment itself, the
 * change orders that revise it, and the vendor bills that draw it down. Every
 * surface that reports a commitment (vendor register, project budget, payables)
 * composes the position through here, so the same contract never reads two
 * different balances. Kept free of Supabase on purpose: this is how the money
 * gets tested.
 */

export type CommitmentBillStatus = string

/** The bill facts the position depends on, as stored. */
export interface CommitmentBillRow {
  commitment_id?: string | null
  status?: CommitmentBillStatus | null
  total_cents?: number | null
  paid_cents?: number | null
  retainage_cents?: number | null
  metadata?: Record<string, unknown> | null
}

export interface CommitmentChangeOrderRow {
  commitment_id?: string | null
  status?: string | null
  total_cents?: number | null
}

export interface CommitmentBillRollup {
  /** Non-draft, non-rejected bills, net of vendor credits. */
  billed: number
  /** The slice of `billed` in the books. */
  approvedBilled: number
  /** Cash out against the contract; credits do not pay a contract down. */
  paid: number
  retainageHeld: number
  /** Bills excluding vendor credits. */
  billCount: number
}

export interface CommitmentChangeOrderTotals {
  approved: number
  pending: number
}

/** The composed position, added onto whatever commitment shape came in. */
export interface CommitmentPosition {
  billed_cents: number
  approved_billed_cents: number
  pending_billed_cents: number
  paid_cents: number
  retainage_held_cents: number
  bill_count: number
  approved_change_orders_cents: number
  pending_change_orders_cents: number
  revised_total_cents: number
  /** Revised total less invoiced. Signed — negative means over-billed. */
  remaining_cents: number
}

export interface CommitmentPositionInput {
  total_cents?: number
  status?: string
  commitment_type?: string
  executed_at?: string
}

/** Bill statuses that have landed in the books. */
const BOOKED_BILL_STATUSES: ReadonlySet<string> = new Set(["approved", "partial", "paid"])

/** Change order statuses whose value lands only if they are approved. */
export const PENDING_CHANGE_ORDER_STATUSES = ["draft", "sent"] as const

export const emptyCommitmentBillRollup = (): CommitmentBillRollup => ({
  billed: 0,
  approvedBilled: 0,
  paid: 0,
  retainageHeld: 0,
  billCount: 0,
})

export const emptyCommitmentChangeOrderTotals = (): CommitmentChangeOrderTotals => ({
  approved: 0,
  pending: 0,
})

function isDraftBill(metadata: Record<string, unknown> | null | undefined) {
  return (metadata ?? {}).creation_state === "draft"
}

function isVendorCredit(metadata: Record<string, unknown> | null | undefined) {
  return (metadata ?? {}).source === "vendor_credit"
}

/**
 * A payable still being drafted is not yet a claim on the contract, and a
 * rejected one never was. Credits carry negative totals, so they net the claim
 * down by construction.
 */
export function summarizeCommitmentBillRows(rows: CommitmentBillRow[]) {
  const rollups = new Map<string, CommitmentBillRollup>()

  for (const bill of rows) {
    const commitmentId = bill.commitment_id
    if (!commitmentId) continue
    if (isDraftBill(bill.metadata)) continue
    if (String(bill.status) === "rejected") continue

    const credit = isVendorCredit(bill.metadata)
    const total = Number(bill.total_cents ?? 0)
    const booked = BOOKED_BILL_STATUSES.has(String(bill.status))
    const rollup = rollups.get(commitmentId) ?? emptyCommitmentBillRollup()

    rollup.billed += total
    if (booked) rollup.approvedBilled += total
    if (!credit) {
      rollup.paid += Number(bill.paid_cents ?? 0)
      if (booked) rollup.retainageHeld += Math.max(0, Number(bill.retainage_cents ?? 0))
      rollup.billCount += 1
    }
    rollups.set(commitmentId, rollup)
  }

  return rollups
}

export function bucketCommitmentChangeOrderRows(rows: CommitmentChangeOrderRow[]) {
  const totals = new Map<string, CommitmentChangeOrderTotals>()

  for (const row of rows) {
    const commitmentId = row.commitment_id
    if (!commitmentId) continue
    const status = String(row.status)
    const pending = (PENDING_CHANGE_ORDER_STATUSES as readonly string[]).includes(status)
    if (status !== "approved" && !pending) continue

    const current = totals.get(commitmentId) ?? emptyCommitmentChangeOrderTotals()
    if (status === "approved") current.approved += Number(row.total_cents ?? 0)
    else current.pending += Number(row.total_cents ?? 0)
    totals.set(commitmentId, current)
  }

  return totals
}

export function composeCommitmentPosition<T extends CommitmentPositionInput>(
  commitment: T,
  bills: CommitmentBillRollup,
  changeOrders: CommitmentChangeOrderTotals,
): T & CommitmentPosition {
  const revisedTotal = (commitment.total_cents ?? 0) + changeOrders.approved
  return {
    ...commitment,
    billed_cents: bills.billed,
    approved_billed_cents: bills.approvedBilled,
    pending_billed_cents: bills.billed - bills.approvedBilled,
    paid_cents: bills.paid,
    retainage_held_cents: bills.retainageHeld,
    bill_count: bills.billCount,
    approved_change_orders_cents: changeOrders.approved,
    pending_change_orders_cents: changeOrders.pending,
    revised_total_cents: revisedTotal,
    remaining_cents: revisedTotal - bills.billed,
  }
}

/** An approved subcontract with nobody's signature on it is an exception. */
export function isCommitmentAwaitingExecution(commitment: CommitmentPositionInput) {
  return (
    commitment.commitment_type === "subcontract" &&
    String(commitment.status).toLowerCase() === "approved" &&
    !commitment.executed_at
  )
}

// ============================================================================
// Register composition
// ============================================================================

export type CommitmentRegisterFlag = "over_billed" | "awaiting_execution" | "pending_change_orders"

export const COMMITMENT_REGISTER_FLAGS: readonly CommitmentRegisterFlag[] = [
  "over_billed",
  "awaiting_execution",
  "pending_change_orders",
]

export interface CommitmentRegisterQuery {
  types?: string[]
  statuses?: string[]
  projectId?: string
  flag?: CommitmentRegisterFlag
  page?: number
  pageSize?: number
}

/** Money across the rows the current filters select, not just the visible page. */
export interface CommitmentRegisterRollup {
  commitment_count: number
  original_cents: number
  approved_change_orders_cents: number
  pending_change_orders_cents: number
  committed_cents: number
  billed_cents: number
  pending_billed_cents: number
  paid_cents: number
  retainage_held_cents: number
  remaining_cents: number
}

/**
 * Counts across the vendor's whole register regardless of filters, so the
 * exception chips stay a stable way in rather than shifting under the filter.
 */
export interface CommitmentRegisterExceptions {
  over_billed: number
  awaiting_execution: number
  pending_change_orders: number
}

export interface CommitmentRegisterFacets {
  projects: { id: string; name: string }[]
  statuses: string[]
  types: string[]
}

export interface CommitmentRegisterPagination {
  page: number
  pageSize: number
  total: number
  pageCount: number
}

export interface CommitmentRegisterRow extends CommitmentPositionInput, CommitmentPosition {
  id: string
  project_id: string
  project_name?: string
}

export interface CommitmentRegisterResult<T> {
  rows: T[]
  rollup: CommitmentRegisterRollup
  exceptions: CommitmentRegisterExceptions
  pagination: CommitmentRegisterPagination
  facets: CommitmentRegisterFacets
  truncated: boolean
}

export const COMMITMENT_REGISTER_PAGE_SIZE = 50
const MAX_REGISTER_PAGE_SIZE = 200
const STATUS_ORDER = ["draft", "approved", "complete", "canceled"]

export function matchesCommitmentRegisterFlag(
  commitment: CommitmentPositionInput & Pick<CommitmentPosition, "remaining_cents" | "pending_change_orders_cents">,
  flag: CommitmentRegisterFlag,
) {
  switch (flag) {
    case "over_billed":
      return commitment.remaining_cents < 0
    case "awaiting_execution":
      return isCommitmentAwaitingExecution(commitment)
    case "pending_change_orders":
      return commitment.pending_change_orders_cents !== 0
  }
}

const emptyRollup = (): CommitmentRegisterRollup => ({
  commitment_count: 0,
  original_cents: 0,
  approved_change_orders_cents: 0,
  pending_change_orders_cents: 0,
  committed_cents: 0,
  billed_cents: 0,
  pending_billed_cents: 0,
  paid_cents: 0,
  retainage_held_cents: 0,
  remaining_cents: 0,
})

/**
 * Filter, face, total and page a composed set of commitments. Done over the
 * composed set rather than in the database because a commitment's position is
 * assembled from three tables and so cannot be sorted or counted there.
 */
export function buildCommitmentRegister<T extends CommitmentRegisterRow>(
  commitments: T[],
  query: CommitmentRegisterQuery = {},
  truncated = false,
): CommitmentRegisterResult<T> {
  const projectNames = new Map<string, string>()
  const statuses = new Set<string>()
  const types = new Set<string>()
  const exceptions: CommitmentRegisterExceptions = {
    over_billed: 0,
    awaiting_execution: 0,
    pending_change_orders: 0,
  }

  for (const commitment of commitments) {
    if (commitment.project_id) {
      projectNames.set(commitment.project_id, commitment.project_name ?? "Project")
    }
    statuses.add(String(commitment.status))
    if (commitment.commitment_type) types.add(commitment.commitment_type)
    for (const flag of COMMITMENT_REGISTER_FLAGS) {
      if (matchesCommitmentRegisterFlag(commitment, flag)) exceptions[flag] += 1
    }
  }

  const typeFilter = query.types && query.types.length > 0 ? new Set(query.types) : null
  const statusFilter = query.statuses && query.statuses.length > 0 ? new Set(query.statuses) : null
  const filtered = commitments.filter((commitment) => {
    if (typeFilter && !typeFilter.has(String(commitment.commitment_type))) return false
    if (statusFilter && !statusFilter.has(String(commitment.status))) return false
    if (query.projectId && commitment.project_id !== query.projectId) return false
    if (query.flag && !matchesCommitmentRegisterFlag(commitment, query.flag)) return false
    return true
  })

  const rollup = filtered.reduce<CommitmentRegisterRollup>((totals, commitment) => {
    totals.commitment_count += 1
    totals.original_cents += commitment.total_cents ?? 0
    totals.approved_change_orders_cents += commitment.approved_change_orders_cents
    totals.pending_change_orders_cents += commitment.pending_change_orders_cents
    totals.committed_cents += commitment.revised_total_cents
    totals.billed_cents += commitment.billed_cents
    totals.pending_billed_cents += commitment.pending_billed_cents
    totals.paid_cents += commitment.paid_cents
    totals.retainage_held_cents += commitment.retainage_held_cents
    totals.remaining_cents += commitment.remaining_cents
    return totals
  }, emptyRollup())

  const pageSize = Math.min(
    Math.max(1, Math.trunc(query.pageSize ?? COMMITMENT_REGISTER_PAGE_SIZE)),
    MAX_REGISTER_PAGE_SIZE,
  )
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
  const page = Math.min(Math.max(1, Math.trunc(query.page ?? 1)), pageCount)

  return {
    rows: filtered.slice((page - 1) * pageSize, page * pageSize),
    rollup,
    exceptions,
    pagination: { page, pageSize, total: filtered.length, pageCount },
    facets: {
      projects: Array.from(projectNames, ([id, name]) => ({ id, name })).sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
      statuses: Array.from(statuses).sort(
        (a, b) => STATUS_ORDER.indexOf(a) - STATUS_ORDER.indexOf(b),
      ),
      types: Array.from(types).sort(),
    },
    truncated,
  }
}
