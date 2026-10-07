import "server-only"

import { authorize } from "@/lib/services/authorization"
import type { OrgServiceContext } from "@/lib/services/context"

/**
 * One worker's pay on a ledger line: native payroll postings carry
 * `payroll_worker_id`, labor costed from time entries `labor_worker_id`.
 * Reading it is reading that person's wages, which Arc reserves to whoever may
 * read private payroll records (`books.adjust`, as for private payroll files).
 * Everyone else with Books read sees the same money merged per entry, account
 * and project, with the worker removed.
 */
export const RESTRICTED_WORKER_PAY = "Payroll and labor (worker detail restricted)"

export function isWorkerPayLine(dimensions: unknown) {
  return Boolean(dimensions && typeof dimensions === "object" &&
    (Reflect.get(dimensions, "payroll_worker_id") || Reflect.get(dimensions, "labor_worker_id")))
}

export async function canReadWorkerPay(context: Pick<OrgServiceContext, "orgId" | "userId" | "supabase">) {
  const decision = await authorize({ permission: "books.adjust", userId: context.userId, orgId: context.orgId, supabase: context.supabase, resourceType: "payroll_detail", resourceId: context.orgId })
  return decision.allowed && decision.divisionScope !== "assigned"
}

/**
 * Worker-pay lines of one entry, account and project become one line in the
 * position of the first; every other line is untouched, so totals are exact.
 */
export function mergeWorkerPay<T>(items: T[], line: {
  isWorkerPay: (item: T) => boolean
  groupKey: (item: T) => string
  merge: (into: T, item: T) => T
  redact: (item: T) => T
}) {
  const merged: T[] = []
  const position = new Map<string, number>()
  for (const item of items) {
    if (!line.isWorkerPay(item)) { merged.push(item); continue }
    const key = line.groupKey(item)
    const at = position.get(key)
    if (at === undefined) { position.set(key, merged.length); merged.push(line.redact(item)) }
    else merged[at] = line.merge(merged[at], item)
  }
  return merged
}
