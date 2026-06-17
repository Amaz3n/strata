"use server"

import { revalidatePath } from "next/cache"

import { createSubmittal, decideSubmittal, listSubmittals } from "@/lib/services/submittals"
import { requireOrgContext } from "@/lib/services/context"
import { submittalDecisionSchema, submittalInputSchema } from "@/lib/validation/submittals"

export async function listSubmittalsAction(projectId?: string) {
  return listSubmittals(undefined, projectId)
}

export async function createSubmittalAction(input: unknown) {
  const parsed = submittalInputSchema.parse(input)
  const submittal = await createSubmittal({ input: parsed })
  revalidatePath("/submittals")
  revalidatePath(`/projects/${submittal.project_id}/submittals`)
  return submittal
}

export async function decideSubmittalAction(input: unknown) {
  const parsed = submittalDecisionSchema.parse(input)
  const { supabase, orgId, userId } = await requireOrgContext()
  await decideSubmittal({
    orgId,
    input: {
      ...parsed,
      decision_by_user_id: parsed.decision_by_user_id ?? userId,
    },
  })
  revalidatePath("/submittals")
  const { data, error } = await supabase
    .from("submittals")
    .select(
      "id, org_id, project_id, submittal_number, title, description, status, spec_section, submittal_type, due_date, reviewed_at, attachment_file_id, last_item_submitted_at, decision_status, decision_note, decision_by_user_id, decision_by_contact_id, decision_at, decision_via_portal, decision_portal_token_id, created_at, updated_at",
    )
    .eq("org_id", orgId)
    .eq("id", parsed.submittal_id)
    .single()
  if (error || !data) {
    throw new Error(`Failed to load updated submittal: ${error?.message}`)
  }
  revalidatePath(`/projects/${data.project_id}/submittals`)
  return data
}




