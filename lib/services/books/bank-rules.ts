import "server-only"

import { z } from "zod"

import { nextCodingRuleCounts } from "@/lib/services/accounting-rules"
import { requireAuthorization } from "@/lib/services/authorization"
import {
  buildBankRuleLesson,
  isBankRuleCorrection,
  normalizeBankRuleValue,
  type BankRuleCandidate,
} from "@/lib/services/books/bank-rule-matching"
import { confirmBankMatch } from "@/lib/services/books/bank-reconciliation"
import { ruleRowSchema } from "@/lib/services/books/bank-rules-data"
import { postBooksJournalEntryForService } from "@/lib/services/books/ledger"
import { requireOrgContext } from "@/lib/services/context"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

/**
 * Bank rules: categorize a feed transaction, and remember the decision.
 *
 * A Plaid feed without this is a list of things to type in twice. The rule is
 * learned from the categorization itself rather than authored up front — nobody
 * writes rules before they have seen the transactions — and it earns the right to
 * apply itself through the same confidence curve payables coding uses.
 */

async function requireBankRuleContext(orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requireAuthorization({
    permission: "books.reconcile",
    userId: context.userId,
    orgId: context.orgId,
    supabase: context.supabase,
    resourceType: "bank_rule",
    resourceId: context.orgId,
    logDecision: true,
  })
  return context
}

export async function listBankRules(orgId?: string) {
  const context = await requireBankRuleContext(orgId)
  const service = createServiceSupabaseClient()
  const { data, error } = await service
    .from("bank_rules")
    .select(
      "id, match_kind, match_value, direction, bank_account_id, gl_account_id, project_id, cost_code_id, confidence, hit_count, correction_count, active, " +
        "account:gl_accounts(code, name), bank_account:bank_accounts(name)",
    )
    .eq("org_id", context.orgId)
    .order("hit_count", { ascending: false })
    .limit(200)
  if (error) throw new Error(`Failed to load bank rules: ${error.message}`)

  const listedSchema = ruleRowSchema.extend({
    account: z
      .union([z.object({ code: z.string(), name: z.string() }), z.array(z.object({ code: z.string(), name: z.string() }))])
      .nullable(),
    bank_account: z.union([z.object({ name: z.string() }), z.array(z.object({ name: z.string() }))]).nullable(),
  })

  return z.array(listedSchema).parse(data ?? []).map((row) => {
    const account = Array.isArray(row.account) ? row.account[0] : row.account
    const bankAccount = Array.isArray(row.bank_account) ? row.bank_account[0] : row.bank_account
    return {
      id: row.id,
      matchKind: row.match_kind,
      matchValue: row.match_value,
      direction: row.direction,
      bankAccountName: bankAccount?.name ?? null,
      accountCode: account?.code ?? "",
      accountName: account?.name ?? "",
      confidence: row.confidence,
      hitCount: row.hit_count,
      correctionCount: row.correction_count,
      active: row.active,
    }
  })
}

export type BankRuleListing = Awaited<ReturnType<typeof listBankRules>>

export async function setBankRuleActive(input: { ruleId: string; active: boolean; orgId?: string }) {
  const context = await requireBankRuleContext(input.orgId)
  const service = createServiceSupabaseClient()
  const { error } = await service
    .from("bank_rules")
    .update({ active: input.active, updated_by: context.userId })
    .eq("org_id", context.orgId)
    .eq("id", input.ruleId)
  if (error) throw new Error(`Failed to update the bank rule: ${error.message}`)
  return { success: true as const }
}

/**
 * Categorize one bank transaction: post the entry it implies, match the
 * transaction to it, and learn the rule.
 *
 * The three happen together on purpose. Posting without matching leaves the
 * transaction in the tray forever; matching without posting matches against
 * nothing. Learning without either would teach a rule from a decision that did
 * not take effect.
 */
