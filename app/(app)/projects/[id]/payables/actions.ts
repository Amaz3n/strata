"use server"

import { revalidatePath } from "next/cache"
import { vendorBillStatusUpdateSchema, vendorBillCreateSchema } from "@/lib/validation/vendor-bills"
import { updateVendorBillStatus, listVendorBillsForProject, mapVendorBill } from "@/lib/services/vendor-bills"
import { listProjectCommitments } from "@/lib/services/commitments"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { attachFileWithServiceRole } from "@/lib/services/file-links"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { AuthorizationError } from "@/lib/services/authorization"

function rethrowTypedAuthError(error: unknown): never {
  if (error instanceof AuthorizationError) {
    throw new Error(`AUTH_FORBIDDEN:${error.reasonCode}`)
  }
  throw error
}

export async function updateProjectVendorBillStatusAction(projectId: string, billId: string, input: unknown) {
  try {
    const parsed = vendorBillStatusUpdateSchema.parse(input)
    const updated = await updateVendorBillStatus({ billId, input: parsed })
    revalidatePath(`/projects/${projectId}/payables`)
    revalidatePath(`/projects/${projectId}/financials`)
    revalidatePath(`/projects/${projectId}`)
    return updated
  } catch (error) {
    rethrowTypedAuthError(error)
  }
}

export async function createProjectVendorBillAction(projectId: string, input: unknown) {
  const { orgId, userId } = await requireOrgContext()
  const parsed = vendorBillCreateSchema.parse(input)
  const supabase = createServiceSupabaseClient()

  // 1. Verify commitment
  const { data: commitment, error: commitmentError } = await supabase
    .from("commitments")
    .select("id, total_cents")
    .eq("id", parsed.commitment_id)
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .maybeSingle()

  if (commitmentError || !commitment) {
    throw new Error("Commitment not found")
  }

  // 2. Check for over-budget
  const { data: existingBills } = await supabase
    .from("vendor_bills")
    .select("total_cents")
    .eq("commitment_id", parsed.commitment_id)
    .eq("org_id", orgId)

  const totalBilled = (existingBills ?? []).reduce((sum: number, b: any) => sum + (b.total_cents ?? 0), 0)
  const isOverBudget = (totalBilled + parsed.total_cents) > (commitment.total_cents ?? 0)

  // 3. Insert
  const { data, error } = await supabase
    .from("vendor_bills")
    .insert({
      org_id: orgId,
      project_id: projectId,
      commitment_id: parsed.commitment_id,
      bill_number: parsed.bill_number,
      total_cents: parsed.total_cents,
      currency: "usd",
      status: "pending",
      bill_date: parsed.bill_date,
      due_date: parsed.due_date ?? null,
      file_id: parsed.file_id ?? null,
      submitted_by_contact_id: null, // Internal upload
      metadata: {
        description: parsed.description,
        period_start: parsed.period_start,
        period_end: parsed.period_end,
        internal_upload: true,
        over_budget: isOverBudget,
      },
    })
    .select(`
      id, org_id, project_id, commitment_id, bill_number, status, bill_date, due_date, total_cents, currency, submitted_by_contact_id, file_id, metadata, created_at, updated_at, approved_at, approved_by, paid_at, paid_cents, payment_reference, payment_method, retainage_percent, retainage_cents, lien_waiver_status, lien_waiver_received_at,
      project:projects(id, name),
      commitment:commitments(id, title, total_cents)
    `)
    .single()

  if (error || !data) {
    throw new Error(`Failed to create vendor bill: ${error?.message}`)
  }

  // 4. Attach file if provided
  if (parsed.file_id) {
    try {
      await attachFileWithServiceRole({
        orgId,
        fileId: parsed.file_id,
        projectId,
        entityType: "vendor_bill",
        entityId: data.id as string,
        linkRole: "invoice",
        createdBy: userId,
      })
    } catch (e) {
      console.warn("Failed to attach file", e)
    }
  }

  // 5. Record event
  await recordEvent({
    orgId,
    eventType: "vendor_bill_submitted",
    entityType: "vendor_bill",
    entityId: data.id as string,
    payload: {
      project_id: projectId,
      commitment_id: parsed.commitment_id,
      total_cents: parsed.total_cents,
      bill_number: parsed.bill_number,
      internal_upload: true,
    },
  })

  revalidatePath(`/projects/${projectId}/payables`)
  revalidatePath(`/projects/${projectId}/financials`)
  revalidatePath(`/projects/${projectId}`)

  return mapVendorBill(data)
}

export async function listProjectCommitmentsForPayablesAction(projectId: string) {
  return listProjectCommitments(projectId)
}
