/**
 * A land deal's diligence, judged.
 *
 * The deal stores facts (contract date, diligence end, dropped, its reviews and
 * takedowns); everything a screen says about it -- its stage, how far the
 * checklist has come, whether the deposit is at risk, what changed between two
 * reviewed versions -- is decided here and nowhere else.
 *
 * Pure: no data access, so the desk, the workbench and the deadline sweep
 * cannot disagree.
 */

export const LAND_DEAL_STAGES = ["screening", "diligence", "in_review", "approved", "acquired", "dropped"] as const
export type LandDealStage = (typeof LAND_DEAL_STAGES)[number]

export const LAND_DEAL_STAGE_LABELS: Record<LandDealStage, string> = {
  screening: "Screening",
  diligence: "Diligence",
  in_review: "In review",
  approved: "Approved",
  acquired: "Acquired",
  dropped: "Dropped",
}

export const DILIGENCE_CATEGORIES = [
  "title",
  "survey",
  "environmental",
  "geotechnical",
  "zoning",
  "utilities",
  "access",
  "legal",
  "financial",
  "other",
] as const
export type DiligenceCategory = (typeof DILIGENCE_CATEGORIES)[number]

export const DILIGENCE_CATEGORY_LABELS: Record<DiligenceCategory, string> = {
  title: "Title",
  survey: "Survey",
  environmental: "Environmental",
  geotechnical: "Geotechnical",
  zoning: "Zoning",
  utilities: "Utilities",
  access: "Access",
  legal: "Legal",
  financial: "Financial",
  other: "Other",
}

/** The checklist a new deal can start from: one item per category that matters on most raw land. */
export const DEFAULT_DILIGENCE_CHECKLIST: ReadonlyArray<{ category: DiligenceCategory; title: string }> = [
  { category: "title", title: "Title commitment and exceptions reviewed" },
  { category: "survey", title: "ALTA survey received" },
  { category: "environmental", title: "Phase I environmental site assessment" },
  { category: "geotechnical", title: "Geotechnical report" },
  { category: "zoning", title: "Zoning and entitlement path confirmed" },
  { category: "utilities", title: "Utility availability and capacity letters" },
  { category: "access", title: "Legal and physical access confirmed" },
  { category: "legal", title: "Purchase contract and seller obligations reviewed" },
  { category: "financial", title: "Lot cost and land budget confirmed" },
]

export const DILIGENCE_STATUSES = ["open", "satisfied", "issue", "waived"] as const
export type DiligenceStatus = (typeof DILIGENCE_STATUSES)[number]

export const DILIGENCE_STATUS_LABELS: Record<DiligenceStatus, string> = {
  open: "Open",
  satisfied: "Satisfied",
  issue: "Issue",
  waived: "Waived",
}

export type AcquisitionReviewStatus = "in_review" | "approved" | "rejected" | "superseded" | "withdrawn"
export type AcquisitionDecision = "acquire" | "terminate"

export const ACQUISITION_REVIEW_STATUS_LABELS: Record<AcquisitionReviewStatus, string> = {
  in_review: "In review",
  approved: "Approved",
  rejected: "Returned",
  superseded: "Superseded",
  withdrawn: "Withdrawn",
}

export const ACQUISITION_DECISION_LABELS: Record<AcquisitionDecision, string> = {
  acquire: "Acquire",
  terminate: "Terminate",
}

export interface LandDealStageInput {
  droppedAt: string | null
  contractExecutedOn: string | null
  reviews: ReadonlyArray<{ status: AcquisitionReviewStatus; decision: AcquisitionDecision }>
  takedowns: ReadonlyArray<{ status: "scheduled" | "closed" | "cancelled" }>
}

/**
 * Where a deal is. A closed takedown means the land was bought, whatever else
 * is true; a dropped deal is dead; an open review outranks an older approval
 * (the deal is being decided again); an approved acquire is approved; a signed
 * contract is diligence; anything before that is screening.
 */
export function landDealStage(input: LandDealStageInput): LandDealStage {
  if (input.takedowns.some((takedown) => takedown.status === "closed")) return "acquired"
  if (input.droppedAt) return "dropped"
  if (input.reviews.some((review) => review.status === "in_review")) return "in_review"
  if (input.reviews.some((review) => review.status === "approved" && review.decision === "acquire")) return "approved"
  if (input.contractExecutedOn) return "diligence"
  return "screening"
}

