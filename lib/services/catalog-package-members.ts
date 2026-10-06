import "server-only"
import { z } from "zod"
import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

const inputSchema = z.object({ expectedOrgId: z.string().uuid(), expectedActorId: z.string().uuid(), communityId: z.string().uuid().transform(value => value.toLowerCase()).nullable().optional(), query: z.string().trim().max(200).transform(value => value.toLowerCase()).default(""), cursor: z.string().uuid().nullable().optional(), selectedIds: z.array(z.string().uuid().transform(value => value.toLowerCase())).max(100).refine(ids => new Set(ids).size === ids.length).nullable().optional() }).strict().refine(value => value.selectedIds == null || !value.cursor && value.query === "", "Selected lookup cannot use a search cursor")
const memberSchema = z.object({ id: z.string().uuid(), name: z.string().max(200).nullable(), categoryId: z.string().uuid().nullable(), categoryKey: z.string().uuid().nullable(), categoryName: z.string().max(200).nullable(), available: z.boolean() }).strict()
const pageSchema = z.object({ orgId: z.string().uuid(), actorId: z.string().uuid(), communityId: z.string().uuid().nullable(), query: z.string(), selectedIds: z.array(z.string().uuid()).nullable(), items: z.array(memberSchema).max(100), nextCursor: z.string().uuid().nullable() })
export type CatalogPackageMemberPage = z.infer<typeof pageSchema>
export async function discoverCatalogPackageMembers(raw: unknown): Promise<CatalogPackageMemberPage> {
  const input = inputSchema.parse(raw), context = await requireOrgContext()
  if (input.expectedOrgId !== context.orgId || input.expectedActorId !== context.userId) throw new Error("Catalog member context changed; reload the workspace")
  await requirePermission("selections.catalog.manage", context)
  if (process.env.ARC_CATALOG_ATOMIC_PUBLICATION_ENABLED !== "true") throw new Error("Catalog member discovery requires the approved publication cutover")
  const { data, error } = await createServiceSupabaseClient().rpc("discover_catalog_package_members", { p_org_id: context.orgId, p_actor_id: context.userId, p_community_id: input.communityId ?? null, p_query: input.query, p_before: input.cursor ?? null, p_ids: input.selectedIds ?? null })
  if (error) throw new Error(`Could not discover catalog members: ${error.message}`)
  const parsed = pageSchema.safeParse(data)
  if (!parsed.success || parsed.data.orgId !== context.orgId || parsed.data.actorId !== context.userId || parsed.data.communityId !== (input.communityId ?? null) || parsed.data.query !== input.query) throw new Error("Catalog member scope could not be verified")
  const page = parsed.data, selected = input.selectedIds ?? null, last = page.items.at(-1)
  if (new Set(page.items.map(row => row.id.toLowerCase())).size !== page.items.length || page.items.some((row,index) => index > 0 && row.id.toLowerCase() <= page.items[index-1].id.toLowerCase() || row.available && (!row.name || !row.categoryId || !row.categoryKey || !row.categoryName))) throw new Error("Catalog member identity or eligibility could not be verified")
  if (selected !== null ? (page.nextCursor !== null || page.items.length !== selected.length || JSON.stringify([...(page.selectedIds ?? [])].sort()) !== JSON.stringify([...selected].sort()) || page.items.some(row => !selected.includes(row.id.toLowerCase()))) : (page.selectedIds !== null || page.items.length > 20 || page.items.some(row => !row.available || input.cursor && row.id.toLowerCase() <= input.cursor.toLowerCase()) || page.nextCursor && (page.items.length !== 20 || page.nextCursor !== last?.id))) throw new Error("Catalog member continuation could not be verified")
  return page
}
