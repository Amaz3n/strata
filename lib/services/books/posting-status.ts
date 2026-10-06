import "server-only"
import { z } from "zod"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireOrgContext } from "@/lib/services/context"
import { requireAuthorization } from "@/lib/services/authorization"
import { requireBooksAuthorization } from "@/lib/services/books/access"
import { resolveBooksPostingState } from "@/lib/services/books/posting-state"
import { BILLED_INVOICE_STATUSES, PAYABLE_VENDOR_BILL_STATUSES, POSTED_EXPENSE_STATUSES } from "@/lib/financials/ledger-status"

export async function getBooksPostingStatus(input: { sourceType: "invoice" | "vendor_bill" | "expense"; sourceId: string }) {
  const parsed = z.object({ sourceType: z.enum(["invoice", "vendor_bill", "expense"]), sourceId: z.string().uuid() }).parse(input)
  const context = await requireOrgContext()
  const service = createServiceSupabaseClient()
  const { data: source, error } = await service.from(parsed.sourceType === "invoice" ? "invoices" : parsed.sourceType === "expense" ? "project_expenses" : "vendor_bills")
    .select("id,project_id,status,updated_at").eq("org_id", context.orgId).eq("id", parsed.sourceId).single()
  if (error || !source) throw new Error("Accounting source not found")
  if (source.project_id) {
    await requireAuthorization({ permission: parsed.sourceType === "invoice" ? "invoice.read" : "bill.read", userId: context.userId, orgId: context.orgId, projectId: source.project_id, supabase: context.supabase, resourceType: parsed.sourceType === "expense" ? "project_expense" : parsed.sourceType, resourceId: parsed.sourceId })
  } else {
    await requireBooksAuthorization({ permission: "books.read", userId: context.userId, orgId: context.orgId, supabase: context.supabase })
  }
  const { data: settings, error: settingsError } = await service.from("books_settings").select("workspace_enabled,arc_ledger_mode").eq("org_id", context.orgId).maybeSingle()
  if (settingsError) throw new Error("Unable to load accounting posture")
  if (!settings?.workspace_enabled || settings.arc_ledger_mode === "disabled") return null
  // A retainage release posts (and fails) under its own source type.
  const sourceTypes = parsed.sourceType === "expense" ? ["expense"] : [parsed.sourceType, "retainage_release"]
  const [receiptResult, failureResult] = await Promise.all([
    service.from("books_projection_receipts").select("source_observed_at,checked_at,journal:journal_entries!books_projection_receipts_journal_id_fkey(status,entry_date)").eq("org_id", context.orgId).in("source_type", sourceTypes).eq("source_id", parsed.sourceId).order("checked_at", { ascending: false }).limit(1).maybeSingle(),
    service.from("accounting_reconciliation_items").select("category").eq("org_id", context.orgId).in("entity_type", sourceTypes).eq("entity_id", parsed.sourceId).in("category", ["projection_failed", "projection_blocked_by_closed_period"]).neq("status", "resolved").order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ])
  if (receiptResult.error || failureResult.error) throw new Error("Unable to verify accounting posting status")
  const receipt = receiptResult.data
  const journal = Array.isArray(receipt?.journal) ? receipt.journal[0] : receipt?.journal
  const projectable: readonly string[] = parsed.sourceType === "invoice" ? BILLED_INVOICE_STATUSES : parsed.sourceType === "expense" ? POSTED_EXPENSE_STATUSES : PAYABLE_VENDOR_BILL_STATUSES
  const state = resolveBooksPostingState({ sourceUpdatedAt: source.updated_at, sourceProjectable: projectable.includes(String(source.status)), receipt: receipt && journal ? { sourceObservedAt: receipt.source_observed_at, journalStatus: journal.status } : null, failureCategory: failureResult.data?.category })
  return { state, checkedAt: receipt?.checked_at ?? null, ledgerMode: settings.arc_ledger_mode as string }
}
