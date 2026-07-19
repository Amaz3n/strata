export type WarrantySeverity = "emergency" | "routine_30" | "routine_60"
export type CoverageStatus = "unclassified" | "in_warranty" | "out_of_warranty" | "goodwill"
export type BackchargeStatus = "draft" | "issued" | "disputed" | "recovered" | "written_off" | "waived"

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
