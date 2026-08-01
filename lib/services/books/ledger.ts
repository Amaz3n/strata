import "server-only"

import { z } from "zod"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireAuthorization } from "@/lib/services/authorization"
import { recordAudit } from "@/lib/services/audit"
import { CONSTRUCTION_CHART_TEMPLATE } from "@/lib/services/books/chart-of-accounts"
import { booksDigest } from "@/lib/services/books/hash"
import {
  assertBalancedJournalDraft,
  type AccountingFactDraft,
  type JournalEntryDraft,
} from "@/lib/services/books/types"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"

const idRowSchema = z.object({ id: z.string().uuid() })
const accountRowSchema = z.object({ id: z.string().uuid(), code: z.string() })
const journalRowSchema = z.object({
  id: z.string().uuid(),
  entry_date: z.string(),
  entry_kind: z.enum(["operational", "adjusting", "opening", "poc", "closing", "reversal"]),
  memo: z.string(),
  posting_key: z.string(),
  policy_version: z.number().int(),
  status: z.enum(["draft", "posted", "reversed"]),
})
const journalLineRowSchema = z.object({
  line_no: z.number().int(),
  debit_cents: z.number().int(),
  credit_cents: z.number().int(),
  description: z.string().nullable(),
  project_id: z.string().uuid().nullable(),
  company_id: z.string().uuid().nullable(),
  dimensions: z.record(z.unknown()),
  account: z.union([accountRowSchema, z.array(accountRowSchema)]),
})

async function requireBooksPermission(permission: string, orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requireAuthorization({
    permission,
    userId: context.userId,
    orgId: context.orgId,
    supabase: context.supabase,
    resourceType: "books",
    resourceId: context.orgId,
    logDecision: true,
  })
  return context
}

export async function initializeArcBooks(orgId?: string) {
  const context = await requireBooksPermission("books.manage", orgId)
  const service = createServiceSupabaseClient()

  const settingsResult = await service.from("books_settings").upsert({
    org_id: context.orgId,
    workspace_enabled: true,
    ledger_authority: "external",
    arc_ledger_mode: "shadow",
    external_sync_posture: "normal",
    functional_currency: "usd",
    reporting_basis: "accrual",
    active_policy_version: 1,
    created_by: context.userId,
    updated_by: context.userId,
  }, { onConflict: "org_id", ignoreDuplicates: true })
  if (settingsResult.error) throw new Error(`Failed to initialize Books settings: ${settingsResult.error.message}`)

  const chartResult = await service.from("gl_accounts").upsert(
    CONSTRUCTION_CHART_TEMPLATE.map((account) => ({
      org_id: context.orgId,
      code: account.code,
      name: account.name,
      account_type: account.accountType,
      subtype: account.subtype,
      normal_balance: account.normalBalance,
      cash_flow_category: account.cashFlowCategory ?? null,
      is_system: account.system,
      active: true,
      created_by: context.userId,
      updated_by: context.userId,
    })),
    { onConflict: "org_id,code", ignoreDuplicates: true },
  )
  if (chartResult.error) throw new Error(`Failed to initialize the Books chart: ${chartResult.error.message}`)

  await Promise.all([
    recordEvent({
      orgId: context.orgId,
      actorId: context.userId,
      eventType: "books.initialized",
      entityType: "books_settings",
      entityId: context.orgId,
      payload: { mode: "shadow", account_count: CONSTRUCTION_CHART_TEMPLATE.length },
    }),
    recordAudit({
      orgId: context.orgId,
      actorId: context.userId,
      action: "insert",
      entityType: "books_settings",
      entityId: context.orgId,
      after: { mode: "shadow", ledger_authority: "external" },
      source: "books.initialize",
    }),
  ])
}

async function resolveAccountIds(orgId: string, accountCodes: string[]) {
  const service = createServiceSupabaseClient()
  const uniqueCodes = Array.from(new Set(accountCodes))
  const { data, error } = await service
    .from("gl_accounts")
    .select("id, code")
    .eq("org_id", orgId)
    .eq("active", true)
    .in("code", uniqueCodes)
  if (error) throw new Error(`Failed to resolve GL accounts: ${error.message}`)
  const rows = z.array(accountRowSchema).parse(data ?? [])
  const byCode = new Map(rows.map((row) => [row.code, row.id]))
  const missing = uniqueCodes.filter((code) => !byCode.has(code))
  if (missing.length > 0) throw new Error(`Missing active GL accounts: ${missing.join(", ")}`)
  return byCode
}

