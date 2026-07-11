export interface PunchBallInCourtInput {
  status: string
  assigned_company_id?: string | null
  dispatched_at?: string | null
  sub_completed_at?: string | null
}

/**
 * Ball-in-court for a punch item is derived, not stored: the sub owns it from
 * dispatch until they mark work complete; the GC owns verification once it is
 * ready for review. Internal (no company) items have no BIC.
 */
export function derivePunchBallInCourt(
  item: PunchBallInCourtInput,
  companyName?: string | null,
): string | null {
  if (item.status === "closed") return null
  if (item.status === "ready_for_review") return "GC verify"
  if (item.assigned_company_id && item.dispatched_at && !item.sub_completed_at) {
    return companyName ? `Sub — ${companyName}` : "Sub"
  }
  return null
}
