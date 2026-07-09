"use server"

import { revalidatePath } from "next/cache"
import {
  createProjectVendorBill,
  updateVendorBillStatus,
  listVendorBillsForProject,
  deleteVendorBill,
  reassignImportedPayable,
  type VendorBillSummary,
} from "@/lib/services/vendor-bills"
import { listProjectCommitments } from "@/lib/services/commitments"
import { createCompany, getCompany } from "@/lib/services/companies"
import { requireOrgContext } from "@/lib/services/context"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { AuthorizationError } from "@/lib/services/authorization"
import { QBOClient } from "@/lib/integrations/accounting/qbo-api"
import { syncVendorBillToQBO } from "@/lib/services/qbo-sync"
import { extractPayableInvoiceFromFile, type ExtractedPayableInvoice } from "@/lib/services/receipt-extraction"

import { actionError, type ActionResult } from "@/lib/action-result"

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { success: true, data: await fn() }
  } catch (error) {
    return actionError(error)
  }
}

export type PayableActionResult = { success: true } | { success: false; error: string }
export type PayableMutationResult<T = VendorBillSummary> = { success: true; data: T } | { success: false; error: string }

/**
 * Turn a thrown error into a user-facing message. Server Actions redact thrown
 * error messages in production (the client only gets a generic "an error
 * occurred" + digest), so user-facing failures must be returned as data, not
 * thrown, for the real message to reach the toast.
 */
function toPayableActionError(error: unknown): string {
  console.error("[Payables Action Error]:", error)
  if (error instanceof AuthorizationError) {
    return "You don't have permission to do that."
  }
  if (error instanceof Error && error.message) {
    return error.message
  }
  return "Something went wrong. Please try again."
}

function revalidatePayablesPages(projectId: string) {
  revalidatePath(`/projects/${projectId}/payables`)
  revalidatePath(`/projects/${projectId}/financials`)
  revalidatePath(`/projects/${projectId}/financials/payables`)
  revalidatePath(`/projects/${projectId}`)
}

export async function updateProjectVendorBillStatusAction(
  projectId: string,
  billId: string,
  input: unknown,
): Promise<ActionResult<PayableMutationResult>> {
  return run(async () => {
      try {
        const updated = await updateVendorBillStatus({ billId, input: input as any })
        revalidatePayablesPages(projectId)
        return { success: true, data: updated }
      } catch (error) {
        return { success: false, error: toPayableActionError(error) }
      }
  })
}

export async function createProjectVendorBillAction(
  projectId: string,
  input: unknown,
): Promise<ActionResult<PayableMutationResult>> {
  return run(async () => {
      try {
        const bill = await createProjectVendorBill({ projectId, input: input as any })
        revalidatePayablesPages(projectId)
        return { success: true, data: bill }
      } catch (error) {
        return { success: false, error: toPayableActionError(error) }
      }
  })
}

export type PayableInvoiceExtractionResult =
  | { ok: true; data: ExtractedPayableInvoice }
  | { ok: false; error: string }

export async function extractPayableInvoiceAction(_projectId: string, formData: FormData): Promise<ActionResult<PayableInvoiceExtractionResult>> {
  return run(async () => {
      try {
        const { orgId } = await requireOrgContext()
        const invoice = formData.get("invoice")
        if (!(invoice instanceof File)) {
          return { ok: false, error: "Choose an invoice to scan" }
        }

        const data = await extractPayableInvoiceFromFile(invoice, { orgId })
        return { ok: true, data }
      } catch (error: any) {
        console.warn("[PayableExtraction] Scan failed", error)
        return { ok: false, error: error?.message ?? "Could not scan invoice" }
      }
  })
}

export async function ensureProjectVendorCompanyForPayableAction(projectId: string, billId: string) {
  return run(async () => {
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
  })
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
  return run(async () => {
      const { orgId } = await requireOrgContext()
      const result = await syncVendorBillToQBO(billId, orgId)
      revalidatePayablesPages(projectId)
      return result
  })
}

export async function deleteProjectVendorBillAction(
  projectId: string,
  billId: string,
): Promise<ActionResult<PayableActionResult>> {
  return run(async () => {
      try {
        await deleteVendorBill({ billId })
        revalidatePayablesPages(projectId)
        return { success: true }
      } catch (error) {
        return { success: false, error: toPayableActionError(error) }
      }
  })
}

export type ReassignPayableResult =
  | { success: true; projectId: string }
  | { success: false; error: string }

export async function reassignProjectPayableAction(
  projectId: string,
  billId: string,
  targetProjectId: string,
): Promise<ActionResult<ReassignPayableResult>> {
  return run(async () => {
      try {
        const result = await reassignImportedPayable({ billId, targetProjectId })
        revalidatePayablesPages(projectId)
        revalidatePayablesPages(targetProjectId)
        return { success: true, projectId: result.projectId }
      } catch (error) {
        return { success: false, error: toPayableActionError(error) }
      }
  })
}
