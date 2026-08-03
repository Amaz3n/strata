import type { Rfi } from "@/lib/types"
import { parseLocalDate } from "@/lib/utils"

/**
 * Which side of an RFI a sub is on.
 *
 * `createPortalRfi` assigns a sub-raised RFI back to the sub's own company,
 * because that column doubles as "which company may read this row". So the
 * assignment alone cannot say who owes the answer — authorship wins. A question
 * the sub asked is never a question the sub has to answer.
 */
export type SubRfiBucket = "needs-you" | "waiting" | "closed"

const OPEN_STATUSES = new Set(["open", "pending"])

export function subRfiBucket(rfi: Rfi, companyId: string | null): SubRfiBucket {
  if (!OPEN_STATUSES.has(rfi.status)) return "closed"
  if (companyId && rfi.submitted_by_company_id === companyId) return "waiting"
  if (companyId && rfi.assigned_company_id === companyId) return "needs-you"
  return "waiting"
}

/** True when the sub raised the question and is waiting on the builder. */
export function isSubRfiAuthor(rfi: Rfi, companyId: string | null): boolean {
  return !!companyId && rfi.submitted_by_company_id === companyId
}

/** Open, owed by the sub, and past its due date. */
export function isSubRfiOverdue(rfi: Rfi, companyId: string | null, now: Date = new Date()): boolean {
  if (subRfiBucket(rfi, companyId) !== "needs-you") return false
  const due = parseLocalDate(rfi.due_date)
  return due !== null && due < now
}
