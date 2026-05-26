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
import { QBOClient } from "@/lib/integrations/accounting/qbo-api"
import { syncVendorBillToQBO } from "@/lib/services/qbo-sync"
import { extractPayableInvoiceFromFile, type ExtractedPayableInvoice } from "@/lib/services/receipt-extraction"

function rethrowTypedAuthError(error: unknown): never {
  if (error instanceof AuthorizationError) {
    throw new Error(`AUTH_FORBIDDEN:${error.reasonCode}`)
  }
  throw error
}

function revalidatePayablesPages(projectId: string) {
  revalidatePath(`/projects/${projectId}/payables`)
  revalidatePath(`/projects/${projectId}/financials`)
  revalidatePath(`/projects/${projectId}/financials/payables`)
  revalidatePath(`/projects/${projectId}`)
}

export async function updateProjectVendorBillStatusAction(projectId: string, billId: string, input: unknown) {
  try {
    const parsed = vendorBillStatusUpdateSchema.parse(input)
    const updated = await updateVendorBillStatus({ billId, input: parsed })
    revalidatePayablesPages(projectId)
    return updated
  } catch (error) {
    rethrowTypedAuthError(error)
  }
}

export async function createProjectVendorBillAction(projectId: string, input: unknown) {
  const { orgId, userId } = await requireOrgContext()
  const parsed = vendorBillCreateSchema.parse(input)
  const supabase = createServiceSupabaseClient()

  let commitment: { id: string; total_cents: number | null } | null = null
  if (parsed.commitment_id) {
    const { data, error: commitmentError } = await supabase
      .from("commitments")
      .select("id, total_cents")
      .eq("id", parsed.commitment_id)
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .maybeSingle()

    if (commitmentError || !data) {
      throw new Error("Commitment not found")
    }
    commitment = data
  }

  // 2. Check for over-budget
  let isOverBudget = false
  if (parsed.commitment_id && commitment) {
    const { data: existingBills } = await supabase
      .from("vendor_bills")
      .select("total_cents")
      .eq("commitment_id", parsed.commitment_id)
      .eq("org_id", orgId)

    const totalBilled = (existingBills ?? []).reduce((sum: number, b: any) => sum + (b.total_cents ?? 0), 0)
    isOverBudget = (totalBilled + parsed.total_cents) > (commitment.total_cents ?? 0)
  }

  // 3. Insert
  const { data, error } = await supabase
    .from("vendor_bills")
    .insert({
      org_id: orgId,
      project_id: projectId,
      commitment_id: parsed.commitment_id ?? null,
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
        vendor_name: parsed.vendor_name || parsed.qbo_vendor_name || undefined,
        period_start: parsed.period_start,
        period_end: parsed.period_end,
        internal_upload: true,
        over_budget: isOverBudget,
      },
      qbo_vendor_id: parsed.qbo_vendor_id || null,
      qbo_vendor_name: parsed.qbo_vendor_name || parsed.vendor_name || null,
    })
    .select(`
      id, org_id, project_id, commitment_id, bill_number, status, bill_date, due_date, total_cents, currency, submitted_by_contact_id, file_id, metadata, created_at, updated_at, approved_at, approved_by, paid_at, paid_cents, payment_reference, payment_method, retainage_percent, retainage_cents, lien_waiver_status, lien_waiver_received_at, qbo_vendor_id, qbo_vendor_name,
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
      commitment_id: parsed.commitment_id ?? null,
      total_cents: parsed.total_cents,
      bill_number: parsed.bill_number,
      internal_upload: true,
    },
  })

  revalidatePayablesPages(projectId)

  return mapVendorBill(data)
}

export type PayableInvoiceExtractionResult =
  | { ok: true; data: ExtractedPayableInvoice }
  | { ok: false; error: string }

export async function extractPayableInvoiceAction(_projectId: string, formData: FormData): Promise<PayableInvoiceExtractionResult> {
  try {
    await requireOrgContext()
    const invoice = formData.get("invoice")
    if (!(invoice instanceof File)) {
      return { ok: false, error: "Choose an invoice to scan" }
    }

    const data = await extractPayableInvoiceFromFile(invoice)
    return { ok: true, data }
  } catch (error: any) {
    console.warn("[PayableExtraction] Scan failed", error)
    return { ok: false, error: error?.message ?? "Could not scan invoice" }
  }
}

export async function listProjectCommitmentsForPayablesAction(projectId: string) {
  return listProjectCommitments(projectId)
}

export async function getPayablesAccountingContextAction() {
  const { orgId } = await requireOrgContext()
  const supabase = createServiceSupabaseClient()
  const client = await QBOClient.forOrg(orgId)
  if (!client) {
    return {
      enabled: false,
      expenseAccounts: [],
      apAccounts: [],
      vendors: [],
      defaults: {},
    }
  }

  const [{ data: connection }, expenseAccounts, apAccounts, vendors] = await Promise.all([
    supabase.from("qbo_connections").select("settings").eq("org_id", orgId).eq("status", "active").maybeSingle(),
    client.listExpenseAccounts().catch(() => []),
    client.listAccountsPayableAccounts().catch(() => []),
    client.listVendors().catch(() => []),
  ])

  const settings = (connection?.settings as Record<string, any> | null) ?? {}
  return {
    enabled: true,
    expenseAccounts,
    apAccounts,
    vendors,
    defaults: {
      expenseAccountId: settings.default_expense_account_id as string | undefined,
      apAccountId: settings.default_ap_account_id as string | undefined,
    },
  }
}

export async function syncProjectVendorBillToQBOAction(projectId: string, billId: string) {
  const { orgId } = await requireOrgContext()
  const result = await syncVendorBillToQBO(billId, orgId)
  revalidatePayablesPages(projectId)
  return result
}