/** Whether an acquire decision on this deal has been approved: the gate a linked takedown closes behind. */
export function hasApprovedAcquisition(
  reviews: ReadonlyArray<{ status: AcquisitionReviewStatus; decision: AcquisitionDecision }>,
): boolean {
  return reviews.some((review) => review.status === "approved" && review.decision === "acquire")
}

export interface DiligenceItemFact {
  status: DiligenceStatus
  dueOn: string | null
}

export interface DiligenceSummary {
  total: number
  satisfied: number
  waived: number
  issues: number
  open: number
  /** Open items past their due date. */
  overdue: number
  /** The earliest due date among open items. */
  nextDueOn: string | null
}

/**
 * How far the checklist has come. An issue is unresolved: it is a finding that
 * still needs a decision, not a pass. Dates are ISO days compared as strings.
 */
export function diligenceSummary(items: ReadonlyArray<DiligenceItemFact>, today: string): DiligenceSummary {
  let satisfied = 0
  let waived = 0
  let issues = 0
  let open = 0
  let overdue = 0
  let nextDueOn: string | null = null
  for (const item of items) {
    if (item.status === "satisfied") satisfied += 1
    else if (item.status === "waived") waived += 1
    else if (item.status === "issue") issues += 1
    else {
      open += 1
      if (item.dueOn) {
        if (item.dueOn < today) overdue += 1
        if (nextDueOn === null || item.dueOn < nextDueOn) nextDueOn = item.dueOn
      }
    }
  }
  return { total: items.length, satisfied, waived, issues, open, overdue, nextDueOn }
}

/** Whole days from `today` to `date` (negative once past). */
export function daysUntil(date: string, today: string): number {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000)
}

export type DeadlineTone = "none" | "fresh" | "aging" | "late"

export interface DiligenceDeadlinePressure {
  /** Days to the end of the feasibility period; null when none is set or the deal is settled. */
  daysToDiligenceEnd: number | null
  /** The deposit that can no longer be recovered by walking away. */
  depositAtRiskCents: number
  tone: DeadlineTone
}

/**
 * The feasibility clock. Until the diligence period ends the deposit is
 * refundable; once it has passed without an approved decision (acquire or
 * terminate) the deposit is at risk. A dropped or acquired deal has no clock.
 * Tone: late once past, aging inside two weeks, fresh before that.
 */
export function diligenceDeadlinePressure(
  deal: {
    stage: LandDealStage
    diligenceEndsOn: string | null
    depositCents: number
    reviews: ReadonlyArray<{ status: AcquisitionReviewStatus }>
  },
  today: string,
): DiligenceDeadlinePressure {
  if (!deal.diligenceEndsOn || deal.stage === "dropped" || deal.stage === "acquired") {
    return { daysToDiligenceEnd: null, depositAtRiskCents: 0, tone: "none" }
  }
  const days = daysUntil(deal.diligenceEndsOn, today)
  const decided = deal.reviews.some((review) => review.status === "approved")
  const depositAtRiskCents = days < 0 && !decided ? deal.depositCents : 0
  const tone: DeadlineTone = days < 0 ? "late" : days <= 14 ? "aging" : "fresh"
  return { daysToDiligenceEnd: days, depositAtRiskCents, tone }
}

/** The tone of an item's due date, on the same ramp. */
export function dueTone(dueOn: string | null, status: DiligenceStatus | "open" | "met" | "waived", today: string): DeadlineTone {
  if (!dueOn || status !== "open") return "none"
  const days = daysUntil(dueOn, today)
  return days < 0 ? "late" : days <= 7 ? "aging" : "fresh"
}

// ---------------------------------------------------------------------------
// Reviewed versions.
// ---------------------------------------------------------------------------

export interface AcquisitionSnapshot {
  decision: AcquisitionDecision
  terms: Record<string, string | number | null>
  items: ReadonlyArray<{
    id: string
    title: string
    category: string
    status: string
    finding: string | null
    due_on: string | null
    waived_reason: string | null
  }>
  evidence: ReadonlyArray<{ item_id: string; file_id: string; file_name: string; checksum: string | null }>
  takedowns: ReadonlyArray<{ id: string; name: string; status: string }>
}

export type SnapshotChange =
  | { kind: "decision"; from: string; to: string }
  | { kind: "term"; field: string; from: string | number | null; to: string | number | null }
  | { kind: "item_added"; itemId: string; title: string }
  | { kind: "item_removed"; itemId: string; title: string }
  | { kind: "item_changed"; itemId: string; title: string; fields: string[] }
  | { kind: "evidence_added"; itemId: string; fileName: string }
  | { kind: "evidence_removed"; itemId: string; fileName: string }

