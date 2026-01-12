"use server"

import { revalidatePath } from "next/cache"

import type { Estimate } from "@/lib/types"
import { requireOrgContext } from "@/lib/services/context"
import { createEstimate, convertEstimateToProposal, duplicateEstimate, updateEstimateStatus } from "@/lib/services/estimates"
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
    recipient_contact_id: parsed.recipient_contact_id ?? null,
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

export async function convertEstimateToProposalAction(estimateId: string) {
  const result = await convertEstimateToProposal({ estimateId })
  revalidatePath("/estimates")
  revalidatePath("/proposals")
  return result
}
