import "server-only"

import { z } from "zod"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireAuthorization } from "@/lib/services/authorization"
import { booksDigest } from "@/lib/services/books/hash"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"

export type BankMatchCandidate = {
  bankTransactionId: string
  journalLineId: string
  bankDate: string
  journalDate: string
  amountCents: number
  counterparty?: string | null
  journalDescription?: string | null
  providerIdentityMatch?: boolean
}

function dateDistanceDays(left: string, right: string) {
  return Math.abs(new Date(`${left}T00:00:00Z`).getTime() - new Date(`${right}T00:00:00Z`).getTime()) / 86_400_000
}

export function scoreBankMatch(candidate: BankMatchCandidate) {
  const days = dateDistanceDays(candidate.bankDate, candidate.journalDate)
  let confidence = candidate.providerIdentityMatch ? 1 : 0.7
  if (!candidate.providerIdentityMatch) {
    if (days === 0) confidence += 0.15
    else if (days <= 2) confidence += 0.1
    else if (days <= 7) confidence += 0.03
    else confidence -= 0.25
    const left = candidate.counterparty?.trim().toLowerCase()
    const right = candidate.journalDescription?.trim().toLowerCase()
    if (left && right && (right.includes(left) || left.includes(right))) confidence += 0.1
  }
  return Math.max(0, Math.min(1, Math.round(confidence * 10000) / 10000))
}

async function requireReconciliationContext(orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requireAuthorization({
    permission: "books.reconcile",
    userId: context.userId,
    orgId: context.orgId,
    supabase: context.supabase,
    resourceType: "bank_reconciliation",
    resourceId: context.orgId,
    logDecision: true,
  })
  return context
}

export async function createBankReconciliation(input: {
  bankAccountId: string
  statementStart: string
  statementEnd: string
  beginningBalanceCents: number
  endingBalanceCents: number
  statementFileId?: string | null
  orgId?: string
}) {
  const context = await requireReconciliationContext(input.orgId)
  const service = createServiceSupabaseClient()
  const { data: account, error: accountError } = await service
    .from("bank_accounts")
    .select("id")
    .eq("org_id", context.orgId)
    .eq("id", input.bankAccountId)
    .single()
  if (accountError || !account) throw new Error("Bank account not found")
  const { data, error } = await service.from("bank_reconciliations").insert({
    org_id: context.orgId,
    bank_account_id: input.bankAccountId,
    statement_start: input.statementStart,
    statement_end: input.statementEnd,
    beginning_balance_cents: input.beginningBalanceCents,
    ending_balance_cents: input.endingBalanceCents,
    cleared_balance_cents: input.beginningBalanceCents,
    difference_cents: input.endingBalanceCents - input.beginningBalanceCents,
    status: "draft",
    statement_file_id: input.statementFileId ?? null,
  }).select("id").single()
  if (error) throw new Error(`Failed to create bank reconciliation: ${error.message}`)
  return z.object({ id: z.string().uuid() }).parse(data).id
}