export async function categorizeBankTransaction(input: {
  bankTransactionId: string
  glAccountId: string
  projectId?: string | null
  memo?: string | null
  /** The rule that proposed this, when one did — so a change of mind reads as a correction. */
  appliedRuleId?: string | null
  learn?: boolean
  orgId?: string
}) {
  const context = await requireBankRuleContext(input.orgId)
  const service = createServiceSupabaseClient()

  const { data: transactionData, error: transactionError } = await service
    .from("bank_transactions")
    .select(
      "id, bank_account_id, transaction_date, amount_cents, direction, merchant_name, description, " +
        "bank_account:bank_accounts!inner(id, name, gl_account_id)",
    )
    .eq("org_id", context.orgId)
    .eq("id", input.bankTransactionId)
    .single()
  if (transactionError) throw new Error(`Failed to load the bank transaction: ${transactionError.message}`)
  const transaction = z
    .object({
      id: z.string().uuid(),
      bank_account_id: z.string().uuid(),
      transaction_date: z.string(),
      amount_cents: z.number().int(),
      direction: z.enum(["inflow", "outflow"]),
      merchant_name: z.string().nullable(),
      description: z.string(),
      bank_account: z.union([
        z.object({ id: z.string().uuid(), name: z.string(), gl_account_id: z.string().uuid().nullable() }),
        z.array(z.object({ id: z.string().uuid(), name: z.string(), gl_account_id: z.string().uuid().nullable() })),
      ]),
    })
    .parse(transactionData)
  const bankAccount = Array.isArray(transaction.bank_account) ? transaction.bank_account[0] : transaction.bank_account
  if (!bankAccount?.gl_account_id) {
    throw new Error("This bank account is not mapped to a GL account yet. Map it in Banking first.")
  }

  const { data: accountRows, error: accountError } = await service
    .from("gl_accounts")
    .select("id, code")
    .eq("org_id", context.orgId)
    .in("id", [input.glAccountId, bankAccount.gl_account_id])
  if (accountError) throw new Error(`Failed to resolve GL accounts: ${accountError.message}`)
  const codeById = new Map(
    z.array(z.object({ id: z.string().uuid(), code: z.string() })).parse(accountRows ?? []).map((row) => [row.id, row.code]),
  )
  const categoryCode = codeById.get(input.glAccountId)
  const cashCode = codeById.get(bankAccount.gl_account_id)
  if (!categoryCode) throw new Error("The chosen account does not exist in this organization's chart")
  if (!cashCode) throw new Error("The bank account's GL account does not exist in this organization's chart")

  const memo = (input.memo?.trim() || transaction.merchant_name || transaction.description || "Bank transaction").slice(0, 200)
  // Money out debits the category and credits the bank; money in is the reverse.
  const lines =
    transaction.direction === "outflow"
      ? [
          { accountCode: categoryCode, debitCents: transaction.amount_cents, creditCents: 0, projectId: input.projectId ?? undefined, description: memo },
          { accountCode: cashCode, debitCents: 0, creditCents: transaction.amount_cents, description: memo },
        ]
      : [
          { accountCode: cashCode, debitCents: transaction.amount_cents, creditCents: 0, description: memo },
          { accountCode: categoryCode, debitCents: 0, creditCents: transaction.amount_cents, projectId: input.projectId ?? undefined, description: memo },
        ]

  const posted = await postBooksJournalEntryForService(
    {
      entryDate: transaction.transaction_date,
      // A person decided this, so it reads as hand-posted in the audit view —
      // there is no operational fact behind a categorized bank line.
      entryKind: "adjusting",
      memo,
      postingKey: `bank_categorization:${transaction.id}`,
      projectionVersion: 1,
      policyVersion: 1,
      sourceType: "bank_transaction",
      sourceId: transaction.id,
      lines,
    },
    context.orgId,
  )

  // Match the transaction against the cash side of the entry we just posted, or
  // it stays in the tray having been paid for twice over.
  const { data: cashLineData, error: cashLineError } = await service
    .from("journal_lines")
    .select("id, account_id")
    .eq("org_id", context.orgId)
    .eq("entry_id", posted.id)
    .eq("account_id", bankAccount.gl_account_id)
    .limit(1)
    .maybeSingle()
  if (cashLineError) throw new Error(`Failed to resolve the posted cash line: ${cashLineError.message}`)
  if (!cashLineData) throw new Error("The posted entry has no cash line to match against")

  // Through `confirmBankMatch`, not a direct insert: it refuses unposted
  // transactions and refuses confirmations that would exceed the transaction
  // amount. Re-implementing the insert here would skip both guards.
  await confirmBankMatch({
    bankTransactionId: transaction.id,
    journalLineId: String(cashLineData.id),
    amountCents: transaction.amount_cents,
    matchType: "exact",
    confidence: 1,
    orgId: context.orgId,
  })

  if (input.learn !== false) {
    await learnBankRule({
      orgId: context.orgId,
      userId: context.userId,
      transaction,
      bankAccountId: transaction.bank_account_id,
      glAccountId: input.glAccountId,
      projectId: input.projectId ?? null,
      appliedRuleId: input.appliedRuleId ?? null,
    })
  }

  await Promise.all([
    recordEvent({
      orgId: context.orgId,
      actorId: context.userId,
      eventType: "books.bank_transaction_categorized",
      entityType: "bank_transaction",
      entityId: transaction.id,
      payload: { entry_id: posted.id, gl_account_id: input.glAccountId },
    }),
    recordAudit({
      orgId: context.orgId,
      actorId: context.userId,
      action: "update",
      entityType: "bank_transaction",
      entityId: transaction.id,
      after: { gl_account_id: input.glAccountId, entry_id: posted.id },
      source: "books.bank_categorization",
    }),
  ])

  return { entryId: posted.id }
}