const ITEM_FIELDS = ["title", "category", "status", "finding", "due_on", "waived_reason"] as const

/**
 * What moved between two reviewed versions: the terms, the checklist and the
 * documents. This is what makes "reviewed versions" legible -- an approver of
 * r3 sees exactly what is different from the r2 that was returned.
 */
export function diffAcquisitionSnapshots(previous: AcquisitionSnapshot, next: AcquisitionSnapshot): SnapshotChange[] {
  const changes: SnapshotChange[] = []
  if (previous.decision !== next.decision) changes.push({ kind: "decision", from: previous.decision, to: next.decision })

  const fields = [...new Set([...Object.keys(previous.terms), ...Object.keys(next.terms)])].sort()
  for (const field of fields) {
    const from = previous.terms[field] ?? null
    const to = next.terms[field] ?? null
    if (String(from) !== String(to)) changes.push({ kind: "term", field, from, to })
  }

  const before = new Map(previous.items.map((item) => [item.id, item]))
  const after = new Map(next.items.map((item) => [item.id, item]))
  for (const item of next.items) {
    const prior = before.get(item.id)
    if (!prior) {
      changes.push({ kind: "item_added", itemId: item.id, title: item.title })
      continue
    }
    const moved = ITEM_FIELDS.filter((field) => (prior[field] ?? null) !== (item[field] ?? null))
    if (moved.length > 0) changes.push({ kind: "item_changed", itemId: item.id, title: item.title, fields: moved })
  }
  for (const item of previous.items) {
    if (!after.has(item.id)) changes.push({ kind: "item_removed", itemId: item.id, title: item.title })
  }

  const evidenceKey = (entry: { item_id: string; file_id: string; checksum: string | null }) =>
    `${entry.item_id}:${entry.file_id}:${entry.checksum ?? ""}`
  const priorEvidence = new Set(previous.evidence.map(evidenceKey))
  const nextEvidence = new Set(next.evidence.map(evidenceKey))
  for (const entry of next.evidence) {
    if (!priorEvidence.has(evidenceKey(entry))) {
      changes.push({ kind: "evidence_added", itemId: entry.item_id, fileName: entry.file_name })
    }
  }
  for (const entry of previous.evidence) {
    if (!nextEvidence.has(evidenceKey(entry))) {
      changes.push({ kind: "evidence_removed", itemId: entry.item_id, fileName: entry.file_name })
    }
  }
  return changes
}

/**
 * The deadline thresholds the sweep announces at, and the marker it leaves in
 * the row's metadata so each threshold fires once. The tightest crossed and
 * not yet announced threshold wins; past due keeps the `0` key, so it is
 * announced once.
 */
export function pendingReminderThreshold(
  thresholds: ReadonlyArray<number>,
  daysOut: number,
  metadata: Record<string, unknown>,
  keyFor: (days: number) => string,
): number | null {
  const ordered = [...thresholds].sort((a, b) => a - b)
  const crossed = ordered.filter((days) => daysOut <= days)
  if (crossed.length === 0) return null
  const tightest = crossed[0]
  return metadata[keyFor(tightest)] ? null : tightest
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {}
}

function list(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : []
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

function scalar(value: unknown): string | number | null {
  return typeof value === "string" || typeof value === "number" ? value : null
}

/**
 * A stored snapshot, read defensively. The database froze it, so its shape is
 * known, but it arrives as JSON: anything unexpected reads as absent rather
 * than as a cast.
 */
export function readAcquisitionSnapshot(value: unknown): AcquisitionSnapshot {
  const root = record(value)
  const terms = record(root.terms)
  return {
    decision: root.decision === "terminate" ? "terminate" : "acquire",
    terms: Object.fromEntries(Object.entries(terms).map(([key, entry]) => [key, scalar(entry)])),
    items: list(root.items).map((item) => ({
      id: String(item.id ?? ""),
      title: String(item.title ?? ""),
      category: String(item.category ?? "other"),
      status: String(item.status ?? "open"),
      finding: textOrNull(item.finding),
      due_on: textOrNull(item.due_on),
      waived_reason: textOrNull(item.waived_reason),
    })),
    evidence: list(root.evidence).map((entry) => ({
      item_id: String(entry.item_id ?? ""),
      file_id: String(entry.file_id ?? ""),
      file_name: String(entry.file_name ?? ""),
      checksum: textOrNull(entry.checksum),
    })),
    takedowns: list(root.takedowns).map((takedown) => ({
      id: String(takedown.id ?? ""),
      name: String(takedown.name ?? ""),
      status: String(takedown.status ?? ""),
    })),
  }
}
