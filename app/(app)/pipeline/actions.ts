"use server"

import { revalidatePath } from "next/cache"
import {
  listProspects,
  getProspect,
  createProspect,
  updateProspect,
  deleteProspect,
  createProspectContact,
  updateProspectContact,
  listProspectActivity,
  setProspectFollowUp,
} from "@/lib/services/prospects"
import {
  createProspectInputSchema,
  updateProspectInputSchema,
  prospectContactInputSchema,
  updateProspectContactInputSchema,
  prospectFiltersSchema,
} from "@/lib/validation/prospects"
import { trackInCrm } from "@/lib/services/crm"

function revalidatePipelinePaths(contactId?: string) {
  revalidatePath("/pipeline")
  revalidatePath("/prospects")
  revalidatePath("/directory")
  revalidatePath("/contacts")
  if (contactId) {
    revalidatePath(`/prospects/${contactId}`)
  }
}

export async function listProspectsAction(filters?: unknown) {
  const parsed = prospectFiltersSchema.parse(filters ?? undefined)
  return listProspects(undefined, parsed)
}

export async function getProspectAction(contactId: string) {
  return getProspect(contactId)
}

export async function listProspectActivityAction(prospectId: string) {
  return listProspectActivity(prospectId)
}

export async function createProspectAction(input: unknown) {
  const parsed = createProspectInputSchema.parse(input)
  const prospect = await createProspect({ input: parsed })
  revalidatePipelinePaths(prospect.id)
  return prospect
}

export async function updateProspectAction(contactId: string, input: unknown) {
  const parsed = updateProspectInputSchema.parse(input)
  const prospect = await updateProspect({ prospectId: contactId, input: parsed })
  revalidatePipelinePaths(contactId)
  return prospect
}

export async function deleteProspectAction(prospectId: string) {
  await deleteProspect({ prospectId })
  revalidatePipelinePaths(prospectId)
  return { success: true }
}

export async function setProspectFollowUpAction(prospectId: string, nextFollowUpAt: string | null) {
  const prospect = await setProspectFollowUp({ prospectId, nextFollowUpAt })
  revalidatePipelinePaths(prospectId)
  return prospect
}

export async function createProspectContactAction(prospectId: string, input: unknown) {
  const parsed = prospectContactInputSchema.parse(input)
  const contact = await createProspectContact({ prospectId, input: parsed })
  revalidatePipelinePaths(prospectId)
  return contact
}

export async function updateProspectContactAction(contactId: string, input: unknown) {
  const parsed = updateProspectContactInputSchema.parse(input)
  const contact = await updateProspectContact({ contactId, input: parsed })
  revalidatePipelinePaths()
  return contact
}

export async function trackInCrmAction(contactId: string) {
  const prospect = await trackInCrm({ contactId })
  revalidatePipelinePaths(contactId)
  return prospect
}

export async function convertExecutedProspectAction({
  prospectId,
  estimateId,
  projectInput,
}: {
  prospectId: string
  estimateId: string
  projectInput: {
    name: string
    start_date?: string | null
    end_date?: string | null
    property_type?: "residential" | "commercial"
    project_type?: "new_construction" | "remodel" | "addition" | "renovation" | "repair"
    description?: string | null
  }
}) {
  const { convertExecutedProspectToProject } = await import("@/lib/services/conversions")
  const result = await convertExecutedProspectToProject({
    prospectId,
    estimateId,
    projectInput,
  })
  revalidatePipelinePaths(prospectId)
  revalidatePath("/projects")
  revalidatePath("/estimates")
  return result
}

export async function getExecutedEstimateForProspectAction(prospectId: string) {
  const { createServiceSupabaseClient } = await import("@/lib/supabase/server")
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("estimates")
    .select("id, title, total_cents, valid_until, created_at, status")
    .eq("prospect_id", prospectId)
    .eq("status", "executed")
    .maybeSingle()
  if (error) throw new Error(error.message)
  return data
}

export async function listProspectEstimatesAction(
  prospectId: string,
): Promise<Array<import("@/lib/types").Estimate & { recipient_name?: string | null }>> {
  const { requireOrgContext } = await import("@/lib/services/context")
  const { supabase, orgId } = await requireOrgContext()

  const { data, error } = await supabase
    .from("estimates")
    .select("*, recipient:contacts(id, full_name)")
    .eq("org_id", orgId)
    .eq("prospect_id", prospectId)
    .order("created_at", { ascending: false })

  if (error) {
    console.error("Failed to list prospect estimates", error.message)
    return []
  }

  return (data ?? []).map((row: any) => ({
    ...(row as import("@/lib/types").Estimate),
    recipient_name: row.recipient?.full_name ?? null,
  }))
}

export async function getEstimateCreateDataAction() {
  const { requireOrgContext } = await import("@/lib/services/context")
  const { listContacts } = await import("@/lib/services/contacts")
  const { listCostCodes } = await import("@/lib/services/cost-codes")
  const { getOrgBranding } = await import("@/lib/services/estimate-portal")

  const { orgId } = await requireOrgContext()
  const [contacts, costCodes, branding] = await Promise.all([
    listContacts(),
    listCostCodes().catch(() => []),
    getOrgBranding(orgId),
  ])

  return {
    contacts,
    costCodes,
    defaultTerms: branding.estimateTermsTemplate ?? "",
  }
}


