"use server"

import { assertPortalActionAccess } from "@/lib/services/portal-access"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { addPortalRfiResponse, listRfiResponses } from "@/lib/services/rfis"
import {
  applyReviewStepDecision,
  listReviewStepsForReviewer,
  listSubmittalItems,
} from "@/lib/services/submittals"
import { uploadPortalFile } from "@/lib/services/portal-uploads"
import { rfiResponseInputSchema } from "@/lib/validation/rfis"
import { decideSubmittalReviewStepSchema } from "@/lib/validation/submittals"

/**
 * A reviewer token may reach an RFI when it is scoped to it, assigned to the
 * reviewer's company, routed to the reviewer contact, or unassigned (open to
 * the design team).
 */
async function assertReviewerRfiAccess(token: string, rfiId: string) {
  const access = await assertPortalActionAccess(token, {
    portalType: "reviewer",
    permission: "can_view_rfis",
  })

  const supabase = createServiceSupabaseClient()
  const { data: rfi } = await supabase
    .from("rfis")
    .select("id, org_id, project_id, status, assigned_company_id, notify_contact_id")
    .eq("id", rfiId)
    .eq("org_id", access.org_id)
    .eq("project_id", access.project_id)
    .maybeSingle()

  if (!rfi) throw new Error("RFI not found")
  if (rfi.status === "draft") throw new Error("RFI not available")
  if (access.scoped_rfi_id && rfi.id !== access.scoped_rfi_id) {
    throw new Error("Access denied")
  }
  const assignedToReviewer =
    (!!access.company_id && rfi.assigned_company_id === access.company_id) ||
    (!!access.contact_id && rfi.notify_contact_id === access.contact_id)
  if (rfi.assigned_company_id && !assignedToReviewer) {
    throw new Error("Access denied")
  }

  return { access, rfi }
}

export async function listReviewerRfiResponsesAction(token: string, rfiId: string) {
  const { access } = await assertReviewerRfiAccess(token, rfiId)
  return listRfiResponses({ orgId: access.org_id, rfiId })
}

export async function loadReviewerQueueAction(token: string) {
  const access = await assertPortalActionAccess(token, {
    portalType: "reviewer",
    permission: "can_view_submittals",
  })
  if (!access.contact_id) return []
  return listReviewStepsForReviewer({
    orgId: access.org_id,
    projectId: access.project_id,
    contactId: access.contact_id,
  })
}

export async function listReviewerSubmittalItemsAction(token: string, submittalId: string) {
  const access = await assertPortalActionAccess(token, {
    portalType: "reviewer",
    permission: "can_view_submittals",
  })
  if (!access.contact_id) throw new Error("Access denied")

  // Reviewers only see items on submittals routed through them.
  const supabase = createServiceSupabaseClient()
  const { data: step } = await supabase
    .from("submittal_review_steps")
    .select("id, submittal:submittals!inner(id, project_id)")
    .eq("org_id", access.org_id)
    .eq("submittal_id", submittalId)
    .eq("reviewer_contact_id", access.contact_id)
    .eq("submittal.project_id", access.project_id)
    .limit(1)
    .maybeSingle()
  if (!step) throw new Error("Access denied")

  return listSubmittalItems({ orgId: access.org_id, submittalId })
}

export async function decideReviewerStepAction(token: string, formData: FormData) {
  const access = await assertPortalActionAccess(token, {
    portalType: "reviewer",
    permission: "can_review_submittals",
  })
  if (!access.contact_id) throw new Error("Access denied")

  const parsed = decideSubmittalReviewStepSchema.parse({
    step_id: String(formData.get("step_id") || ""),
    decision: String(formData.get("decision") || ""),
    notes: String(formData.get("notes") || "") || null,
  })

  const supabase = createServiceSupabaseClient()
  const { data: step } = await supabase
    .from("submittal_review_steps")
    .select("id, status, reviewer_contact_id, submittal:submittals!inner(id, project_id)")
    .eq("id", parsed.step_id)
    .eq("org_id", access.org_id)
    .eq("reviewer_contact_id", access.contact_id)
    .eq("submittal.project_id", access.project_id)
    .maybeSingle()
  if (!step) throw new Error("Access denied")
  if (step.status !== "in_review") throw new Error("This step is not currently in review")

  const markupFileId = await uploadPortalFile({
    file: formData.get("markup_file") as File | null,
    orgId: access.org_id,
    projectId: access.project_id,
    category: "submittals",
    folderPath: "/submittals",
    metadata: { reviewer_contact_id: access.contact_id, review_markup: true },
  })

  await applyReviewStepDecision({
    orgId: access.org_id,
    stepId: parsed.step_id,
    decision: parsed.decision,
    notes: parsed.notes ?? null,
    markupFileId,
    actorContactId: access.contact_id,
    portalTokenId: access.id,
  })

  return { success: true }
}

export async function addReviewerRfiResponseAction(token: string, input: unknown) {
  const parsed = rfiResponseInputSchema.parse(input)
  const { access } = await assertReviewerRfiAccess(token, parsed.rfi_id)
  if (access.permissions.can_respond_rfis !== true) {
    throw new Error("This portal link does not have permission for that action")
  }

  return addPortalRfiResponse({
    orgId: access.org_id,
    responderContactId: access.contact_id ?? null,
    portalTokenId: access.id,
    input: parsed,
  })
}
