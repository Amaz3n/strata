"use server"

import { actionError, type ActionResult } from "@/lib/action-result"
import { assertPortalActionAccess } from "@/lib/services/portal-access"
import { uploadPortalFile } from "@/lib/services/portal-uploads"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { listRfisForPortal, createPortalRfi, addPortalRfiResponse, listRfiThread } from "@/lib/services/rfis"
import { portalRfiInputSchema, rfiResponseInputSchema } from "@/lib/validation/rfis"
import type { Rfi, RfiThread } from "@/lib/types"

export async function loadRfisAction(token: string) {
  const access = await assertPortalActionAccess(token, {
    portalType: "sub",
    requireCompany: true,
    permission: "can_view_rfis",
  })
  return listRfisForPortal({
    orgId: access.org_id,
    projectId: access.project_id,
    companyId: access.portal_type === "sub" ? (access.company_id ?? null) : null,
    scopedRfiId: access.scoped_rfi_id ?? null,
  })
}

/**
 * Resolves an RFI the caller's token is allowed to read or write. Every action
 * below goes through this — the token scopes the project, the company scopes the
 * row, and drafts are never visible outside the builder.
 */
async function requireRfiInScope(
  access: Awaited<ReturnType<typeof assertPortalActionAccess>>,
  rfiId: string,
) {
  const supabase = createServiceSupabaseClient()
  const { data: rfi } = await supabase
    .from("rfis")
    .select("id, org_id, project_id, status, assigned_company_id, submitted_by_company_id")
    .eq("id", rfiId)
    .eq("org_id", access.org_id)
    .eq("project_id", access.project_id)
    .maybeSingle()

  if (!rfi) throw new Error("This RFI is no longer available.")
  if (rfi.status === "draft") throw new Error("This RFI has not been sent yet.")
  if (access.scoped_rfi_id && rfi.id !== access.scoped_rfi_id) {
    throw new Error("This link only opens one RFI.")
  }
  if (access.portal_type === "sub" && rfi.assigned_company_id && rfi.assigned_company_id !== access.company_id) {
    throw new Error("This RFI belongs to another company.")
  }
  return rfi
}

export async function loadSubPortalRfiThreadAction(
  token: string,
  rfiId: string,
): Promise<ActionResult<RfiThread>> {
  try {
    const access = await assertPortalActionAccess(token, {
      portalType: "sub",
      requireCompany: true,
      permission: "can_view_rfis",
    })
    await requireRfiInScope(access, rfiId)
    return { success: true, data: await listRfiThread({ orgId: access.org_id, rfiId }) }
  } catch (error) {
    return actionError(error, "Could not load this conversation.")
  }
}

export async function createSubPortalRfiAction(
  token: string,
  formData: FormData,
): Promise<ActionResult<Rfi>> {
  try {
    const access = await assertPortalActionAccess(token, {
      portalType: "sub",
      requireCompany: true,
      permission: "can_respond_rfis",
    })
    if (!access.permissions.can_view_rfis) throw new Error("You don't have permission to do that.")
    if (access.scoped_rfi_id) throw new Error("This link only opens one RFI.")

    const dueDate = String(formData.get("due_date") || "")
    const parsed = portalRfiInputSchema.parse({
      subject: String(formData.get("subject") || ""),
      question: String(formData.get("question") || ""),
      priority: String(formData.get("priority") || "normal"),
      due_date: dueDate || null,
    })

    const attachmentFileId = await uploadPortalFile({
      file: formData.get("file") as File | null,
      orgId: access.org_id,
      projectId: access.project_id,
      category: "rfis",
      folderPath: "/rfis",
      metadata: { company_id: access.company_id },
    })

    const rfi = await createPortalRfi({
      orgId: access.org_id,
      projectId: access.project_id,
      companyId: access.company_id,
      contactId: access.contact_id,
      subject: parsed.subject,
      question: parsed.question,
      priority: parsed.priority,
      dueDate: parsed.due_date ?? null,
      attachmentFileId,
    })
    return { success: true, data: rfi }
  } catch (error) {
    return actionError(error, "Could not send your question.")
  }
}

export async function addSubPortalRfiResponseAction(
  token: string,
  formData: FormData,
): Promise<ActionResult<null>> {
  try {
    const access = await assertPortalActionAccess(token, {
      portalType: "sub",
      requireCompany: true,
      permission: "can_respond_rfis",
    })
    if (!access.permissions.can_view_rfis) throw new Error("You don't have permission to do that.")

    const rfiId = String(formData.get("rfi_id") || "")
    const rfi = await requireRfiInScope(access, rfiId)

    // An "answer" closes the question out and hands the ball back to the
    // builder. Only the company the question was put to may do that — on an RFI
    // the sub raised themselves, anything they add is a comment.
    const owesAnswer =
      rfi.assigned_company_id === access.company_id &&
      rfi.submitted_by_company_id !== access.company_id
    const wantsAnswer = String(formData.get("response_type") || "comment") === "answer"

    const parsed = rfiResponseInputSchema.parse({
      rfi_id: rfiId,
      body: String(formData.get("body") || ""),
      response_type: wantsAnswer && owesAnswer ? "answer" : "comment",
    })

    const fileId = await uploadPortalFile({
      file: formData.get("file") as File | null,
      orgId: access.org_id,
      projectId: access.project_id,
      category: "rfis",
      folderPath: "/rfis",
      metadata: { company_id: access.company_id },
    })

    await addPortalRfiResponse({
      orgId: access.org_id,
      responderContactId: access.contact_id ?? null,
      portalTokenId: access.id,
      input: { ...parsed, file_id: fileId },
    })
    return { success: true, data: null }
  } catch (error) {
    return actionError(error, "Could not send your message.")
  }
}