async function findExistingFact(orgId: string, idempotencyKey: string) {
  const service = createServiceSupabaseClient()
  const { data, error } = await service
    .from("accounting_facts")
    .select("id")
    .eq("org_id", orgId)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle()
  if (error) throw new Error(`Failed to resolve accounting fact: ${error.message}`)
  return data ? idRowSchema.parse(data).id : null
}

export async function persistAccountingFact(input: AccountingFactDraft, orgId?: string) {
  const context = await requireBooksPermission("books.manage", orgId)
  const service = createServiceSupabaseClient()
  const payloadHash = booksDigest(input.payload)
  const idempotencyKey = booksDigest({
    orgId: context.orgId,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    sourceVersion: input.sourceVersion,
    payloadHash,
    policyVersion: input.policyVersion,
  })

  const existingId = await findExistingFact(context.orgId, idempotencyKey)
  if (existingId) return { id: existingId, created: false, payloadHash, idempotencyKey }

  const { data, error } = await service.from("accounting_facts").insert({
    org_id: context.orgId,
    source_type: input.sourceType,
    source_id: input.sourceId,
    source_version: input.sourceVersion,
    fact_kind: input.factKind,
    occurred_at: input.occurredAt,
    accounting_date: input.accountingDate,
    payload: input.payload,
    payload_hash: payloadHash,
    policy_version: input.policyVersion,
    supersedes_fact_id: input.supersedesFactId ?? null,
    reversal_of_fact_id: input.reversalOfFactId ?? null,
    idempotency_key: idempotencyKey,
    created_by: context.userId,
  }).select("id").single()
  if (error) {
    const racedId = await findExistingFact(context.orgId, idempotencyKey)
    if (racedId) return { id: racedId, created: false, payloadHash, idempotencyKey }
    throw new Error(`Failed to persist accounting fact: ${error.message}`)
  }

  const factId = idRowSchema.parse(data).id
  await recordEvent({
    orgId: context.orgId,
    actorId: context.userId,
    eventType: "books.fact_recorded",
    entityType: "accounting_fact",
    entityId: factId,
    payload: { source_type: input.sourceType, source_id: input.sourceId, source_version: input.sourceVersion },
  })
  return { id: factId, created: true, payloadHash, idempotencyKey }
}

async function findJournalByPostingKey(orgId: string, postingKey: string) {
  const service = createServiceSupabaseClient()
  const { data, error } = await service
    .from("journal_entries")
    .select("id")
    .eq("org_id", orgId)
    .eq("posting_key", postingKey)
    .maybeSingle()
  if (error) throw new Error(`Failed to resolve journal entry: ${error.message}`)
  return data ? idRowSchema.parse(data).id : null
}

