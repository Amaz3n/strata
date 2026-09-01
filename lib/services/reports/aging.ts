import { agingBucketIndex } from "@/lib/financials/invoice-lifecycle"
import { daysBetweenDateOnly, todayIsoDateOnly } from "@/lib/services/reports/dates"

export type AgingBucket = "current" | "1_30" | "31_60" | "61_90" | "90_plus" | "paid" | "no_due_date"

/** Report bucket names in the order of the shared 1–30 / 31–60 / 61–90 / 90+ ladder. */
const PAST_DUE_BUCKETS = ["1_30", "31_60", "61_90", "90_plus"] as const

export function getAgingBucket({
  dueDate,
  asOf,
  isPaid,
}: {
  dueDate?: string | null
  asOf?: string
  isPaid?: boolean
}): { bucket: AgingBucket; daysPastDue: number } {
  if (isPaid) return { bucket: "paid", daysPastDue: 0 }
  if (!dueDate) return { bucket: "no_due_date", daysPastDue: 0 }

  const asOfDate = asOf ?? todayIsoDateOnly()
  const days = daysBetweenDateOnly(dueDate, asOfDate)
  const daysPastDue = Math.max(0, days ?? 0)

  if (days != null && days <= 0) return { bucket: "current", daysPastDue: 0 }
  // The ladder edges live in one place so this report, the project aging strip and
  // the invoice queue cannot drift a day apart from each other.
  const index = agingBucketIndex(daysPastDue)
  return { bucket: index === null ? "current" : PAST_DUE_BUCKETS[index], daysPastDue }
}

