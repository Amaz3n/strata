import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireOrgContext } from "@/lib/services/context"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { requireAuthorization } from "@/lib/services/authorization"
import { attachFileWithServiceRole } from "@/lib/services/file-links"
import {
  vendorBillStatusUpdateSchema,
  vendorBillCreateSchema,
  type VendorBillStatusUpdate,
  type VendorBillCreate,
} from "@/lib/validation/vendor-bills"
import { getComplianceRules } from "@/lib/services/compliance"
import { getCompanyComplianceStatusWithClient } from "@/lib/services/compliance-documents"

export type VendorBillStatus = "pending" | "approved" | "partial" | "paid"

export interface VendorBillSummary {
  id: string
  org_id: string
  project_id: string
  project_name?: string
  commitment_id?: string
  commitment_title?: string
  commitment_total_cents?: number
  company_id?: string
  company_name?: string
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
  payment_method?: string
  paid_at?: string
  approved_at?: string
  approved_by?: string
  paid_cents?: number
  retainage_percent?: number
  retainage_cents?: number
  lien_waiver_status?: string
  lien_waiver_received_at?: string
  over_budget?: boolean
}

function mapVendorBill(row: any): VendorBillSummary {
  const metadata = row?.metadata ?? {}
  const company = row?.commitment?.company ?? row?.company ?? {}
  const paidCents =
    typeof row.paid_cents === "number"
      ? row.paid_cents
      : row.status === "paid"
        ? row.total_cents ?? 0
        : 0
  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id,
    project_name: row.project?.name ?? undefined,
    commitment_id: row.commitment_id ?? undefined,
    commitment_title: row.commitment?.title ?? undefined,
    commitment_total_cents: row.commitment?.total_cents ?? undefined,
    company_id: company.id ?? row.company_id ?? undefined,
    company_name: company.name ?? row.company?.name ?? undefined,
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
    payment_reference: row.payment_reference ?? metadata.payment_reference ?? undefined,
    payment_method: row.payment_method ?? metadata.payment_method ?? undefined,
    paid_at: row.paid_at ?? metadata.paid_at ?? undefined,
    approved_at: row.approved_at ?? metadata.approved_at ?? undefined,
    approved_by: row.approved_by ?? metadata.approved_by ?? undefined,
    paid_cents: paidCents,
    retainage_percent: row.retainage_percent ?? undefined,
    retainage_cents: row.retainage_cents ?? undefined,
    lien_waiver_status: row.lien_waiver_status ?? undefined,
    lien_waiver_received_at: row.lien_waiver_received_at ?? undefined,
    over_budget: typeof metadata.over_budget === "boolean" ? metadata.over_budget : undefined,
  }
}