/**
 * Create or reinforce the rule this categorization implies.
 *
 * `nextCodingRuleCounts` decides the new counts and confidence — the same curve
 * payables coding uses, where a correction resets the hit streak so the rule must
 * re-earn its confirmations while `correction_count` survives to damp confidence.
 */
async function learnBankRule(input: {
  orgId: string
  userId: string
  transaction: { merchant_name: string | null; description: string; direction: "inflow" | "outflow" }
  bankAccountId: string
  glAccountId: string
  projectId: string | null
  appliedRuleId: string | null
}) {
  const lesson = buildBankRuleLesson({
    merchantName: input.transaction.merchant_name,
    description: input.transaction.description,
  })
  if (!lesson) return

  const service = createServiceSupabaseClient()
  const { data: existingData, error: existingError } = await service
    .from("bank_rules")
    .select("id, gl_account_id, hit_count, correction_count")
    .eq("org_id", input.orgId)
    .eq("match_kind", lesson.matchKind)
    .eq("match_value", lesson.matchValue)
    .eq("bank_account_id", input.bankAccountId)
    .eq("direction", input.transaction.direction)
    .maybeSingle()
  if (existingError) throw new Error(`Failed to inspect the bank rule: ${existingError.message}`)

  const applied =
    input.appliedRuleId && existingData && String(existingData.id) === input.appliedRuleId
      ? { glAccountId: String(existingData.gl_account_id) }
      : null
  const corrected = isBankRuleCorrection({ applied, final: { glAccountId: input.glAccountId } })
  const counts = nextCodingRuleCounts({
    hitCount: Number(existingData?.hit_count ?? 0),
    correctionCount: Number(existingData?.correction_count ?? 0),
    corrected,
  })
  const now = new Date().toISOString()

  const { error } = await service.from("bank_rules").upsert(
    {
      org_id: input.orgId,
      match_kind: lesson.matchKind,
      match_value: normalizeBankRuleValue(lesson.matchValue),
      direction: input.transaction.direction,
      bank_account_id: input.bankAccountId,
      gl_account_id: input.glAccountId,
      project_id: input.projectId,
      hit_count: counts.hitCount,
      correction_count: counts.correctionCount,
      confidence: counts.confidence,
      last_hit_at: corrected ? (existingData ? undefined : now) : now,
      last_corrected_at: corrected ? now : undefined,
      active: true,
      created_by: existingData ? undefined : input.userId,
      updated_by: input.userId,
    },
    { onConflict: "org_id,match_kind,match_value,bank_account_id,direction" },
  )
  if (error) throw new Error(`Failed to learn the bank rule: ${error.message}`)

  await recordEvent({
    orgId: input.orgId,
    actorId: input.userId,
    eventType: corrected ? "books.bank_rule_corrected" : "books.bank_rule_learned",
    entityType: "bank_rule",
    entityId: existingData ? String(existingData.id) : lesson.matchValue,
    payload: { match_kind: lesson.matchKind, gl_account_id: input.glAccountId, confidence: counts.confidence },
  })
}