export async function suggestBankMatches(input: {
  bankTransactionId: string
  orgId?: string
}) {
  const context = await requireReconciliationContext(input.orgId)
  const service = createServiceSupabaseClient()
  const { data: transactionData, error: transactionError } = await service
    .from("bank_transactions")
    .select("id, transaction_date, amount_cents, direction, merchant_name, description, bank_account:bank_accounts!inner(gl_account_id)")
    .eq("org_id", context.orgId)
    .eq("id", input.bankTransactionId)
    .single()
  if (transactionError) throw new Error(`Failed to load bank transaction: ${transactionError.message}`)
  const transaction = z.object({
    id: z.string().uuid(),
    transaction_date: z.string(),
    amount_cents: z.number().int(),
    direction: z.enum(["inflow", "outflow"]),
    merchant_name: z.string().nullable(),
    description: z.string(),
    bank_account: z.union([
      z.object({ gl_account_id: z.string().uuid().nullable() }),
      z.array(z.object({ gl_account_id: z.string().uuid().nullable() })),
    ]),
  }).parse(transactionData)
  const bankAccount = Array.isArray(transaction.bank_account) ? transaction.bank_account[0] : transaction.bank_account
  if (!bankAccount?.gl_account_id) return []
  const start = new Date(`${transaction.transaction_date}T00:00:00Z`)
  start.setUTCDate(start.getUTCDate() - 10)
  const end = new Date(`${transaction.transaction_date}T00:00:00Z`)
  end.setUTCDate(end.getUTCDate() + 10)
  const amountColumn = transaction.direction === "inflow" ? "debit_cents" : "credit_cents"
  const { data: candidates, error: candidateError } = await service
    .from("journal_lines")
    .select("id, debit_cents, credit_cents, description, entry:journal_entries!inner(entry_date, status)")
    .eq("org_id", context.orgId)
    .eq("account_id", bankAccount.gl_account_id)
    .eq(amountColumn, transaction.amount_cents)
    .eq("entry.status", "posted")
    .gte("entry.entry_date", start.toISOString().slice(0, 10))
    .lte("entry.entry_date", end.toISOString().slice(0, 10))
    .limit(25)
  if (candidateError) throw new Error(`Failed to load journal match candidates: ${candidateError.message}`)
  const candidateSchema = z.object({
    id: z.string().uuid(),
    debit_cents: z.number().int(),
    credit_cents: z.number().int(),
    description: z.string().nullable(),
    entry: z.union([z.object({ entry_date: z.string(), status: z.string() }), z.array(z.object({ entry_date: z.string(), status: z.string() }))]),
  })
  return z.array(candidateSchema).parse(candidates ?? []).map((candidate) => {
    const entry = Array.isArray(candidate.entry) ? candidate.entry[0] : candidate.entry
    if (!entry) throw new Error("Journal match candidate is missing its entry")
    const match = {
      bankTransactionId: transaction.id,
      journalLineId: candidate.id,
      bankDate: transaction.transaction_date,
      journalDate: entry.entry_date,
      amountCents: transaction.amount_cents,
      counterparty: transaction.merchant_name ?? transaction.description,
      journalDescription: candidate.description,
    }
    return { ...match, confidence: scoreBankMatch(match) }
  }).sort((left, right) => right.confidence - left.confidence)
}

export async function confirmBankMatch(input: {
  bankTransactionId: string
  journalLineId?: string | null
  amountCents: number
  matchType: "provider_identity" | "transfer" | "exact" | "suggested" | "manual_split" | "excluded"
  confidence?: number | null
  orgId?: string
}) {
  const context = await requireReconciliationContext(input.orgId)
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) throw new Error("Matched amount must be positive integer cents")
  const service = createServiceSupabaseClient()
  const { data: transaction, error: transactionError } = await service
    .from("bank_transactions")
    .select("id, amount_cents, lifecycle_status")
    .eq("org_id", context.orgId)
    .eq("id", input.bankTransactionId)
    .single()
  if (transactionError || !transaction) throw new Error("Bank transaction not found")
  if (transaction.lifecycle_status !== "posted") throw new Error("Only posted bank transactions can be confirmed")
  const { data: existingMatches, error: matchError } = await service
    .from("bank_transaction_matches")
    .select("matched_amount_cents")
    .eq("org_id", context.orgId)
    .eq("bank_transaction_id", input.bankTransactionId)
    .eq("status", "confirmed")
  if (matchError) throw new Error(`Failed to load bank matches: ${matchError.message}`)
  const alreadyMatched = (existingMatches ?? []).reduce((sum, row) => sum + Number(row.matched_amount_cents ?? 0), 0)
  if (alreadyMatched + input.amountCents > Number(transaction.amount_cents)) {
    throw new Error("Confirmed matches exceed the bank transaction amount")
  }
  const { data, error } = await service.from("bank_transaction_matches").insert({
    org_id: context.orgId,
    bank_transaction_id: input.bankTransactionId,
    journal_line_id: input.journalLineId ?? null,
    matched_amount_cents: input.amountCents,
    match_type: input.matchType,
    confidence: input.confidence ?? null,
    status: "confirmed",
    confirmed_by: context.userId,
    confirmed_at: new Date().toISOString(),
  }).select("id").single()
  if (error) throw new Error(`Failed to confirm bank match: ${error.message}`)
  return z.object({ id: z.string().uuid() }).parse(data).id
}

