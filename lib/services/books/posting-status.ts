import "server-only"
import { z } from "zod"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireOrgContext } from "@/lib/services/context"
import { requireAuthorization } from "@/lib/services/authorization"
import { requireBooksAuthorization } from "@/lib/services/books/access"
import { resolveBooksPostingState } from "@/lib/services/books/posting-state"
import { BILLED_INVOICE_STATUSES, PAYABLE_VENDOR_BILL_STATUSES, POSTED_EXPENSE_STATUSES, POSTED_PAYMENT_STATUSES } from "@/lib/financials/ledger-status"

export type BooksPostingSourceType = "invoice" | "vendor_bill" | "expense" | "payment"

/**
 * Each source family: where its row lives, the statuses that post, and the
 * projection source types its receipts and findings are recorded under.
 */
const FAMILIES: Record<BooksPostingSourceType, { table: string; projectable: readonly string[]; sourceTypes: string[] }> = {
  // A retainage release posts (and fails) under its own source type.
  invoice: { table: "invoices", projectable: BILLED_INVOICE_STATUSES, sourceTypes: ["invoice", "retainage_release"] },
  vendor_bill: { table: "vendor_bills", projectable: PAYABLE_VENDOR_BILL_STATUSES, sourceTypes: ["vendor_bill", "retainage_release"] },
  expense: { table: "project_expenses", projectable: POSTED_EXPENSE_STATUSES, sourceTypes: ["expense"] },
  payment: { table: "payments", projectable: POSTED_PAYMENT_STATUSES, sourceTypes: ["payment", "bill_payment", "invoice_payment", "customer_deposit_receipt", "customer_deposit_application"] },
}

export async function getBooksPostingStatus(input: { sourceType: BooksPostingSourceType; sourceId: string }) {
  const parsed = z.object({ sourceType: z.enum(["invoice", "vendor_bill", "expense", "payment"]), sourceId: z.string().uuid() }).parse(input)
  const family = FAMILIES[parsed.sourceType]
  const context = await requireOrgContext()
  const service = createServiceSupabaseClient()
  const { data: source, error } = await service.from(family.table)
    .select(parsed.sourceType === "payment" ? "id,project_id,status,updated_at,invoice_id" : "id,project_id,status,updated_at")
    .eq("org_id", context.orgId).eq("id", parsed.sourceId).single()
  if (error || !source) throw new Error("Accounting source not found")
  const row = z.object({ project_id: z.string().nullable(), status: z.string().nullable(), updated_at: z.string(), invoice_id: z.string().nullable().optional() }).parse(source)
  // Project documents follow the project's permissions; documents with no
  // project are company accounting and need Books read access.
  if (row.project_id) {
    const receivable = parsed.sourceType === "invoice" || (parsed.sourceType === "payment" && Boolean(row.invoice_id))
    await requireAuthorization({ permission: receivable ? "invoice.read" : "bill.read", userId: context.userId, orgId: context.orgId, projectId: row.project_id, supabase: context.supabase,
      resourceType: parsed.sourceType === "expense" ? "project_expense" : parsed.sourceType, resourceId: parsed.sourceId })
  } else {
    await requireBooksAuthorization({ permission: "books.read", userId: context.userId, orgId: context.orgId, supabase: context.supabase })
  }
  const { data: settings, error: settingsError } = await service.from("books_settings").select("workspace_enabled,arc_ledger_mode").eq("org_id", context.orgId).maybeSingle()
  if (settingsError) throw new Error("Unable to load accounting posture")
  if (!settings?.workspace_enabled || settings.arc_ledger_mode === "disabled") return null
  const [receiptResult, failureResult] = await Promise.all([
    service.from("books_projection_receipts").select("source_observed_at,checked_at,journal:journal_entries!books_projection_receipts_journal_id_fkey(id,status,entry_date)").eq("org_id", context.orgId).in("source_type", family.sourceTypes).eq("source_id", parsed.sourceId).order("checked_at", { ascending: false }).limit(1).maybeSingle(),
    service.from("accounting_reconciliation_items").select("category,details").eq("org_id", context.orgId).in("entity_type", family.sourceTypes).eq("entity_id", parsed.sourceId).in("category", ["projection_failed", "projection_blocked_by_closed_period"]).neq("status", "resolved").order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ])
  if (receiptResult.error || failureResult.error) throw new Error("Unable to verify accounting posting status")
  const receipt = receiptResult.data
  const journal = Array.isArray(receipt?.journal) ? receipt.journal[0] : receipt?.journal
  const state = resolveBooksPostingState({ sourceUpdatedAt: row.updated_at, sourceProjectable: family.projectable.includes(String(row.status)), receipt: receipt && journal ? { sourceObservedAt: receipt.source_observed_at, journalStatus: journal.status } : null, failureCategory: failureResult.data?.category })
  const details = z.object({ error: z.string().optional(), cure: z.string().optional(), href: z.string().optional() }).catch({}).parse(failureResult.data?.details ?? {})
  return {
    state,
    checkedAt: receipt?.checked_at ?? null,
    ledgerMode: settings.arc_ledger_mode as string,
    // Where the posting lives, so the person can open the actual journal.
    journalEntryDate: journal?.entry_date ?? null,
    journalHref: journal ? `/books/ledger?entry=${journal.id}` : null,
    finding: failureResult.data ? { cure: details.cure ?? null, error: details.error ?? null, href: details.href ?? null } : null,
  }
}
