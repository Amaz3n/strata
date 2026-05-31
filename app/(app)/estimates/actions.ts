"use server"

import { revalidatePath } from "next/cache"

import type { Estimate } from "@/lib/types"
import { requireOrgContext } from "@/lib/services/context"
import { createEstimate, duplicateEstimate, reviseEstimate, updateEstimateStatus } from "@/lib/services/estimates"
import {
  sendEstimate,
  getEstimateShareLink,
  getEstimateBuilderSigningLink,
  addBuilderEstimateComment,
  countersignEstimate,
  listEstimateComments,
} from "@/lib/services/estimate-portal"
import { estimateInputSchema } from "@/lib/validation/estimates"

export async function listEstimatesAction(): Promise<Array<Estimate & { recipient_name?: string | null }>> {
  const { supabase, orgId } = await requireOrgContext()

  const { data, error } = await supabase
    .from("estimates")
    .select("*, recipient:contacts(id, full_name)")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })

  if (error) {
    console.error("Failed to list estimates", error.message)
    return []
  }

  return (data ?? []).map((row: any) => ({
    ...(row as Estimate),
    recipient_name: row.recipient?.full_name ?? null,
  }))
}

export async function createEstimateAction(input: unknown) {
  const parsed = estimateInputSchema.parse(input)
  const { estimate } = await createEstimate({
    ...parsed,
    project_id: parsed.project_id ?? null,
    prospect_id: parsed.prospect_id ?? null,
    recipient_contact_id: parsed.recipient_contact_id ?? null,
    lines: parsed.lines.map((line, index) => ({ ...line, sort_order: index, markup_pct: line.markup_pct ?? 0 })),
  })
  revalidatePath("/estimates")
  return estimate
}

export async function listEstimateTemplatesAction() {
  const { supabase, orgId } = await requireOrgContext()
  const { data, error } = await supabase
    .from("estimate_templates")
    .select("id, org_id, name, description, lines, is_default, created_at, updated_at")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })

  if (error) {
    console.error("Failed to list estimate templates", error.message)
    return []
  }

  return data ?? []
}

export async function duplicateEstimateAction(estimateId: string) {
  const estimate = await duplicateEstimate({ estimateId })
  revalidatePath("/estimates")
  return estimate
}

export async function updateEstimateStatusAction(estimateId: string, status: "draft" | "sent" | "approved" | "rejected") {
  const estimate = await updateEstimateStatus({ estimateId, status })
  revalidatePath("/estimates")
  return estimate
}


export async function sendEstimateAction(estimateId: string, message?: string) {
  const result = await sendEstimate({ estimateId, message })
  revalidatePath("/estimates")
  return result
}

export async function getEstimateShareLinkAction(estimateId: string) {
  return getEstimateShareLink({ estimateId })
}

export async function getEstimateBuilderSigningLinkAction(estimateId: string) {
  return getEstimateBuilderSigningLink({ estimateId })
}

export async function reviseEstimateAction(estimateId: string) {
  const estimate = await reviseEstimate({ estimateId })
  revalidatePath("/estimates")
  return estimate
}

export async function listEstimateCommentsAction(estimateId: string) {
  return listEstimateComments(estimateId)
}

export async function addEstimateCommentAction(estimateId: string, body: string) {
  await addBuilderEstimateComment({ estimateId, body })
  revalidatePath("/estimates")
}

export async function countersignEstimateAction(estimateId: string, signerName?: string) {
  const result = await countersignEstimate({ estimateId, signerName })
  revalidatePath("/estimates")
  revalidatePath("/pipeline")
  if (result.signatureDocumentId) {
    revalidatePath("/signatures")
  }
  return result
}
