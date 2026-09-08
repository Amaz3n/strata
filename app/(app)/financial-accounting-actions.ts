"use server"

import { z } from "zod"
import { runAction } from "@/lib/action-result"
import { requireOrgContext } from "@/lib/services/context"
import { requireAuthorization } from "@/lib/services/authorization"
import { getFinancialAccountingMode } from "@/lib/services/financial-accounting"
import { accountingExperience } from "@/lib/financials/accounting-experience"
import { hasPermission } from "@/lib/services/permissions"

const sourceSchema = z.object({ type: z.enum(["vendor_bill", "expense", "invoice"]), id: z.string().uuid() })

/** Resolve the source first; a journal source id is never an authorization boundary. */
export async function loadFinancialRecordAccountingAction(input: z.infer<typeof sourceSchema>) {
  return runAction(async () => {
    const source = sourceSchema.parse(input)
    const { supabase, orgId, userId } = await requireOrgContext()
    const table = source.type === "vendor_bill" ? "vendor_bills" : source.type === "expense" ? "project_expenses" : "invoices"
    const { data: record, error } = await supabase.from(table).select("id, project_id, status")
      .eq("org_id", orgId).eq("id", source.id).maybeSingle()
    if (error) throw new Error(`Unable to load accounting source: ${error.message}`)
    if (!record) throw new Error("Financial record not found")
    await requireAuthorization({
      permission: source.type === "invoice" ? "invoice.read" : "bill.read", userId, orgId, supabase,
      projectId: record.project_id ?? undefined, resourceType: source.type, resourceId: source.id,
    })
    const mode = await getFinancialAccountingMode(orgId, record.project_id ?? undefined)
    const policy = accountingExperience(mode)
    const canReadBooks = policy.showBooks && await hasPermission("books.read", { orgId, userId, supabase })
    const [entries, sync] = await Promise.all([
      canReadBooks ? supabase.from("journal_entries")
        .select("id, entry_date, status, posted_at, reversal_of_entry_id")
        .eq("org_id", orgId).eq("source_type", source.type).eq("source_id", source.id)
        .order("created_at", { ascending: false }).limit(20).throwOnError()
        : Promise.resolve({ data: [] }),
      policy.showExternalSync ? supabase.from("accounting_sync_records")
        .select("id, provider, connection_id, status, last_synced_at, error_message, external_id")
        .eq("org_id", orgId).eq("entity_type", source.type === "vendor_bill" ? "bill" : source.type === "expense" ? "project_expense" : "invoice")
        .eq("entity_id", source.id).order("last_synced_at", { ascending: false }).limit(5).throwOnError()
        : Promise.resolve({ data: [] }),
    ])
    return { mode, canReadBooks, sourceStatus: record.status, entries: entries.data ?? [], sync: sync.data ?? [] }
  })
}
