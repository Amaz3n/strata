import "server-only"
import { z } from "zod"
import type { OrgServiceContext } from "@/lib/services/context"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { CatalogPublicationUnconfirmedError, registerCatalogPublicationIntent } from "@/lib/services/catalog-package-publication"
import { catalogPricePublicationSchema } from "@/lib/validation/selections"

const savedPriceSchema = z.object({
  id: z.string().uuid(), option_id: z.string().uuid().nullable(), package_id: z.string().uuid().nullable(),
  house_plan_version_id: z.string().uuid(), community_id: z.string().uuid().nullable(),
  price_cents: z.number().int().min(0).max(2147483647), cost_cents: z.number().int().min(0).max(2147483647).nullable().optional(), is_available: z.boolean(),
})
const receiptSchema = z.object({ orgId: z.string().uuid(), receiptId: z.string().uuid(), created: z.boolean(), prices: z.array(savedPriceSchema).min(1).max(500) })

export function catalogPriceRequest(input: z.infer<typeof catalogPricePublicationSchema>) {
  return {
    communityId: input.communityId?.toLowerCase() ?? null,
    items: input.items.map(item => ({ optionId: item.optionId?.toLowerCase() ?? null, packageId: item.packageId?.toLowerCase() ?? null,
      housePlanVersionId: item.housePlanVersionId.toLowerCase(), priceCents: item.priceCents, isAvailable: item.isAvailable,
      expectedPrice: item.expectedPrice ? { ...item.expectedPrice, id: item.expectedPrice.id.toLowerCase() } : null, ...(item.costCents !== undefined ? { costCents: item.costCents } : {}),
    })).sort((a,b) => `${a.optionId ?? a.packageId}:${a.housePlanVersionId}`.localeCompare(`${b.optionId ?? b.packageId}:${b.housePlanVersionId}`)),
  }
}

export async function publishCatalogPriceBatch(context: OrgServiceContext, input: z.infer<typeof catalogPricePublicationSchema>) {
  const request = catalogPriceRequest(input)
  await registerCatalogPublicationIntent(context, "prices", input.publicationKey, request)
  const { data, error } = await Promise.resolve(createServiceSupabaseClient().rpc("publish_catalog_prices_atomic", {
    p_org_id: context.orgId, p_actor_id: context.userId, p_key: input.publicationKey, p_request: request,
  })).catch(() => { throw new CatalogPublicationUnconfirmedError("Price publication is unconfirmed. Retry the same reviewed batch") })
  if (error) {
    if (error.code && /^[0-9A-Z]{5}$/.test(error.code)) throw new CatalogPublicationUnconfirmedError(`Price publication was rejected: ${error.message}. The original request remains registered; check its receipt or cancel it before another save`)
    throw new CatalogPublicationUnconfirmedError("Price publication is unconfirmed. Retry the same reviewed batch")
  }
  const receipt = receiptSchema.safeParse(data)
  if (!receipt.success || receipt.data.orgId !== context.orgId || receipt.data.prices.length !== request.items.length) throw new CatalogPublicationUnconfirmedError("Price publication reply could not be verified. Retry the same reviewed batch")
  const seen = new Set<string>()
  for (const saved of receipt.data.prices) {
    const key = `${saved.option_id ?? saved.package_id}:${saved.house_plan_version_id}`
    const reviewed = request.items.find(item => (item.optionId ?? item.packageId) === (saved.option_id ?? saved.package_id) && item.housePlanVersionId === saved.house_plan_version_id)
    if (!reviewed || seen.has(key) || saved.option_id !== reviewed.optionId || saved.package_id !== reviewed.packageId
      || saved.community_id !== request.communityId || saved.price_cents !== reviewed.priceCents || saved.is_available !== reviewed.isAvailable
      || (reviewed.costCents !== undefined && saved.cost_cents !== reviewed.costCents)) throw new CatalogPublicationUnconfirmedError("Published prices differ from the reviewed batch. Reconcile the save")
    seen.add(key)
  }
  return { receiptId: receipt.data.receiptId, count: receipt.data.prices.length }
}
