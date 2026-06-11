"use server"

import { revalidatePath } from "next/cache"
import { vendorBillStatusUpdateSchema, vendorBillCreateSchema } from "@/lib/validation/vendor-bills"
import {
  updateVendorBillStatus,
  listVendorBillsForProject,
  mapVendorBill,
  deleteVendorBill,
  reassignImportedVendorCredit,
} from "@/lib/services/vendor-bills"
import { listProjectCommitments } from "@/lib/services/commitments"
import { createCompany, getCompany } from "@/lib/services/companies"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { attachFileWithServiceRole } from "@/lib/services/file-links"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { AuthorizationError } from "@/lib/services/authorization"
import { QBOClient } from "@/lib/integrations/accounting/qbo-api"
import { syncVendorBillToQBO } from "@/lib/services/qbo-sync"
import { extractPayableInvoiceFromFile, type ExtractedPayableInvoice } from "@/lib/services/receipt-extraction"

function cleanAndRethrowError(error: unknown): never {
  console.error("[Payables Action Error]:", error)
  if (error instanceof AuthorizationError) {
    throw new Error(`AUTH_FORBIDDEN:${error.reasonCode}`)
  }
  if (error instanceof Error) {
    const cleanErr = new Error(error.message)
    cleanErr.stack = error.stack
    throw cleanErr
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
    cleanAndRethrowError(error)
  }
}

export async function createProjectVendorBillAction(projectId: string, input: unknown) {
  try {
    const { orgId, userId } = await requireOrgContext()
    const parsed = vendorBillCreateSchema.parse(input)
    const supabase = createServiceSupabaseClient()

    let commitment: { id: string; total_cents: number | null; company_id?: string | null } | null = null
    if (parsed.commitment_id) {
      const { data, error: commitmentError } = await supabase
        .from("commitments")
        .select("id, total_cents, company_id")
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

    let companyId: string | null = parsed.company_id ?? commitment?.company_id ?? null
    if (companyId) {
      const { data: company, error: companyError } = await supabase
        .from("companies")
        .select("id")
        .eq("org_id", orgId)
        .eq("id", companyId)
        .maybeSingle()
      if (companyError || !company) {
        throw new Error("Arc vendor not found")
      }
    } else if (!parsed.commitment_id && parsed.vendor_name?.trim()) {
      const { data: company } = await supabase
        .from("companies")
        .select("id")
        .eq("org_id", orgId)
        .ilike("name", parsed.vendor_name.trim())
        .is("metadata->>archived_at", null)
        .limit(1)
        .maybeSingle()
      companyId = (company?.id as string | undefined) ?? null
    }

    // 3. Insert
    const { data, error } = await supabase
      .from("vendor_bills")
      .insert({
        org_id: orgId,
        project_id: projectId,
        commitment_id: parsed.commitment_id ?? null,
        company_id: companyId,
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
        id, org_id, project_id, commitment_id, company_id, bill_number, status, bill_date, due_date, total_cents, currency, submitted_by_contact_id, file_id, metadata, created_at, updated_at, approved_at, approved_by, paid_at, paid_cents, payment_reference, payment_method, retainage_percent, retainage_cents, lien_waiver_status, lien_waiver_received_at, qbo_vendor_id, qbo_vendor_name,
        project:projects(id, name),
        company:companies!vendor_bills_company_id_fkey(id, name, qbo_vendor_id, qbo_vendor_name),
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
  } catch (error) {
    cleanAndRethrowError(error)
  }
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

export async function ensureProjectVendorCompanyForPayableAction(projectId: string, billId: string) {
  try {
    const { orgId } = await requireOrgContext()
    const supabase = createServiceSupabaseClient()

    const { data: bill, error: billError } = await supabase
      .from("vendor_bills")
      .select("id, org_id, project_id, company_id, commitment_id, metadata, qbo_vendor_id, qbo_vendor_name, commitment:commitments(company_id)")
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .eq("id", billId)
      .maybeSingle()

    if (billError || !bill) {
      throw new Error("Payable not found")
    }

    const existingCompanyId =
      (bill.company_id as string | null | undefined) ??
      ((bill.commitment as any)?.company_id as string | null | undefined)
    if (existingCompanyId) {
      return getCompany(existingCompanyId, orgId)
    }

    const metadata = (bill.metadata as Record<string, any> | null) ?? {}
    const vendorName = String(metadata.vendor_name ?? bill.qbo_vendor_name ?? "").trim()
    if (!vendorName) {
      throw new Error("This payable does not have a vendor name to turn into an Arc vendor.")
    }

    const { data: existingCompany, error: companyLookupError } = await supabase
      .from("companies")
      .select("id")
      .eq("org_id", orgId)
      .ilike("name", vendorName)
      .is("metadata->>archived_at", null)
      .limit(1)
      .maybeSingle()

    if (companyLookupError) {
      throw new Error(`Unable to find matching vendor: ${companyLookupError.message}`)
    }

    const company =
      existingCompany?.id
        ? await getCompany(existingCompany.id as string, orgId)
        : await createCompany({
            orgId,
            input: {
              name: vendorName,
              company_type: "supplier",
              qbo_vendor_id: bill.qbo_vendor_id || undefined,
              qbo_vendor_name: bill.qbo_vendor_name || undefined,
              qbo_vendor_synced_at: bill.qbo_vendor_id ? new Date().toISOString() : undefined,
              qbo_vendor_sync_status: bill.qbo_vendor_id ? "linked" : undefined,
            },
          })

    const { error: updateError } = await supabase
      .from("vendor_bills")
      .update({
        company_id: company.id,
        qbo_vendor_id: company.qbo_vendor_id ?? bill.qbo_vendor_id ?? null,
        qbo_vendor_name: company.qbo_vendor_name ?? bill.qbo_vendor_name ?? vendorName,
      })
      .eq("org_id", orgId)
      .eq("id", billId)

    if (updateError) {
      throw new Error(`Unable to link payable vendor: ${updateError.message}`)
    }

    revalidatePayablesPages(projectId)
    revalidatePath(`/companies/${company.id}`)
    revalidatePath("/directory")
    return company
  } catch (error) {
    cleanAndRethrowError(error)
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
  try {
    const { orgId } = await requireOrgContext()
    const result = await syncVendorBillToQBO(billId, orgId)
    revalidatePayablesPages(projectId)
    return result
  } catch (error) {
    cleanAndRethrowError(error)
  }
}

export async function deleteProjectVendorBillAction(projectId: string, billId: string) {
  try {
    await deleteVendorBill({ billId })
    revalidatePayablesPages(projectId)
    return { success: true }
  } catch (error) {
    cleanAndRethrowError(error)
  }
}

export async function reassignProjectVendorCreditAction(projectId: string, billId: string, targetProjectId: string) {
  try {
    const result = await reassignImportedVendorCredit({ billId, targetProjectId })
    revalidatePayablesPages(projectId)
    revalidatePayablesPages(targetProjectId)
    return result
  } catch (error) {
    cleanAndRethrowError(error)
  }
}
