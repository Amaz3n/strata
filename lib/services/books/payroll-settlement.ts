import "server-only"
import { z } from "zod"
import { requireOrgContext } from "@/lib/services/context"
import { requireBooksAuthorization } from "@/lib/services/books/access"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { collectBooksRows } from "@/lib/services/books/paging"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"

async function settlementContext() {
  const context = await requireOrgContext()
  await requireBooksAuthorization({ permission: "books.adjust", userId: context.userId, orgId: context.orgId, supabase: context.supabase, logDecision: true })
  return context
}
export async function getPayrollSettlementAccounts() {
  const context = await settlementContext()
  const service = createServiceSupabaseClient()
  return collectBooksRows((from, to) => service.from("gl_accounts").select("id,code,name").eq("org_id", context.orgId).eq("active", true).eq("subtype", "cash").eq("account_type", "asset").order("id").range(from, to))
}
const settlementSchema = z.object({ clearingCode: z.enum(["2200", "2220", "2230"]), cashAccountId: z.string().uuid(), date: z.string().date(), grossCents: z.number().int().safe().positive(), withheldCents: z.number().int().safe().nonnegative(), reference: z.string().trim().min(3).max(120), evidenceUrl: z.string().url().refine(value => value.startsWith("https://")) })
export async function recordPayrollSettlement(input: z.input<typeof settlementSchema>) {
  const parsed = settlementSchema.parse(input)
  const context = await settlementContext()
  const { data, error } = await createServiceSupabaseClient().rpc("post_books_clearing_settlement", { p_org_id: context.orgId, p_clearing_code: parsed.clearingCode, p_cash_account_id: parsed.cashAccountId, p_date: parsed.date, p_gross_cents: parsed.grossCents, p_withheld_cents: parsed.withheldCents, p_reference: parsed.reference, p_evidence_url: parsed.evidenceUrl, p_actor_id: context.userId })
  if (error) throw new Error(`Failed to record settlement: ${error.message}`)
  const id = z.string().uuid().parse(data)
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "insert", entityType: "journal_entry", entityId: id, after: parsed, source: "books.payroll_settlement" })
  await recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "books.payroll_settlement_recorded", entityType: "journal_entry", entityId: id, payload: { gross_cents: parsed.grossCents, withheld_cents: parsed.withheldCents } })
  return { id }
}
