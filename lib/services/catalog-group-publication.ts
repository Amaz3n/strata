import "server-only"
import { z } from "zod"
import { requireOrgContext, type OrgServiceContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { CatalogPublicationUnconfirmedError, registerCatalogPublicationIntent } from "@/lib/services/catalog-package-publication"
import { catalogGroupCategoryReviewSchema, catalogGroupPublicationSchema, catalogGroupSourceSchema, type CatalogGroupPublicationInput } from "@/lib/validation/selections"

const reviewInput = z.object({ expectedOrgId: z.string().uuid(), expectedActorId: z.string().uuid(), communityId: z.string().uuid().nullable(),
  categoryIds: z.array(z.string().uuid().transform(id => id.toLowerCase())).max(100).refine(ids => new Set(ids).size === ids.length, "Choose each category once"),
}).strict()
const reviewReply = z.object({ orgId: z.string().uuid(), actorId: z.string().uuid(), communityId: z.string().uuid().nullable(), categories: z.array(catalogGroupCategoryReviewSchema).max(200) }).strict()
const sequence = z.string().regex(/^[1-9][0-9]{0,18}$/).refine(value => /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n)
const receiptSchema = z.object({ orgId: z.string().uuid(), actorId: z.string().uuid(), receiptId: z.string().uuid(), historySequence: sequence, created: z.boolean(), group: catalogGroupSourceSchema }).strict()

export async function reviewCatalogGroupCategories(raw: unknown) {
  const input = reviewInput.parse(raw), context = await requireOrgContext()
  if (input.expectedOrgId !== context.orgId || input.expectedActorId !== context.userId) throw new Error("Cutoff rule review context changed; reopen under the original organization and user")
  await requirePermission("selections.catalog.manage", context)
  const { data, error } = await createServiceSupabaseClient().rpc("review_catalog_group_categories", { p_org_id: context.orgId, p_actor_id: context.userId, p_community_id: input.communityId, p_ids: input.categoryIds })
  if (error) throw new Error(`Could not review cutoff rule categories: ${error.message}`)
  const parsed = reviewReply.safeParse(data)
  if (!parsed.success || parsed.data.orgId !== context.orgId || parsed.data.actorId !== context.userId || parsed.data.communityId?.toLowerCase() !== input.communityId?.toLowerCase()) throw new Error("Cutoff rule category review reply could not be verified")
  const rows = parsed.data.categories, byId = new Map(rows.map(row => [row.id, row])), references = new Set(input.categoryIds)
  for (const id of input.categoryIds) {
    const row = byId.get(id)
    if (!row || row.definition.is_archived || row.definition.community_id !== null && row.definition.community_id.toLowerCase() !== input.communityId?.toLowerCase()) throw new Error("Reviewed category is unavailable in the original scope")
    const parent = row.definition.parent_category_id
    if (parent) {
      const root = byId.get(parent)
      if (!row.definition.community_id || !root || root.definition.is_archived || root.definition.community_id !== null || root.definition.parent_category_id !== null) throw new Error("Reviewed category ancestry could not be verified")
      references.add(parent)
    }
  }
  if (rows.length !== references.size || rows.some((row, index) => !references.has(row.id) || index > 0 && row.id <= rows[index - 1].id)) throw new Error("Reviewed category coverage or order could not be verified")
  return parsed.data
}

/** Preserve original hashes; never perform a fresh category review while publishing. */
export function catalogGroupRequest(raw: CatalogGroupPublicationInput) {
  const input = catalogGroupPublicationSchema.parse(raw)
  return { id: input.id ?? null, communityId: input.communityId ?? null, name: input.name, scheduleTaskKey: input.scheduleTaskKey,
    cutoffOffsetDays: input.cutoffOffsetDays, cutoffAnchor: input.cutoffAnchor, sortOrder: input.sortOrder,
    categoryIds: [...input.categoryIds].sort(), expectedGroup: input.expectedGroup, expectedCategoryVersions: input.expectedCategoryVersions,
  }
}

export async function publishCatalogGroup(context: OrgServiceContext, raw: unknown) {
  const input = catalogGroupPublicationSchema.parse(raw)
  if (input.expectedOrgId !== context.orgId || input.expectedActorId !== context.userId) throw new Error("Cutoff rule publication context changed; reopen the workspace")
  const request = catalogGroupRequest(input)
  await registerCatalogPublicationIntent(context, "group", input.publicationKey, request)
  const { data, error } = await Promise.resolve(createServiceSupabaseClient().rpc("publish_catalog_group_atomic", { p_org_id: context.orgId, p_actor_id: context.userId, p_key: input.publicationKey, p_request: request }))
    .catch(() => { throw new CatalogPublicationUnconfirmedError("Cutoff rule publication could not be confirmed. Keep the original request and retry it") })
  if (error) throw new CatalogPublicationUnconfirmedError(`Cutoff rule publication could not be confirmed: ${error.message}. Check the original receipt or cancel its registered request`)
  const parsed = receiptSchema.safeParse(data)
  if (!parsed.success) throw new CatalogPublicationUnconfirmedError("Cutoff rule receipt could not be verified. Keep the original request")
  const receipt = parsed.data, saved = receipt.group
  if (receipt.orgId !== context.orgId || receipt.actorId !== context.userId || input.id && saved.id.toLowerCase() !== input.id.toLowerCase()
    || (saved.community_id?.toLowerCase() ?? null) !== (request.communityId?.toLowerCase() ?? null) || saved.name !== request.name || saved.schedule_task_key !== request.scheduleTaskKey
    || saved.cutoff_offset_days !== request.cutoffOffsetDays || saved.cutoff_anchor !== request.cutoffAnchor || saved.sort_order !== request.sortOrder || saved.is_archived
    || JSON.stringify(saved.category_ids.map(id => id.toLowerCase()).sort()) !== JSON.stringify(request.categoryIds.map(id => id.toLowerCase()).sort())) throw new CatalogPublicationUnconfirmedError("Cutoff rule receipt differs from the original reviewed request. Reconcile the saved request")
  return saved
}
