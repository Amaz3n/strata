import type { GlAccountType } from "@/lib/services/books/types"

/** Owned-property accounting is an explicit project policy, independent of org tier. */
export type InventoryPolicy = { enabled: boolean; effectiveOn: string | null; completedOn: string | null; soldOn: string | null }

/**
 * Where a home's cost lands under its inventory policy. Only construction cost
 * (a cost-of-sales account) is capitalized; a line coded to an operating expense
 * -- a sales commission -- is a period expense whatever the home's stage.
 */
export function inventoryCostAccount(policy: InventoryPolicy | undefined, incurredOn: string, expenseAccount = "5000", accountType: GlAccountType = "cogs") {
  if (accountType !== "cogs") return expenseAccount
  if (!policy?.enabled || !policy.effectiveOn || incurredOn < policy.effectiveOn) return expenseAccount
  if (policy.soldOn && incurredOn >= policy.soldOn) return expenseAccount
  if (policy.completedOn && incurredOn >= policy.completedOn) return "1170"
  return "1160"
}

/**
 * A cost incurred on or after a home's sale is cost of that sold home, expensed
 * in the period it is incurred and labeled so it is never mistaken for ordinary
 * job cost (the closed-home late-cost policy). An operating expense is never one.
 */
export function isClosedHomeCost(policy: InventoryPolicy | undefined, incurredOn: string, accountType: GlAccountType = "cogs") {
  return Boolean(accountType === "cogs" && policy?.enabled && policy.soldOn && incurredOn >= policy.soldOn)
}
