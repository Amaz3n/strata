export type WarrantySeverity = "emergency" | "routine_30" | "routine_60"
export type CoverageStatus = "unclassified" | "in_warranty" | "out_of_warranty" | "goodwill"
export type BackchargeStatus = "draft" | "issued" | "disputed" | "recovered" | "written_off" | "waived"
export type WarrantyVisitOutcome = "resolved" | "needs_followup" | "needs_parts" | "not_warrantable"

/**
 * What a trade may report from the sub portal. `not_warrantable` is a builder
 * coverage determination, not something the crew standing in the house decides,
 * so it is deliberately absent.
 */
export const TRADE_REPORTABLE_OUTCOMES = ["resolved", "needs_followup", "needs_parts"] as const
export type TradeReportableOutcome = (typeof TRADE_REPORTABLE_OUTCOMES)[number]

export interface WarrantyCoverageTerm {
  key: string
  label: string
  duration_months: number
  is_structural: boolean
  description: string | null
}

export interface WarrantyCoverageSnapshotTerm extends WarrantyCoverageTerm {
  expires_on: string
}

export interface WarrantyCoverageLike {
  terms: Array<WarrantyCoverageSnapshotTerm & { expired?: boolean }>
}

export interface WarrantyCostBasisItem {
  label: string
  amount_cents: number
  ref_type?: string
  ref_id?: string
}

function daysInUtcMonth(year: number, monthIndex: number) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate()
}

export function addCalendarMonths(dateValue: string, months: number): string {
  const source = new Date(`${dateValue}T00:00:00.000Z`)
  if (Number.isNaN(source.getTime())) throw new Error("Invalid effective date")
  const totalMonths = source.getUTCFullYear() * 12 + source.getUTCMonth() + months
  const year = Math.floor(totalMonths / 12)
  const month = totalMonths % 12
  const day = Math.min(source.getUTCDate(), daysInUtcMonth(year, month))
  return new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10)
}

export function buildCoverageSnapshot(
  effectiveDate: string,
  terms: WarrantyCoverageTerm[],
): WarrantyCoverageSnapshotTerm[] {
  return terms.map((term) => ({
    ...term,
    expires_on: addCalendarMonths(effectiveDate, term.duration_months),
  }))
}

export function classifyCoverage(
  coverage: WarrantyCoverageLike | null,
  termKey: string | null,
  asOf: Date,
): "in_warranty" | "out_of_warranty" | "unclassified" {
  if (!coverage || !termKey) return "unclassified"
  const term = coverage.terms.find((candidate) => candidate.key === termKey)
  if (!term) return "unclassified"
  const expiresAt = new Date(`${term.expires_on}T23:59:59.999Z`)
  return asOf.getTime() <= expiresAt.getTime() ? "in_warranty" : "out_of_warranty"
}

export function stampWarrantySla(
  createdAt: Date,
  target: { first_response_hours: number; resolution_days: number },
) {
  return {
    first_response_due_at: new Date(createdAt.getTime() + target.first_response_hours * 3_600_000).toISOString(),
    resolution_due_at: new Date(createdAt.getTime() + target.resolution_days * 86_400_000).toISOString(),
  }
}

export function sumWarrantyCostBasis(items: WarrantyCostBasisItem[]) {
  return items.reduce((sum, item) => sum + item.amount_cents, 0)
}

export function validateWarrantyCostBasis(amountCents: number, items: WarrantyCostBasisItem[]) {
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error("Backcharge amount must be positive")
  if (items.length === 0 || items.some((item) => !item.label.trim() || !Number.isInteger(item.amount_cents) || item.amount_cents <= 0)) {
    throw new Error("Backcharge cost basis must contain positive itemized costs")
  }
  if (sumWarrantyCostBasis(items) !== amountCents) throw new Error("Cost basis must equal the backcharge amount")
}

const BACKCHARGE_TRANSITIONS: Record<BackchargeStatus, BackchargeStatus[]> = {
  draft: ["issued", "waived"],
  issued: ["disputed", "recovered", "written_off", "waived"],
  disputed: ["issued", "recovered", "written_off", "waived"],
  recovered: [],
  written_off: [],
  waived: [],
}

export function assertBackchargeTransition(from: BackchargeStatus, to: BackchargeStatus) {
  if (!BACKCHARGE_TRANSITIONS[from].includes(to)) {
    throw new Error(`Backcharge cannot move from ${from} to ${to}`)
  }
}

export function shouldFlagWarrantyCostDump(input: {
  createdAt: Date
  effectiveDate: string | null
  openPunchCount: number
  windowDays?: number
}) {
  if (!input.effectiveDate || input.openPunchCount <= 0) return false
  const effective = new Date(`${input.effectiveDate}T00:00:00.000Z`)
  const elapsedDays = (input.createdAt.getTime() - effective.getTime()) / 86_400_000
  return elapsedDays >= 0 && elapsedDays <= (input.windowDays ?? 60)
}

