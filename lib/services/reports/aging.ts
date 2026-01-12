import { daysBetweenDateOnly, todayIsoDateOnly } from "@/lib/services/reports/dates"

export type AgingBucket = "current" | "1_30" | "31_60" | "61_90" | "90_plus" | "paid" | "no_due_date"

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
  if (daysPastDue <= 30) return { bucket: "1_30", daysPastDue }
  if (daysPastDue <= 60) return { bucket: "31_60", daysPastDue }
  if (daysPastDue <= 90) return { bucket: "61_90", daysPastDue }
  return { bucket: "90_plus", daysPastDue }
}

