import "server-only"
import { z } from "zod"
import { requireOrgContext } from "@/lib/services/context"
import { requireBooksAuthorization } from "@/lib/services/books/access"
import { buildGeneralLedger } from "@/lib/services/books/statements"
import { clearingLedgerDigest, clearingSupportMatches } from "@/lib/services/books/clearing-support-rules"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"

const supportSchema = z.object({
  code: z.enum(["1010", "2200", "2220", "2230"]), amountCents: z.number().int().safe().refine(value => value !== 0),
  expectedSettlementDate: z.string().date(), explanation: z.string().trim().min(10).max(2000),
  evidenceUrl: z.string().url().refine(value => value.startsWith("https://")),
})
export const clearingReviewSchema = z.object({
  ledgerDigest: z.string(), items: z.array(supportSchema), reviewerId: z.string().uuid(), reviewedAt: z.string(),
})

export async function loadClearingPosition(orgId: string, periodEnd: string) {
  const ledger = await buildGeneralLedger(orgId, "0001-01-01", periodEnd)
  const lines = ledger.rows.filter(row => ["1010", "2200", "2220", "2230"].includes(row.account?.code ?? ""))
  const balances = ["1010", "2200", "2220", "2230"].map(code => ({ code, balanceCents: lines.filter(row => row.account?.code === code).reduce((sum, row) => sum + (code === "1010" ? 1 : -1) * (row.debit_cents - row.credit_cents), 0) })).filter(row => row.balanceCents !== 0)
  return { balances, ledgerDigest: clearingLedgerDigest(lines), lines }
}
async function contextForClearing(periodId: string) {
  const context = await requireOrgContext()
  await requireBooksAuthorization({ permission: "books.close", userId: context.userId, orgId: context.orgId, supabase: context.supabase, resourceType: "accounting_period", resourceId: periodId, logDecision: true })
  const service = createServiceSupabaseClient()
  const { data, error } = await service.from("accounting_periods").select("id,period_end,status").eq("org_id", context.orgId).eq("id", z.string().uuid().parse(periodId)).single()
  if (error) throw new Error(`Failed to load period: ${error.message}`)
  return { context, service, period: z.object({ id: z.string(), period_end: z.string(), status: z.string() }).parse(data) }
}
export async function getClearingSupportWorkspace(periodId: string) {
  const { context, period } = await contextForClearing(periodId)
  return { periodEnd: period.period_end, ...await loadClearingPosition(context.orgId, period.period_end) }
}
export async function reviewClearingSupport(input: { periodId: string; ledgerDigest: string; items: z.input<typeof supportSchema>[] }) {
  const { context, service, period } = await contextForClearing(input.periodId)
  if (!["open", "reopened"].includes(period.status)) throw new Error("Reopen the period before reviewing its clearing balances")
  const position = await loadClearingPosition(context.orgId, period.period_end)
  const items = z.array(supportSchema).min(1).parse(input.items)
  if (position.ledgerDigest !== input.ledgerDigest) throw new Error("The clearing ledger changed. Reload and review the updated balances.")
  if (!clearingSupportMatches(position.balances, items, period.period_end)) throw new Error("The supported amounts must explain every clearing balance exactly, with a document and a settlement date after period end")
  const review = { ledgerDigest: position.ledgerDigest, items, reviewerId: context.userId, reviewedAt: new Date().toISOString() }
  const { error } = await service.from("books_close_items").upsert({ org_id: context.orgId, period_id: period.id, code: "clearing_accounts", label: "Clearing balances supported", category: "clearing", blocking: true, status: "pending", support_review: review, acknowledged_by: context.userId, acknowledged_at: review.reviewedAt }, { onConflict: "period_id,code" })
  if (error) throw new Error(`Failed to save clearing support: ${error.message}`)
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "accounting_period", entityId: period.id, after: review, source: "books.clearing_support" })
  await recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "books.clearing_support_reviewed", entityType: "accounting_period", entityId: period.id, payload: { ledger_digest: review.ledgerDigest } })
  return { reviewed: true }
}