export function toVendorCreditLines(items: WarrantyCostBasisItem[]) {
  return items.map((item) => ({ ...item, amount_cents: -item.amount_cents }))
}

/**
 * jsonb columns on warranty rows carry independently-owned keys: the SLA sweep
 * owns `sla_breached_at`, intake owns `cost_dump_reason`, verification owns
 * `pending_verification`. Writing the column as a whole object destroys the
 * other owners' keys, so every metadata write merges through here.
 *
 * `undefined` leaves a key untouched; `null` deletes it.
 */
export function mergeMetadata(
  existing: unknown,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const base = existing && typeof existing === "object" && !Array.isArray(existing)
    ? { ...(existing as Record<string, unknown>) }
    : {}
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    if (value === null) delete base[key]
    else base[key] = value
  }
  return base
}

export interface WarrantyInternalCostInput {
  labor_hours?: number | null
  labor_rate_cents?: number | null
  material_cents?: number | null
}

export interface WarrantyInternalCost {
  labor_hours: number | null
  labor_rate_cents: number | null
  internal_labor_cents: number
  internal_material_cents: number
  internal_total_cents: number
}

const MAX_VISIT_LABOR_HOURS = 24

/**
 * Self-performed work is most of a production builder's warranty spend. Cost is
 * captured on the visit as hours × rate plus materials so the benchmark reads
 * real dollars instead of only what was recovered from trades.
 */
export function computeVisitInternalCost(input: WarrantyInternalCostInput): WarrantyInternalCost {
  const hours = input.labor_hours ?? null
  const rateCents = input.labor_rate_cents ?? null
  const materialCents = input.material_cents ?? 0
  if (hours !== null && (!Number.isFinite(hours) || hours < 0 || hours > MAX_VISIT_LABOR_HOURS)) {
    throw new Error(`Labor hours must be between 0 and ${MAX_VISIT_LABOR_HOURS}`)
  }
  if (rateCents !== null && (!Number.isInteger(rateCents) || rateCents < 0)) {
    throw new Error("Labor rate must be a non-negative whole-cent amount")
  }
  if (!Number.isInteger(materialCents) || materialCents < 0) {
    throw new Error("Material cost must be a non-negative whole-cent amount")
  }
  if (hours !== null && hours > 0 && rateCents === null) throw new Error("A labor rate is required when labor hours are recorded")
  const laborCents = hours !== null && rateCents !== null ? Math.round(hours * rateCents) : 0
  return {
    labor_hours: hours,
    labor_rate_cents: rateCents,
    internal_labor_cents: laborCents,
    internal_material_cents: materialCents,
    internal_total_cents: laborCents + materialCents,
  }
}

export interface WarrantyVisitCostSource {
  id: string
  visit_number: number
  assigned_user_name?: string | null
  labor_hours?: number | null
  labor_rate_cents?: number | null
  internal_labor_cents?: number | null
  internal_material_cents?: number | null
}

const MONEY = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

/**
 * Turns the internal cost already recorded on a request's visits into backcharge
 * cost-basis lines. The basis is what a trade disputes, so each line names the
 * visit it came from rather than collapsing into one free-text total.
 */
export function buildCostBasisFromVisits(visits: WarrantyVisitCostSource[]): WarrantyCostBasisItem[] {
  const items: WarrantyCostBasisItem[] = []
  for (const visit of visits) {
    const laborCents = visit.internal_labor_cents ?? 0
    const materialCents = visit.internal_material_cents ?? 0
    const who = visit.assigned_user_name ? ` (${visit.assigned_user_name})` : ""
    if (laborCents > 0) {
      const detail = visit.labor_hours && visit.labor_rate_cents
        ? ` — ${visit.labor_hours} h @ ${MONEY.format(visit.labor_rate_cents / 100)}/h`
        : ""
      items.push({
        label: `Visit ${visit.visit_number} labor${who}${detail}`,
        amount_cents: laborCents,
        ref_type: "warranty_service_visit",
        ref_id: visit.id,
      })
    }
    if (materialCents > 0) {
      items.push({
        label: `Visit ${visit.visit_number} materials${who}`,
        amount_cents: materialCents,
        ref_type: "warranty_service_visit",
        ref_id: visit.id,
      })
    }
  }
  return items
}

export interface OriginatingCommitmentCandidate {
  id: string
  title: string
  contract_number: string | null
  company_id: string | null
  company_name: string | null
  total_cents: number
  status: string
  cost_code_ids: string[]
}

export interface RankedOriginatingCommitment extends OriginatingCommitmentCandidate {
  exact_cost_code: boolean
  same_company: boolean
  rank: number
  match_reason: string
}

/**
 * The backcharge wedge: a warranty defect is only recoverable if it can be tied
 * to the purchase order that bought the work. Exact cost-code match on the
 * responsible trade's own PO is the strongest tie; cost code alone beats trade
 * alone, because the cost code is what the defect actually is.
 */
