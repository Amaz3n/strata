import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireOrgContext } from "@/lib/services/context"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { requireAnyPermission, requirePermission } from "@/lib/services/permissions"
import {
  vendorBillStatusUpdateSchema,
  vendorBillCreateSchema,
  type VendorBillStatusUpdate,
  type VendorBillCreate,
} from "@/lib/validation/vendor-bills"

export type VendorBillStatus = "pending" | "approved" | "paid"

export interface VendorBillSummary {
  id: string
  org_id: string
  project_id: string
  project_name?: string
  commitment_id?: string
  commitment_title?: string
  commitment_total_cents?: number
  bill_number?: string
  status: VendorBillStatus | string
  bill_date?: string
  due_date?: string
  total_cents?: number
  currency: string
  submitted_by_contact_id?: string
  file_id?: string
  created_at: string
  updated_at?: string
  payment_reference?: string
  paid_at?: string
}

function mapVendorBill(row: any): VendorBillSummary {
  const metadata = row?.metadata ?? {}
  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id,
    project_name: row.project?.name ?? undefined,
    commitment_id: row.commitment_id ?? undefined,
    commitment_title: row.commitment?.title ?? undefined,
    commitment_total_cents: row.commitment?.total_cents ?? undefined,
    bill_number: row.bill_number ?? undefined,
    status: row.status ?? "pending",
    bill_date: row.bill_date ?? undefined,
    due_date: row.due_date ?? undefined,
    total_cents: row.total_cents ?? undefined,
    currency: row.currency ?? "usd",
    submitted_by_contact_id: row.submitted_by_contact_id ?? undefined,
    file_id: row.file_id ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at ?? undefined,
    payment_reference: metadata.payment_reference ?? undefined,
    paid_at: metadata.paid_at ?? undefined,
  }
}

export async function listVendorBillsForCompany(companyId: string, orgId?: string): Promise<VendorBillSummary[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["org.member", "org.read"], { supabase, orgId: resolvedOrgId, userId })

  const { data: commitments, error: commitmentError } = await supabase
    .from("commitments")
    .select("id")
    .eq("org_id", resolvedOrgId)
    .eq("company_id", companyId)

  if (commitmentError) {
    throw new Error(`Failed to load commitments: ${commitmentError.message}`)
  }

  const commitmentIds = (commitments ?? []).map((c: any) => c.id).filter(Boolean)
  if (commitmentIds.length === 0) return []

  const { data, error } = await supabase
    .from("vendor_bills")
    .select(
      `
      id, org_id, project_id, commitment_id, bill_number, status, bill_date, due_date, total_cents, currency, submitted_by_contact_id, file_id, metadata, created_at, updated_at,
      project:projects(id, name),
      commitment:commitments(id, title, total_cents)
    `,
    )
    .eq("org_id", resolvedOrgId)
    .in("commitment_id", commitmentIds)
    .order("created_at", { ascending: false })

  if (error) {
    throw new Error(`Failed to list vendor bills: ${error.message}`)
  }

  return (data ?? []).map(mapVendorBill)
}

export async function updateVendorBillStatus({
  billId,
  input,
  orgId,
}: {
  billId: string
  input: VendorBillStatusUpdate
  orgId?: string
}): Promise<VendorBillSummary> {
  const parsed = vendorBillStatusUpdateSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("org.member", { supabase, orgId: resolvedOrgId, userId })

  const { data: existing, error: existingError } = await supabase
    .from("vendor_bills")
    .select("id, org_id, status, metadata")
    .eq("org_id", resolvedOrgId)
    .eq("id", billId)
    .maybeSingle()

  if (existingError || !existing) {
    throw new Error("Vendor bill not found")
  }

  const metadata = {
    ...(existing.metadata ?? {}),
    payment_reference: parsed.payment_reference ?? existing.metadata?.payment_reference,
    paid_at: parsed.status === "paid" ? new Date().toISOString() : existing.metadata?.paid_at,
  }

  const { data, error } = await supabase
    .from("vendor_bills")
    .update({ status: parsed.status, metadata })
    .eq("org_id", resolvedOrgId)
    .eq("id", billId)
    .select(
      `
      id, org_id, project_id, commitment_id, bill_number, status, bill_date, due_date, total_cents, currency, submitted_by_contact_id, file_id, metadata, created_at, updated_at,
      project:projects(id, name),
      commitment:commitments(id, title, total_cents)
    `,
    )
    .single()

  if (error || !data) {
    throw new Error(`Failed to update vendor bill: ${error?.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "vendor_bill",
    entityId: billId,
    before: existing,
    after: data,
  })

  return mapVendorBill(data)
}

/**
 * Create a vendor bill from the sub portal.
 * This function bypasses normal org context since it's called from a portal token.
 */
export async function createVendorBillFromPortal({
  input,
  orgId,
  projectId,
  companyId,
  portalTokenId,
}: {
  input: VendorBillCreate
  orgId: string
  projectId: string
  companyId: string
  portalTokenId: string
}): Promise<VendorBillSummary> {
  const parsed = vendorBillCreateSchema.parse(input)
  const supabase = createServiceSupabaseClient()

  // Verify the commitment belongs to this org, project, and company
  const { data: commitment, error: commitmentError } = await supabase
    .from("commitments")
    .select("id, org_id, project_id, company_id, title, status, total_cents")
    .eq("id", parsed.commitment_id)
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .eq("company_id", companyId)
    .maybeSingle()

  if (commitmentError || !commitment) {
    throw new Error("Commitment not found or does not belong to your company")
  }

  if (commitment.status !== "approved") {
    throw new Error("Can only submit invoices against approved contracts")
  }

  // Get existing billed amount for this commitment
  const { data: existingBills } = await supabase
    .from("vendor_bills")
    .select("total_cents")
    .eq("commitment_id", parsed.commitment_id)
    .eq("org_id", orgId)

  const totalBilled = (existingBills ?? []).reduce((sum, b) => sum + (b.total_cents ?? 0), 0)
  const remaining = (commitment.total_cents ?? 0) - totalBilled

  // Warn if over budget (but still allow submission)
  const isOverBudget = parsed.total_cents > remaining

  // Create the vendor bill
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
      metadata: {
        description: parsed.description,
        period_start: parsed.period_start,
        period_end: parsed.period_end,
        submitted_via_portal: true,
        portal_token_id: portalTokenId,
        over_budget: isOverBudget,
      },
    })
    .select(
      `
      id, org_id, project_id, commitment_id, bill_number, status, bill_date, due_date, total_cents, currency, submitted_by_contact_id, file_id, metadata, created_at, updated_at,
      project:projects(id, name),
      commitment:commitments(id, title, total_cents)
    `,
    )
    .single()

  if (error || !data) {
    throw new Error(`Failed to create vendor bill: ${error?.message}`)
  }

  // Record event for activity feed
  await recordEvent({
    orgId,
    eventType: "vendor_bill_submitted",
    entityType: "vendor_bill",
    entityId: data.id as string,
    payload: {
      company_id: companyId,
      project_id: projectId,
      commitment_id: parsed.commitment_id,
      total_cents: parsed.total_cents,
      bill_number: parsed.bill_number,
      submitted_via_portal: true,
      over_budget: isOverBudget,
    },
  })

  return mapVendorBill(data)
}

