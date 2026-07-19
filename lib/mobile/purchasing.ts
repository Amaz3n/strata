import { z } from "zod"

import { MobileAPIError } from "@/lib/mobile/api"
import type { MobileOrgContext } from "@/lib/mobile/auth"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { hasPermission } from "@/lib/services/permissions"

const mobileVpoSchema = z.object({
  commitment_id: z.string().uuid(),
  reason_code_id: z.string().uuid(),
  amount_cents: z.number().int().refine((value) => value !== 0, "Amount cannot be zero"),
  note: z.string().trim().min(1).max(5000),
  photo_file_ids: z.array(z.string().uuid()).max(20).default([]),
  client_id: z.string().uuid().optional(),
})

async function requireProject(context: MobileOrgContext, projectId: string) {
  const { data, error } = await context.serviceSupabase.from("projects").select("id").eq("org_id", context.orgId).eq("id", projectId).maybeSingle()
  if (error || !data) throw new MobileAPIError(404, "project_not_found", "Project not found.")
}

async function requirePurchasingPermission(context: MobileOrgContext, permission: "price_book.read" | "vpo.request", projectId: string) {
  const allowed = await hasPermission(permission, context.serviceContext)
  if (!allowed) throw new MobileAPIError(403, "purchasing_forbidden", "You do not have permission to use project purchasing.")
}

export async function listMobileVarianceOrders(context: MobileOrgContext, projectId: string) {
  await requireProject(context, projectId)
  await requirePurchasingPermission(context, "price_book.read", projectId)
  const { data, error } = await context.serviceSupabase.from("commitment_change_orders").select(`
    id,project_id,commitment_id,title,description,status,total_cents,reason_code_id,origin,requested_by,photo_file_ids,created_at,updated_at,
    commitment:commitments(title),company:companies(name),reason:variance_reason_codes(code,label,is_backcharge)
  `).eq("org_id", context.orgId).eq("project_id", projectId).not("reason_code_id", "is", null).order("created_at", { ascending: false }).limit(200)
  if (error) throw new MobileAPIError(500, "vpos_unavailable", "Variance purchase orders could not be loaded.")
  return data ?? []
}

export async function createMobileVarianceOrder(context: MobileOrgContext, projectId: string, input: unknown) {
  await requireProject(context, projectId)
  await requirePurchasingPermission(context, "vpo.request", projectId)
  const parsed = mobileVpoSchema.safeParse(input)
  if (!parsed.success) throw new MobileAPIError(422, "invalid_vpo", "Some variance purchase-order information is invalid.", { fields: parsed.error.issues.map((issue) => issue.path.join(".")).join(", ") })
  const [{ data: commitment }, { data: reason }] = await Promise.all([
    context.serviceSupabase.from("commitments").select("id,company_id,title,commitment_type").eq("org_id", context.orgId).eq("project_id", projectId).eq("id", parsed.data.commitment_id).maybeSingle(),
    context.serviceSupabase.from("variance_reason_codes").select("id,label,is_backcharge,is_active").eq("org_id", context.orgId).eq("id", parsed.data.reason_code_id).maybeSingle(),
  ])
  if (!commitment || commitment.commitment_type !== "purchase_order") throw new MobileAPIError(422, "invalid_purchase_order", "Select a purchase order for this project.")
  if (!reason?.is_active) throw new MobileAPIError(422, "invalid_reason_code", "Select an active variance reason.")
  if (reason.is_backcharge && parsed.data.amount_cents > 0) throw new MobileAPIError(422, "invalid_backcharge", "Backcharges must use a negative amount.")
  const id = parsed.data.client_id ?? crypto.randomUUID()
  const { data: existing } = await context.serviceSupabase.from("commitment_change_orders").select("*").eq("org_id", context.orgId).eq("id", id).maybeSingle()
  if (existing) return existing
  const { data, error } = await context.serviceSupabase.from("commitment_change_orders").insert({
    id, org_id: context.orgId, project_id: projectId, commitment_id: commitment.id, company_id: commitment.company_id,
    title: `VPO — ${reason.label}`, description: parsed.data.note, status: "draft", total_cents: parsed.data.amount_cents,
    reason_code_id: reason.id, origin: "field_mobile", requested_by: context.user.id, photo_file_ids: parsed.data.photo_file_ids,
    metadata: { source: "mobile_v1" },
  }).select("*").single()
  if (error || !data) throw new MobileAPIError(500, "vpo_create_failed", "The variance purchase order could not be saved.")
  const { error: lineError } = await context.serviceSupabase.from("commitment_change_order_lines").insert({
    org_id: context.orgId, commitment_change_order_id: id, description: parsed.data.note,
    quantity: 1, unit: "ls", unit_cost_cents: parsed.data.amount_cents, amount_cents: parsed.data.amount_cents, sort_order: 0,
  })
  if (lineError) {
    await context.serviceSupabase.from("commitment_change_orders").delete().eq("org_id", context.orgId).eq("id", id)
    throw new MobileAPIError(500, "vpo_line_create_failed", "The variance purchase order line could not be saved.")
  }
  await recordAudit({ orgId: context.orgId, actorId: context.user.id, action: "insert", entityType: "commitment_change_order", entityId: id, after: data })
  await recordEvent({ orgId: context.orgId, actorId: context.user.id, eventType: "vpo.requested", entityType: "commitment_change_order", entityId: id, payload: { project_id: projectId, origin: "field_mobile", total_cents: parsed.data.amount_cents } })
  return data
}

export async function listMobileVarianceReasonCodes(context: MobileOrgContext, organizationId: string) {
  if (organizationId !== context.orgId) throw new MobileAPIError(403, "organization_forbidden", "The selected organization does not match this request.")
  const { data, error } = await context.serviceSupabase.from("variance_reason_codes").select("id,code,label,description,is_backcharge,requires_photo,sort_order").eq("org_id", context.orgId).eq("is_active", true).order("sort_order").order("label")
  if (error) throw new MobileAPIError(500, "reason_codes_unavailable", "Variance reason codes could not be loaded.")
  return data ?? []
}
