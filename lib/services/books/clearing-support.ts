import "server-only"
import { z } from "zod"
import { requireOrgContext } from "@/lib/services/context"
import { requireBooksAuthorization } from "@/lib/services/books/access"
import { clearingLedgerDigest, clearingSupportMatches, type ClearingAccountPosition } from "@/lib/services/books/clearing-support-rules"
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

const CLEARING_CODES = ["1010", "2200", "2220", "2230"]

/** Clearing balances at period end, summed in the database with a fingerprint of their lines. */
export async function loadClearingPosition(orgId: string, periodEnd: string) {
  const { data, error } = await createServiceSupabaseClient().rpc("books_account_positions", { p_org_id: orgId, p_as_of: periodEnd, p_codes: CLEARING_CODES })
  if (error) throw new Error(`Failed to load clearing balances: ${error.message}`)
  const positions: ClearingAccountPosition[] = z.array(z.object({ code: z.string(), debit_cents: z.coerce.number().int(), credit_cents: z.coerce.number().int(), line_count: z.coerce.number().int(), lines_digest: z.string() }))
    .parse(data ?? []).map(row => ({ code: row.code, debitCents: row.debit_cents, creditCents: row.credit_cents, lineCount: row.line_count, linesDigest: row.lines_digest }))
  const balances = CLEARING_CODES.map(code => {
    const position = positions.find(row => row.code === code)
    return { code, balanceCents: position ? (code === "1010" ? 1 : -1) * (position.debitCents - position.creditCents) : 0 }
  }).filter(row => row.balanceCents !== 0)
  return { balances, ledgerDigest: clearingLedgerDigest(positions) }
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