export function rankOriginatingCommitments(
  candidates: OriginatingCommitmentCandidate[],
  match: { costCodeId?: string | null; companyId?: string | null },
): RankedOriginatingCommitment[] {
  return candidates
    .map((candidate) => {
      const exactCostCode = Boolean(match.costCodeId && candidate.cost_code_ids.includes(match.costCodeId))
      const sameCompany = Boolean(match.companyId && candidate.company_id === match.companyId)
      const rank = exactCostCode && sameCompany ? 0 : exactCostCode ? 1 : sameCompany ? 2 : 3
      const reason = exactCostCode && sameCompany
        ? "Same trade and cost code"
        : exactCostCode
          ? "Cost code match"
          : sameCompany
            ? "Same trade"
            : "No match on trade or cost code"
      return { ...candidate, exact_cost_code: exactCostCode, same_company: sameCompany, rank, match_reason: reason }
    })
    .sort((a, b) => a.rank - b.rank || a.title.localeCompare(b.title))
}

export type WarrantySlaState = "unset" | "met" | "on_track" | "due_soon" | "breached"

const FIRST_RESPONSE_DUE_SOON_MS = 12 * 3_600_000
const RESOLUTION_DUE_SOON_MS = 3 * 86_400_000

/**
 * First response and resolution are two different promises to the homeowner:
 * "we called you back" and "we fixed it". They breach independently and are
 * reported independently.
 */
export function warrantyFirstResponseState(
  request: { first_response_due_at?: string | null; first_responded_at?: string | null },
  asOf: Date,
): WarrantySlaState {
  if (request.first_responded_at) return "met"
  if (!request.first_response_due_at) return "unset"
  const remaining = new Date(request.first_response_due_at).getTime() - asOf.getTime()
  if (remaining < 0) return "breached"
  return remaining <= FIRST_RESPONSE_DUE_SOON_MS ? "due_soon" : "on_track"
}

export function warrantyResolutionState(
  request: { resolution_due_at?: string | null; status?: string | null },
  asOf: Date,
): WarrantySlaState {
  if (request.status === "resolved" || request.status === "closed") return "met"
  if (!request.resolution_due_at) return "unset"
  const remaining = new Date(request.resolution_due_at).getTime() - asOf.getTime()
  if (remaining < 0) return "breached"
  return remaining <= RESOLUTION_DUE_SOON_MS ? "due_soon" : "on_track"
}

export type CourtesyMilestoneKey = "day_30" | "month_11"

export interface CourtesyInspectionMilestone {
  key: CourtesyMilestoneKey
  label: string
  due_on: string
}

/**
 * The two courtesy inspections a production builder owes every buyer: a 30-day
 * shakedown, and an 11-month walk that lands before the workmanship year runs
 * out — late enough to catch a full season, early enough to still be covered.
 */
export function courtesyInspectionSchedule(effectiveDate: string): CourtesyInspectionMilestone[] {
  const start = new Date(`${effectiveDate}T00:00:00.000Z`)
  if (Number.isNaN(start.getTime())) throw new Error("Invalid coverage effective date")
  return [
    { key: "day_30", label: "30-day courtesy inspection", due_on: new Date(start.getTime() + 30 * 86_400_000).toISOString().slice(0, 10) },
    { key: "month_11", label: "11-month courtesy inspection", due_on: addCalendarMonths(effectiveDate, 11) },
  ]
}

/**
 * Milestones worth creating work for right now: due inside the lead window, and
 * not so far past due that enrolling a years-old home would spray the queue.
 */
export function dueCourtesyInspections(
  effectiveDate: string,
  asOf: Date,
  options: { leadDays?: number; graceDays?: number } = {},
): CourtesyInspectionMilestone[] {
  const leadMs = (options.leadDays ?? 14) * 86_400_000
  const graceMs = (options.graceDays ?? 60) * 86_400_000
  return courtesyInspectionSchedule(effectiveDate).filter((milestone) => {
    const dueMs = new Date(`${milestone.due_on}T00:00:00.000Z`).getTime()
    return dueMs <= asOf.getTime() + leadMs && dueMs >= asOf.getTime() - graceMs
  })
}

export interface WarrantyVisitWindow {
  id: string
  window_start: string
  window_end: string
}

/**
 * One technician cannot be in three houses at once. Half-open overlap: a visit
 * that ends exactly when the next begins is back-to-back, not a conflict.
 */
export function findOverlappingVisits<T extends WarrantyVisitWindow>(
  existing: T[],
  candidate: { window_start: string; window_end: string; exclude_visit_id?: string | null },
): T[] {
  const start = new Date(candidate.window_start).getTime()
  const end = new Date(candidate.window_end).getTime()
  return existing.filter((visit) => {
    if (candidate.exclude_visit_id && visit.id === candidate.exclude_visit_id) return false
    return new Date(visit.window_start).getTime() < end && start < new Date(visit.window_end).getTime()
  })
}