export async function listVendorBillsForCompany(companyId: string, orgId?: string): Promise<VendorBillSummary[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAuthorization({
    permission: "bill.read",
    userId,
    orgId: resolvedOrgId,
    supabase,
    logDecision: true,
    resourceType: "company",
    resourceId: companyId,
  })

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
      id, org_id, project_id, commitment_id, bill_number, status, bill_date, due_date, total_cents, currency, submitted_by_contact_id, file_id, metadata, created_at, updated_at, approved_at, approved_by, paid_at, paid_cents, payment_reference, payment_method, retainage_percent, retainage_cents, lien_waiver_status, lien_waiver_received_at,
      project:projects(id, name),
      commitment:commitments(id, title, total_cents, company:companies(id, name))
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

export async function listVendorBillsForProject(projectId: string, orgId?: string): Promise<VendorBillSummary[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAuthorization({
    permission: "bill.read",
    userId,
    orgId: resolvedOrgId,
    projectId,
    supabase,
    logDecision: true,
    resourceType: "project",
    resourceId: projectId,
  })

  const { data, error } = await supabase
    .from("vendor_bills")
    .select(
      `
      id, org_id, project_id, commitment_id, bill_number, status, bill_date, due_date, total_cents, currency, submitted_by_contact_id, file_id, metadata, created_at, updated_at, approved_at, approved_by, paid_at, paid_cents, payment_reference, payment_method, retainage_percent, retainage_cents, lien_waiver_status, lien_waiver_received_at,
      project:projects(id, name),
      commitment:commitments(id, title, total_cents, company:companies(id, name))
    `,
    )
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)
    .order("due_date", { ascending: true, nullsFirst: true })
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

  const { data: existing, error: existingError } = await supabase
    .from("vendor_bills")
    .select("id, org_id, project_id, commitment_id, status, total_cents, currency, metadata, approved_at, paid_at, paid_cents, lien_waiver_status")
    .eq("org_id", resolvedOrgId)
    .eq("id", billId)
    .maybeSingle()

  if (existingError || !existing) {
    throw new Error("Vendor bill not found")
  }

  const requiredPermission =
    parsed.status === "approved"
      ? "bill.approve"
      : parsed.status === "paid" || parsed.status === "partial"
        ? "payment.release"
        : "bill.write"

  await requireAuthorization({
    permission: requiredPermission,
    userId,
    orgId: resolvedOrgId,
    projectId: existing.project_id,
    supabase,
    logDecision: true,
    resourceType: "vendor_bill",
    resourceId: billId,
  })

  if (
    (parsed.status === "paid" || parsed.status === "partial") &&
    existing.status !== "approved" &&
    existing.status !== "partial" &&
    existing.status !== "paid"
  ) {
    throw new Error("Bill must be approved before it can be marked paid")
  }

  if (parsed.status === "paid" || parsed.status === "partial") {
    const rules = await getComplianceRules(resolvedOrgId).catch(() => ({
      require_lien_waiver: false,
      block_payment_on_missing_docs: true,
    }))

    if (rules.block_payment_on_missing_docs) {
      if (rules.require_lien_waiver && existing.lien_waiver_status !== "received") {
        throw new Error("Lien waiver required before payment")
      }

      if (existing.commitment_id) {
        const { data: commitment, error: commitmentError } = await supabase
          .from("commitments")
          .select("company_id")
          .eq("id", existing.commitment_id)
          .eq("org_id", resolvedOrgId)
          .maybeSingle()

        if (commitmentError) {
          throw new Error(`Unable to validate compliance: ${commitmentError.message}`)
        }

        const companyId = (commitment as any)?.company_id as string | undefined
        if (companyId) {
          const status = await getCompanyComplianceStatusWithClient(supabase, resolvedOrgId, companyId)
          if (!status.is_compliant) {
            throw new Error("Compliance documents required before payment")
          }
        }
      }
    }
  }

  if (parsed.status === "partial" && parsed.payment_amount_cents == null && existing.status !== "partial") {
    throw new Error("Payment amount required to mark bill as partial")
  }

  // Build update object with column values.
  const updateData: any = { status: parsed.status }
  const totalCents = existing.total_cents ?? 0
  const existingPaid = typeof existing.paid_cents === "number" ? existing.paid_cents : 0
  const remainingCents = Math.max(0, totalCents - existingPaid)

  if (parsed.payment_reference) {
    updateData.payment_reference = parsed.payment_reference
  }

  if (parsed.payment_method) {
    updateData.payment_method = parsed.payment_method
  }

  if (parsed.status === "approved" && !existing.approved_at) {
    updateData.approved_at = new Date().toISOString()
    updateData.approved_by = userId
  }

  const shouldProcessPayment = parsed.status === "paid" || (parsed.status === "partial" && parsed.payment_amount_cents != null)

  if (shouldProcessPayment) {
    let paymentAmount = parsed.payment_amount_cents
    if (paymentAmount == null && parsed.status === "paid") {
      paymentAmount = remainingCents
    }

    if (paymentAmount == null) {
      throw new Error("Payment amount required for partial payments")
    }

    if (paymentAmount <= 0 && remainingCents > 0) {
      throw new Error("Payment amount must be positive")
    }

    if (paymentAmount > remainingCents) {
      throw new Error("Payment amount exceeds remaining balance")
    }

    if (paymentAmount > 0) {
      const { error: paymentInsertError } = await supabase.from("payments").insert({
        org_id: resolvedOrgId,
        project_id: existing.project_id,
        bill_id: billId,
        amount_cents: paymentAmount,
        currency: existing.currency ?? "usd",
        method: parsed.payment_method ?? "check",
        reference: parsed.payment_reference ?? null,
        received_at: new Date().toISOString(),
        status: "succeeded",
        provider: "manual",
        net_cents: paymentAmount,
        metadata: {},
      })

      if (paymentInsertError) {
        throw new Error(`Failed to record bill payment: ${paymentInsertError.message}`)
      }
    }

    const nextPaid = existingPaid + (paymentAmount ?? 0)
    const isPaid = totalCents > 0 ? nextPaid >= totalCents : parsed.status === "paid"
    updateData.status = isPaid ? "paid" : "partial"
    updateData.paid_cents = nextPaid
    if (isPaid && !existing.paid_at) {
      updateData.paid_at = new Date().toISOString()
    }
  }

  if (parsed.retainage_percent != null) {
    updateData.retainage_percent = parsed.retainage_percent
    updateData.retainage_cents = Math.round((totalCents * parsed.retainage_percent) / 100)
  }

  if (parsed.lien_waiver_status) {
    updateData.lien_waiver_status = parsed.lien_waiver_status
    updateData.lien_waiver_received_at =
      parsed.lien_waiver_status === "received" ? new Date().toISOString() : null
  }

  const { data, error } = await supabase
    .from("vendor_bills")
    .update(updateData)
    .eq("org_id", resolvedOrgId)
    .eq("id", billId)
    .select(
      `
      id, org_id, project_id, commitment_id, bill_number, status, bill_date, due_date, total_cents, currency, submitted_by_contact_id, file_id, metadata, created_at, updated_at, approved_at, approved_by, paid_at, paid_cents, payment_reference, payment_method, retainage_percent, retainage_cents, lien_waiver_status, lien_waiver_received_at,
      project:projects(id, name),
      commitment:commitments(id, title, total_cents, company:companies(id, name))
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

  const finalStatus = updateData.status ?? parsed.status

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: finalStatus === "paid" ? "vendor_bill_paid" : "vendor_bill_updated",
    entityType: "vendor_bill",
    entityId: billId,
    payload: {
      status: finalStatus,
      payment_reference: parsed.payment_reference,
      payment_method: parsed.payment_method,
      payment_amount_cents: parsed.payment_amount_cents,
      lien_waiver_status: parsed.lien_waiver_status,
      retainage_percent: parsed.retainage_percent,
    },
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
      id, org_id, project_id, commitment_id, bill_number, status, bill_date, due_date, total_cents, currency, submitted_by_contact_id, file_id, metadata, created_at, updated_at, approved_at, approved_by, paid_at, paid_cents, payment_reference, payment_method, retainage_percent, retainage_cents, lien_waiver_status, lien_waiver_received_at,
      project:projects(id, name),
      commitment:commitments(id, title, total_cents)
    `,
    )
    .single()

  if (error || !data) {
    throw new Error(`Failed to create vendor bill: ${error?.message}`)
  }

  if (parsed.file_id) {
    try {
      await attachFileWithServiceRole({
        orgId,
        fileId: parsed.file_id,
        projectId,
        entityType: "vendor_bill",
        entityId: data.id as string,
        linkRole: "invoice",
        createdBy: null,
      })
    } catch (error) {
      console.warn("Failed to attach vendor bill file to file_links", error)
    }
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
