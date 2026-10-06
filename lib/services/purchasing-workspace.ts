import { getDivisionAccessForUser } from "@/lib/services/authorization"
import { getAmbientDeskContext } from "@/lib/services/desk-context"
import { resolveDivisionScope } from "@/lib/land/scope"
import { z } from "zod"

import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"
import { listDirectoryPage } from "@/lib/services/directory"
import { loadProjectDirectory } from "@/lib/services/project-directory"
import { requireAuthorization } from "@/lib/services/authorization"
import { listPriceAgreements } from "@/lib/services/price-book"

const lookupSchema = z.object({
  kind: z.enum(["home", "vendor", "community", "plan"]),
  search: z.string().trim().max(200).default(""),
  cursor: z.string().max(4096).optional(),
  page: z.number().int().min(1).max(100_000).default(1),
})

export type PurchasingLookupPage = {
  items: Array<{ id: string; name: string; detail: string }>
  nextCursor: string | null
  nextPage: number | null
}

/** Reuse the directory access rules and database pagination; never load an org's whole roster. */
export async function searchPurchasingEntities(raw: unknown): Promise<PurchasingLookupPage> {
  const input = lookupSchema.parse(raw)
  const context = await requireOrgContext()
  await requirePermission("price_book.read", context)
  if (input.kind === "community" || input.kind === "plan") {
    const [access, ambient] = await Promise.all([getDivisionAccessForUser(context), getAmbientDeskContext()])
    const scope = resolveDivisionScope(access, ambient.divisionId)
    if (scope.kind === "none") return { items: [], nextCursor: null, nextPage: null }
    const pageSize = 25
    let query = context.supabase.from(input.kind === "community" ? "communities" : "house_plans")
      .select("id,name,code").eq("org_id", context.orgId).order("name").order("id")
      .range((input.page - 1) * pageSize, input.page * pageSize)
    if (scope.kind === "limited") {
      query = input.kind === "plan"
        ? query.or(`division_id.is.null,division_id.in.(${scope.divisionIds.join(",")})`)
        : query.in("division_id", scope.divisionIds)
    }
    if (input.search) query = query.ilike("name", `%${input.search.replace(/[\\%_]/g, "\\$&")}%`)
    const { data, error } = await query
    if (error) throw new Error(`Unable to search ${input.kind === "plan" ? "plans" : "communities"}: ${error.message}`)
    return {
      items: (data ?? []).slice(0, pageSize).map((row) => ({ id: row.id, name: row.name, detail: row.code ?? "" })),
      nextCursor: null,
      nextPage: (data ?? []).length > pageSize ? input.page + 1 : null,
    }
  }
  if (input.kind === "home") {
    const { page } = await loadProjectDirectory({ q: input.search, cursor: input.cursor }, context)
    return {
      items: page.rows.map((row) => ({ id: row.id, name: row.name, detail: row.address })),
      nextCursor: page.nextCursor,
      nextPage: null,
    }
  }
  const result = await listDirectoryPage({ kind: "company", page: input.page, pageSize: 25, search: input.search, sort: "name", direction: "asc" })
  return {
    items: result.entries.map((row) => ({ id: row.id, name: row.name, detail: row.trade ?? row.detail ?? "" })),
    nextCursor: null,
    nextPage: result.page * result.pageSize < result.total ? result.page + 1 : null,
  }
}

export async function getPoExceptionCandidates(raw: unknown) {
  const input = z.object({ exceptionId: z.string().uuid(), page: z.number().int().min(1).max(100_000).default(1) }).parse(raw)
  const context = await requireOrgContext()
  await requirePermission("price_book.read", context)
  const { data: exception, error } = await context.supabase.from("po_generation_exceptions")
    .select("project_id,candidates,status").eq("org_id", context.orgId).eq("id", input.exceptionId).maybeSingle()
  if (error || !exception) throw new Error("PO exception not found")
  await requireAuthorization({ permission: "price_book.read", userId: context.userId, orgId: context.orgId, projectId: exception.project_id, supabase: context.supabase, logDecision: true })
  if (exception.status !== "open") throw new Error("This exception is no longer open. Refresh the queue.")
  const ids = z.array(z.string().uuid()).parse(exception.candidates ?? [])
  const pageSize = 25
  const pageIds = ids.slice((input.page - 1) * pageSize, input.page * pageSize)
  const result = pageIds.length ? await listPriceAgreements({ agreementIds: pageIds, pageSize }) : { items: [] }
  return { items: result.items, page: input.page, pages: Math.max(1, Math.ceil(ids.length / pageSize)) }
}
