import type { SupabaseClient } from "@supabase/supabase-js"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

type Context = { supabase: SupabaseClient; orgId: string }
type Access = { assignedOnly: boolean; divisionIds: string[] }

/** Resolve only referenced parents, not an organization's complete project roster. */
export async function visibleBidParentIds(table: "projects" | "communities" | "house_plans", ids: string[], context: Context, access: Access) {
  const visible = new Set<string>()
  const unique = [...new Set(ids)]
  for (let offset = 0; offset < unique.length; offset += 100) {
    let query = context.supabase.from(table).select("id").eq("org_id", context.orgId).in("id", unique.slice(offset, offset + 100))
    if (access.assignedOnly) query = table === "house_plans"
      ? query.or(`division_id.is.null,division_id.in.(${access.divisionIds.join(",")})`)
      : query.in("division_id", access.divisionIds)
    const { data, error } = await query
    if (error) throw new Error(`Unable to verify bid history visibility: ${error.message}`)
    for (const row of data ?? []) visible.add(row.id)
  }
  return visible
}

export async function visibleBidPackageIds(ids: string[], context: Context, access: Access) {
  const unique = [...new Set(ids)]
  const packages: Array<{ id: string; project_id: string | null; community_id: string | null; house_plan_id: string | null }> = []
  for (let offset = 0; offset < unique.length; offset += 100) {
    const chunk = unique.slice(offset, offset + 100)
    const { data, error } = await context.supabase.from("bid_packages").select("id,project_id,community_id,house_plan_id")
      .eq("org_id", context.orgId).in("id", chunk)
    if (error) throw new Error(`Unable to resolve bid history packages: ${error.message}`)
    const rows = data ?? []
    if (rows.length !== chunk.length) {
      // The division wall hides packages outside a member's divisions or assigned
      // homes: a package that exists but is unreadable is simply not theirs. One
      // that does not exist at all means the history does not add up.
      const read = new Set(rows.map((row) => row.id))
      const unread = chunk.filter((packageId) => !read.has(packageId))
      const { data: existing, error: existingError } = await createServiceSupabaseClient()
        .from("bid_packages").select("id").eq("org_id", context.orgId).in("id", unread)
      if (existingError) throw new Error(`Unable to resolve bid history packages: ${existingError.message}`)
      if ((existing ?? []).length !== unread.length) throw new Error("Bid history references missing packages")
    }
    packages.push(...rows)
  }
  const [projects, communities, plans] = await Promise.all([
    visibleBidParentIds("projects", packages.flatMap((row) => row.project_id ? [row.project_id] : []), context, access),
    visibleBidParentIds("communities", packages.flatMap((row) => row.community_id ? [row.community_id] : []), context, access),
    visibleBidParentIds("house_plans", packages.flatMap((row) => row.house_plan_id ? [row.house_plan_id] : []), context, access),
  ])
  return new Set(packages.filter((row) =>
    (!row.project_id || projects.has(row.project_id)) && (!row.community_id || communities.has(row.community_id)) &&
    (!row.house_plan_id || plans.has(row.house_plan_id)) &&
    (!access.assignedOnly || Boolean(row.project_id || row.community_id)),
  ).map((row) => row.id))
}
