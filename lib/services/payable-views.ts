import "server-only"

import { z } from "zod"

import { requireOrgContext } from "@/lib/services/context"
import { requireAuthorization } from "@/lib/services/authorization"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

export const payableViewFiltersSchema = z.object({
  queue: z.enum(["all", "due", "approval", "approved", "paid", "overdue", "due_soon", "needs_review", "payable"]).default("due"),
  search: z.string().trim().max(120).default(""),
  pageSize: z.number().int().min(10).max(100).default(50),
})

export type PayableViewFilters = z.infer<typeof payableViewFiltersSchema>

export interface SavedPayableView {
  id: string
  name: string
  scope: "org" | "project"
  projectId: string | null
  filters: PayableViewFilters
  isDefault: boolean
}

function mapView(row: any): SavedPayableView {
  return {
    id: row.id,
    name: row.name,
    scope: row.scope,
    projectId: row.project_id ?? null,
    filters: payableViewFiltersSchema.parse(row.filters ?? {}),
    isDefault: Boolean(row.is_default),
  }
}

export async function listSavedPayableViews(projectId?: string): Promise<SavedPayableView[]> {
  const { orgId, userId } = await requireOrgContext()
  const supabase = createServiceSupabaseClient()
  let query = supabase.from("saved_payable_views").select("id,name,scope,project_id,filters,is_default").eq("org_id", orgId).eq("user_id", userId)
  query = projectId ? query.eq("scope", "project").eq("project_id", projectId) : query.eq("scope", "org").is("project_id", null)
  const { data, error } = await query.order("is_default", { ascending: false }).order("name")
  if (error) throw new Error(`Failed to load saved payable views: ${error.message}`)
  return (data ?? []).map(mapView)
}

export async function savePayableView(input: { id?: string; name: string; projectId?: string; filters: unknown; isDefault?: boolean }): Promise<SavedPayableView> {
  const { orgId, userId, supabase } = await requireOrgContext()
  await requireAuthorization({ permission: "bill.read", userId, orgId, projectId: input.projectId, supabase, logDecision: true, resourceType: input.projectId ? "project" : "organization", resourceId: input.projectId ?? orgId })
  const name = z.string().trim().min(1).max(80).parse(input.name)
  const filters = payableViewFiltersSchema.parse(input.filters)
  const service = createServiceSupabaseClient()
  const scope = input.projectId ? "project" : "org"
  if (input.isDefault) {
    let clear = service.from("saved_payable_views").update({ is_default: false }).eq("org_id", orgId).eq("user_id", userId).eq("scope", scope)
    clear = input.projectId ? clear.eq("project_id", input.projectId) : clear.is("project_id", null)
    const { error } = await clear
    if (error) throw new Error(`Failed to update the default view: ${error.message}`)
  }
  const payload = { org_id: orgId, user_id: userId, name, scope, project_id: input.projectId ?? null, filters, is_default: Boolean(input.isDefault) }
  const mutation = input.id
    ? service.from("saved_payable_views").update(payload).eq("org_id", orgId).eq("user_id", userId).eq("id", z.string().uuid().parse(input.id))
    : service.from("saved_payable_views").insert(payload)
  const { data, error } = await mutation.select("id,name,scope,project_id,filters,is_default").single()
  if (error) throw new Error(`Failed to save payable view: ${error.message}`)
  return mapView(data)
}

export async function deletePayableView(id: string): Promise<void> {
  const { orgId, userId } = await requireOrgContext()
  const { error } = await createServiceSupabaseClient().from("saved_payable_views").delete().eq("org_id", orgId).eq("user_id", userId).eq("id", z.string().uuid().parse(id))
  if (error) throw new Error(`Failed to delete payable view: ${error.message}`)
}