export async function closeBankReconciliation(reconciliationId: string, orgId?: string) {
  const context = await requireReconciliationContext(orgId)
  const service = createServiceSupabaseClient()
  const { data: reconciliationData, error: reconciliationError } = await service
    .from("bank_reconciliations")
    .select("id, bank_account_id, statement_start, statement_end, beginning_balance_cents, ending_balance_cents, status")
    .eq("org_id", context.orgId)
    .eq("id", reconciliationId)
    .single()
  if (reconciliationError) throw new Error(`Failed to load bank reconciliation: ${reconciliationError.message}`)
  const reconciliation = z.object({
    id: z.string().uuid(),
    bank_account_id: z.string().uuid(),
    statement_start: z.string(),
    statement_end: z.string(),
    beginning_balance_cents: z.number().int(),
    ending_balance_cents: z.number().int(),
    status: z.string(),
  }).parse(reconciliationData)
  if (reconciliation.status === "closed") return reconciliation.id

  const { data: transactions, error: transactionError } = await service
    .from("bank_transactions")
    .select("id, amount_cents, direction, excluded, matches:bank_transaction_matches(id, journal_line_id, matched_amount_cents, status)")
    .eq("org_id", context.orgId)
    .eq("bank_account_id", reconciliation.bank_account_id)
    .eq("lifecycle_status", "posted")
    .gte("transaction_date", reconciliation.statement_start)
    .lte("transaction_date", reconciliation.statement_end)
    .limit(5000)
  if (transactionError) throw new Error(`Failed to load reconciliation transactions: ${transactionError.message}`)
  const transactionSchema = z.object({
    id: z.string().uuid(),
    amount_cents: z.number().int(),
    direction: z.enum(["inflow", "outflow"]),
    excluded: z.boolean(),
    matches: z.array(z.object({
      id: z.string().uuid(),
      journal_line_id: z.string().uuid().nullable(),
      matched_amount_cents: z.number().int(),
      status: z.string(),
    })),
  })
  const rows = z.array(transactionSchema).parse(transactions ?? [])
  let clearedBalanceCents = reconciliation.beginning_balance_cents
  const items: Array<Record<string, unknown>> = []
  for (const transaction of rows) {
    const confirmed = transaction.matches.filter((match) => match.status === "confirmed")
    const matchedCents = confirmed.reduce((sum, match) => sum + match.matched_amount_cents, 0)
    const cleared = transaction.excluded || matchedCents === transaction.amount_cents
    if (cleared && !transaction.excluded) {
      clearedBalanceCents += transaction.direction === "inflow" ? transaction.amount_cents : -transaction.amount_cents
    }
    items.push({
      org_id: context.orgId,
      reconciliation_id: reconciliation.id,
      bank_transaction_id: transaction.id,
      journal_line_id: confirmed.length === 1 ? confirmed[0].journal_line_id : null,
      amount_cents: transaction.amount_cents,
      item_status: transaction.excluded ? "excluded" : cleared ? "cleared" : "outstanding",
    })
  }
  const differenceCents = reconciliation.ending_balance_cents - clearedBalanceCents
  if (differenceCents !== 0) throw new Error(`Reconciliation difference must be zero; current difference is ${differenceCents} cents`)
  if (items.length > 0) {
    const itemResult = await service.from("bank_reconciliation_items").upsert(items, {
      onConflict: "reconciliation_id,bank_transaction_id,journal_line_id",
    })
    if (itemResult.error) throw new Error(`Failed to save reconciliation items: ${itemResult.error.message}`)
  }
  const digest = booksDigest({ reconciliation, clearedBalanceCents, items })
  const closeResult = await service.from("bank_reconciliations").update({
    cleared_balance_cents: clearedBalanceCents,
    difference_cents: 0,
    status: "closed",
    digest,
    closed_by: context.userId,
    closed_at: new Date().toISOString(),
  }).eq("org_id", context.orgId).eq("id", reconciliation.id)
  if (closeResult.error) throw new Error(`Failed to close bank reconciliation: ${closeResult.error.message}`)
  await recordEvent({
    orgId: context.orgId,
    actorId: context.userId,
    eventType: "books.bank_reconciliation_closed",
    entityType: "bank_reconciliation",
    entityId: reconciliation.id,
    payload: { statement_end: reconciliation.statement_end, digest },
  })
  return reconciliation.id
}
