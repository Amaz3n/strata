import { z } from "zod"
import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"
import { getDivisionAccessForUser } from "@/lib/services/authorization"
import { resolveDivisionScope } from "@/lib/land/scope"
import { readAllRows } from "@/lib/land/paging"

const inputSchema = z.object({
  page: z.number().int().min(1).max(100_000).default(1),
  pageSize: z.number().int().min(1).max(100).default(50),
  divisionId: z.string().uuid().nullish(),
  communityId: z.string().uuid().nullish(),
  search: z.string().trim().max(200).default(""),
  status: z.enum(["draft", "sent", "open", "closed", "awarded", "cancelled"]).optional(),
})

type Relation = { name: string } | Array<{ name: string }> | null
function name(relation: Relation) { return (Array.isArray(relation) ? relation[0] : relation)?.name }

export async function listProductionBidQueue(raw: unknown = {}) {
  const input = inputSchema.parse(raw)
  const context = await requireOrgContext()
  await requirePermission("bid.read", context)
  const scope = resolveDivisionScope(await getDivisionAccessForUser(context), input.divisionId)
  if (scope.kind === "none") return { items: [], count: 0 }
  let query = context.supabase.from("bid_packages").select(`
    id,title,status,due_at,community_id,house_plan_id,
    community:communities!bid_packages_community_id_fkey(name,division_id),
    plan:house_plans!bid_packages_house_plan_id_fkey(name,division_id),
    invites:bid_invites!bid_invites_org_package_fk(count)
  `, { count: "exact" }).eq("org_id", context.orgId).eq("award_target", "price_agreement")
    .eq("community.org_id", context.orgId).eq("plan.org_id", context.orgId)
    .or("and(community_id.is.null,plan.not.is.null),and(community.not.is.null,house_plan_id.is.null),and(community.not.is.null,plan.not.is.null)")
    .order("due_at", { ascending: true, nullsFirst: false }).order("id")
  query = input.status ? query.eq("status", input.status) : query.neq("status", "cancelled")
  if (input.search) query = query.ilike("title", `%${input.search.replace(/[\\%_]/g, "\\$&")}%`)
  if (input.communityId) query = query.eq("community_id", input.communityId)
  if (scope.kind === "limited") {
    query = query.in("community.division_id", scope.divisionIds)
      .or(`division_id.is.null,division_id.in.(${scope.divisionIds.join(",")})`, { referencedTable: "plan" })
  }
  const from = (input.page - 1) * input.pageSize
  const first = await query.range(from, from + input.pageSize - 1)
  // A page past the last row is an empty page, not a failure (PostgREST answers 416).
  const pastEnd = first.error?.code === "PGRST103"
  const { error, count } = pastEnd ? await query.range(0, 0) : first
  const data = pastEnd ? null : first.data
  if (error) throw new Error(`Failed to load production bids: ${error.message}`)
  const rows = data ?? []
  const responses = new Map<string, number>()
  if (rows.length) {
    // Restrict response aggregation to this page, never the organization's roster.
    const result = await readAllRows<{ invite: { bid_package_id: string } | Array<{ bid_package_id: string }> }>((from, to) => context.supabase
      .from("bid_submissions").select("invite:bid_invites!bid_submissions_org_invite_fk!inner(bid_package_id)")
      .eq("org_id", context.orgId).eq("is_current", true).in("status", ["submitted", "revised"])
      .in("invite.bid_package_id", rows.map((row) => row.id)).order("id").range(from, to),
    { cap: 100_000, pageSize: 500, label: "Failed to count bid responses" })
    if (result.truncated) throw new Error("Too many responses for this page. Narrow the community filter.")
    for (const row of result.rows) {
      const id = (Array.isArray(row.invite) ? row.invite[0] : row.invite)?.bid_package_id
      if (id) responses.set(id, (responses.get(id) ?? 0) + 1)
    }
  }
  return { count: count ?? 0, items: rows.map((row) => ({
    id: row.id, title: row.title, status: row.status, dueAt: row.due_at,
    jobName: [name(row.community as Relation), name(row.plan as Relation)].filter(Boolean).join(" — ") || "Price book",
    invites: Number(row.invites?.[0]?.count ?? 0), responses: responses.get(row.id) ?? 0,
  })) }
}
