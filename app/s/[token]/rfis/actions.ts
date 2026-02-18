"use server"

import { validatePortalToken } from "@/lib/services/portal-access"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { listRfis, createPortalRfi, addRfiResponse, listRfiResponses } from "@/lib/services/rfis"
import { portalRfiInputSchema, rfiResponseInputSchema } from "@/lib/validation/rfis"

export async function loadRfisAction(token: string) {
  const access = await validatePortalToken(token)
  if (!access) throw new Error("Access denied")
  const all = await listRfis(access.org_id, access.project_id)
  if (access.portal_type === "sub" && access.company_id) {
    return all.filter((rfi) => !rfi.assigned_company_id || rfi.assigned_company_id === access.company_id)
  }
  return all
}

export async function createSubPortalRfiAction(token: string, input: unknown) {
  const access = await validatePortalToken(token)
  if (!access || access.portal_type !== "sub") throw new Error("Access denied")
  if (!access.permissions.can_view_rfis || !access.permissions.can_respond_rfis) throw new Error("Access denied")

  const parsed = portalRfiInputSchema.parse(input)
  return createPortalRfi({
    orgId: access.org_id,
    projectId: access.project_id,
    companyId: access.company_id,
    contactId: access.contact_id,
    subject: parsed.subject,
    question: parsed.question,
    priority: parsed.priority,
    dueDate: parsed.due_date ?? null,
  })
}

export async function listSubPortalRfiResponsesAction(token: string, rfiId: string) {
  const access = await validatePortalToken(token)
  if (!access || access.portal_type !== "sub") throw new Error("Access denied")
  if (!access.permissions.can_view_rfis) throw new Error("Access denied")

  const supabase = createServiceSupabaseClient()
  const { data: rfi } = await supabase
    .from("rfis")
    .select("id, org_id, project_id, assigned_company_id")
    .eq("id", rfiId)
    .eq("org_id", access.org_id)
    .eq("project_id", access.project_id)
    .maybeSingle()

  if (!rfi) throw new Error("RFI not found")
  if (rfi.assigned_company_id && access.company_id && rfi.assigned_company_id !== access.company_id) {
    throw new Error("Access denied")
  }

  return listRfiResponses({ orgId: access.org_id, rfiId })
}

export async function addSubPortalRfiResponseAction(token: string, input: unknown) {
  const access = await validatePortalToken(token)
  if (!access || access.portal_type !== "sub") throw new Error("Access denied")
  if (!access.permissions.can_view_rfis || !access.permissions.can_respond_rfis) throw new Error("Access denied")

  const parsed = rfiResponseInputSchema.parse(input)

  const supabase = createServiceSupabaseClient()
  const { data: rfi } = await supabase
    .from("rfis")
    .select("id, org_id, project_id, assigned_company_id")
    .eq("id", parsed.rfi_id)
    .eq("org_id", access.org_id)
    .eq("project_id", access.project_id)
    .maybeSingle()

  if (!rfi) throw new Error("RFI not found")
  if (rfi.assigned_company_id && access.company_id && rfi.assigned_company_id !== access.company_id) {
    throw new Error("Access denied")
  }

  return addRfiResponse({
    orgId: access.org_id,
    input: {
      ...parsed,
      responder_contact_id: access.contact_id ?? parsed.responder_contact_id ?? null,
      responder_user_id: null,
      portal_token_id: access.id,
      created_via_portal: true,
    },
  })
}