async function postBooksJournalEntryInternal(input: {
  draft: JournalEntryDraft
  orgId: string
  actorId?: string | null
  factId?: string
}) {
  const { draft, orgId, actorId = null, factId } = input
  assertBalancedJournalDraft(draft)
  const existingId = await findJournalByPostingKey(orgId, draft.postingKey)
  if (existingId) return { id: existingId, created: false }

  const accountIds = await resolveAccountIds(orgId, draft.lines.map((item) => item.accountCode))
  const service = createServiceSupabaseClient()
  const { data, error } = await service.rpc("post_books_journal_entry", {
    p_org_id: orgId,
    p_entry: {
      fact_id: factId ?? null,
      entry_date: draft.entryDate,
      entry_kind: draft.entryKind,
      memo: draft.memo,
      posting_key: draft.postingKey,
      projection_version: 1,
      policy_version: draft.policyVersion,
      source_type: draft.sourceType ?? null,
      source_id: draft.sourceId ?? null,
      reversal_of_entry_id: draft.reversalOfEntryId ?? null,
      created_by: actorId,
    },
    p_lines: draft.lines.map((item, index) => ({
      line_no: index + 1,
      account_id: accountIds.get(item.accountCode),
      project_id: item.projectId ?? null,
      company_id: item.companyId ?? null,
      description: item.description ?? null,
      debit_cents: item.debitCents,
      credit_cents: item.creditCents,
      dimensions: item.dimensions ?? {},
    })),
  })
  if (error) {
    const racedId = await findJournalByPostingKey(orgId, draft.postingKey)
    if (racedId) return { id: racedId, created: false }
    throw new Error(`Failed to post journal entry: ${error.message}`)
  }
  const entryId = z.string().uuid().parse(data)
  await Promise.all([
    recordEvent({
      orgId,
      actorId,
      eventType: "books.journal_posted",
      entityType: "journal_entry",
      entityId: entryId,
      payload: { posting_key: draft.postingKey, entry_kind: draft.entryKind },
    }),
    recordAudit({
      orgId,
      actorId: actorId ?? undefined,
      action: "insert",
      entityType: "journal_entry",
      entityId: entryId,
      after: { posting_key: draft.postingKey, entry_date: draft.entryDate, entry_kind: draft.entryKind },
      source: "books.post",
    }),
  ])
  return { id: entryId, created: true }
}

export async function postBooksJournalEntry(
  draft: JournalEntryDraft,
  options: { factId?: string; permission?: "books.manage" | "books.adjust"; orgId?: string } = {},
) {
  const context = await requireBooksPermission(options.permission ?? "books.manage", options.orgId)
  return postBooksJournalEntryInternal({
    draft,
    orgId: context.orgId,
    actorId: context.userId,
    factId: options.factId,
  })
}

/** Service-job boundary. Callers must already have selected an organization-scoped fact. */
export async function postBooksJournalEntryForService(draft: JournalEntryDraft, orgId: string, factId?: string) {
  return postBooksJournalEntryInternal({ draft, orgId, factId })
}

export async function reverseBooksJournalEntry(input: {
  entryId: string
  reversalDate: string
  reason: string
  orgId?: string
}) {
  const context = await requireBooksPermission("books.adjust", input.orgId)
  const service = createServiceSupabaseClient()
  const [entryResult, linesResult] = await Promise.all([
    service
      .from("journal_entries")
      .select("id, entry_date, entry_kind, memo, posting_key, policy_version, status")
      .eq("org_id", context.orgId)
      .eq("id", input.entryId)
      .single(),
    service
      .from("journal_lines")
      .select("line_no, debit_cents, credit_cents, description, project_id, company_id, dimensions, account:gl_accounts!inner(id, code)")
      .eq("org_id", context.orgId)
      .eq("entry_id", input.entryId)
      .order("line_no"),
  ])
  if (entryResult.error) throw new Error(`Failed to load journal entry: ${entryResult.error.message}`)
  if (linesResult.error) throw new Error(`Failed to load journal lines: ${linesResult.error.message}`)
  const entry = journalRowSchema.parse(entryResult.data)
  if (entry.status !== "posted") throw new Error("Only a posted journal entry can be reversed")
  const lines = z.array(journalLineRowSchema).parse(linesResult.data ?? [])

  const draft: JournalEntryDraft = {
    entryDate: input.reversalDate,
    entryKind: "reversal",
    memo: `Reversal of ${entry.memo}: ${input.reason}`,
    postingKey: `reversal:${entry.id}:${booksDigest({ date: input.reversalDate, reason: input.reason }).slice(0, 20)}`,
    policyVersion: entry.policy_version,
    reversalOfEntryId: entry.id,
    lines: lines.map((item) => {
      const account = Array.isArray(item.account) ? item.account[0] : item.account
      if (!account) throw new Error("Journal line is missing its account")
      return {
        accountCode: account.code,
        debitCents: item.credit_cents,
        creditCents: item.debit_cents,
        projectId: item.project_id ?? undefined,
        companyId: item.company_id ?? undefined,
        description: item.description ?? undefined,
        dimensions: item.dimensions,
      }
    }),
  }
  return postBooksJournalEntry(draft, { permission: "books.adjust", orgId: context.orgId })
}
