import { z } from "zod"
import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"
import { getBidPackage } from "@/lib/services/bids"
import { listDirectoryPage } from "@/lib/services/directory"

const inputSchema = z.object({
  packageId: z.string().uuid(),
  search: z.string().trim().max(200).default(""),
  page: z.number().int().min(1).max(100000).default(1),
})

export type BidVendorChoice = { id: string; name: string; detail: string }

/** Recheck package/division access on every request; never ship the whole roster. */
export async function searchProductionBidVendors(raw: unknown) {
  const input = inputSchema.parse(raw)
  const context = await requireOrgContext()
  await requirePermission("bid.read", context)
  const bidPackage = await getBidPackage(input.packageId, context.orgId)
  if (bidPackage.award_target !== "price_agreement") throw new Error("Production bid package not found")
  const result = await listDirectoryPage({ kind: "company", search: input.search, page: input.page, pageSize: 25, sort: "name", direction: "asc" })
  return {
    items: result.entries.map((row): BidVendorChoice => ({ id: row.id, name: row.name, detail: row.trade ?? row.detail ?? "" })),
    more: result.page * result.pageSize < result.total,
  }
}
