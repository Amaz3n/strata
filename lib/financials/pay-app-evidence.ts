/** Subcontract progress is supporting evidence; it never posts owner billing. */
export interface PayApplicationProgressEvidence {
  primeSovLineId: string
  sourceBillIds: string[]
  sourceBillNumbers: string[]
  throughDate: string
  workCompletedCents: number
  storedMaterialsCents: number
  subcontractScheduledCents: number
  suggestedPercentComplete: number | null
  note: string
}

export interface ApprovedSovEvidenceRow {
  billId: string
  billNumber: string
  billDate: string
  approvedAt: string
  commitmentSovLineId: string
  budgetLineId: string
  previousWorkCents: number
  currentWorkCents: number
  storedMaterialsCents: number
  scheduledCents: number
}

export function buildPayApplicationProgressEvidence(
  primeLines: Array<{ id: string; budget_line_id: string | null; budget_line_ids?: string[] }>,
  rows: ApprovedSovEvidenceRow[],
): PayApplicationProgressEvidence[] {
  const latest = new Map<string, ApprovedSovEvidenceRow>()
  for (const row of rows) {
    const prior = latest.get(row.commitmentSovLineId)
    if (!prior || `${row.billDate}:${row.approvedAt}:${row.billId}` > `${prior.billDate}:${prior.approvedAt}:${prior.billId}`) {
      latest.set(row.commitmentSovLineId, row)
    }
  }
  return primeLines.flatMap((line) => {
    const budgetIds = line.budget_line_ids?.length ? line.budget_line_ids : line.budget_line_id ? [line.budget_line_id] : []
    if (!budgetIds.length) return []
    const sources = [...latest.values()].filter((row) => budgetIds.includes(row.budgetLineId))
    if (!sources.length) return []
    const scheduled = sources.reduce((sum, row) => sum + row.scheduledCents, 0)
    const completed = sources.reduce((sum, row) => sum + row.previousWorkCents + row.currentWorkCents, 0)
    const unambiguous = !primeLines.some((other) => other.id !== line.id &&
      (other.budget_line_ids?.length ? other.budget_line_ids : other.budget_line_id ? [other.budget_line_id] : []).some((id) => budgetIds.includes(id)))
    return [{
      primeSovLineId: line.id, sourceBillIds: [...new Set(sources.map((row) => row.billId))],
      sourceBillNumbers: [...new Set(sources.map((row) => row.billNumber))],
      throughDate: sources.map((row) => row.billDate).sort().at(-1)!,
      workCompletedCents: completed,
      storedMaterialsCents: sources.reduce((sum, row) => sum + row.storedMaterialsCents, 0),
      subcontractScheduledCents: scheduled,
      suggestedPercentComplete: unambiguous && scheduled > 0 ? Math.round(Math.min(100, Math.max(0, completed / scheduled * 100)) * 100) / 100 : null,
      note: unambiguous
        ? "Based on approved subcontract SOV work in this budget bucket. Confirm scope coverage and field progress; subcontract cost is not the owner billing value."
        : "This budget bucket maps to multiple owner SOV lines. Allocate verified progress between them before billing.",
    }]
  })
}
