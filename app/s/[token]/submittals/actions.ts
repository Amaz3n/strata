"use server"

import { assertPortalActionAccess, loadSubPortalData } from "@/lib/services/portal-access"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { addSubmittalItem, listSubmittalItems } from "@/lib/services/submittals"
import { uploadPortalFile } from "@/lib/services/portal-uploads"
import { portalSubmittalItemSchema } from "@/lib/validation/submittals"

export async function loadSubmittalsAction(token: string) {
  const access = await assertPortalActionAccess(token, {
    portalType: "sub",
    requireCompany: true,
    permission: "can_view_submittals",
  })
  if (!access.company_id) throw new Error("Access denied")

  const data = await loadSubPortalData({
    orgId: access.org_id,
    projectId: access.project_id,
    companyId: access.company_id,
    permissions: access.permissions,
  })
  return data.submittals
}

async function assertSubmittalInPortalScope(
  access: { org_id: string; project_id: string; company_id?: string | null },
  submittalId: string,
) {
  const supabase = createServiceSupabaseClient()
  const { data: submittal } = await supabase
    .from("submittals")
    .select("id, org_id, project_id, status, assigned_company_id, superseded_by_id")
    .eq("id", submittalId)
    .eq("org_id", access.org_id)
    .eq("project_id", access.project_id)
    .maybeSingle()

  if (!submittal) throw new Error("Submittal not found")
  // Sub tokens may only touch submittals assigned to their company —
  // unassigned submittals are internal and never exposed to the sub portal.
  if (!submittal.assigned_company_id || submittal.assigned_company_id !== access.company_id) {
    throw new Error("Access denied")
  }
  return submittal
}

export async function listSubPortalSubmittalItemsAction(token: string, submittalId: string) {
  const access = await assertPortalActionAccess(token, {
    portalType: "sub",
    requireCompany: true,
    permission: "can_view_submittals",
  })
  await assertSubmittalInPortalScope(access, submittalId)
  return listSubmittalItems({ orgId: access.org_id, submittalId })
}

export async function submitSubPortalSubmittalItemAction(token: string, formData: FormData) {
  const access = await assertPortalActionAccess(token, {
    portalType: "sub",
    requireCompany: true,
    permission: "can_submit_submittals",
  })
  if (!access.permissions.can_view_submittals) throw new Error("Access denied")

  const parsed = portalSubmittalItemSchema.parse({
    submittal_id: String(formData.get("submittal_id") || ""),
    description: String(formData.get("description") || ""),
    manufacturer: String(formData.get("manufacturer") || "") || undefined,
    model_number: String(formData.get("model_number") || "") || undefined,
  })

  const submittal = await assertSubmittalInPortalScope(access, parsed.submittal_id)
  if (submittal.superseded_by_id) {
    throw new Error("This revision has been superseded — submit on the latest revision")
  }

  const fileId = await uploadPortalFile({
    file: formData.get("file") as File | null,
    orgId: access.org_id,
    projectId: access.project_id,
    category: "submittals",
    folderPath: "/submittals",
    metadata: { company_id: access.company_id },
  })

  await addSubmittalItem({
    orgId: access.org_id,
    input: {
      submittal_id: parsed.submittal_id,
      description: parsed.description,
      manufacturer: parsed.manufacturer,
      model_number: parsed.model_number,
      file_id: fileId,
      portal_token_id: access.id,
      created_via_portal: true,
      responder_user_id: null,
      responder_contact_id: access.contact_id ?? null,
    },
  })

  return { success: true }
}
