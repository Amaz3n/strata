import "server-only"

import { randomUUID } from "node:crypto"
import { z } from "zod"

import { parseBankStatement } from "@/lib/financials/bank-statement-import"
import { getBankFeedProvider } from "@/lib/integrations/banking/registry"
import type { BankFeedTransaction } from "@/lib/integrations/banking/provider"
import { decryptIntegrationSecret, encryptIntegrationSecret } from "@/lib/integrations/secrets"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { recordAudit } from "@/lib/services/audit"
import { requireBooksAuthorization as requireAuthorization } from "@/lib/services/books/access"
import { booksDigest } from "@/lib/services/books/hash"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"

const connectionSchema = z.object({
  id: z.string().uuid(),
  org_id: z.string().uuid(),
  provider: z.literal("plaid"),
  external_item_id: z.string(),
  secret_ref: z.string(),
  cursor: z.string().nullable(),
})

async function requireBankContext(orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requireAuthorization({
    permission: "books.reconcile",
    userId: context.userId,
    orgId: context.orgId,
    supabase: context.supabase,
    resourceType: "bank_feed",
    resourceId: context.orgId,
    logDecision: true,
  })
  return context
}

function webhookUrl() {
  const raw = process.env.NEXT_PUBLIC_APP_URL ?? process.env.VERCEL_URL
  if (!raw) throw new Error("NEXT_PUBLIC_APP_URL or VERCEL_URL is required for Plaid webhooks")
  const base = raw.startsWith("http") ? raw : `https://${raw}`
  return `${base.replace(/\/$/, "")}/api/webhooks/plaid`
}

export async function createPlaidLinkToken(orgId?: string) {
  const context = await requireBankContext(orgId)
  const service = createServiceSupabaseClient()
  const { data: org, error } = await service.from("orgs").select("name").eq("id", context.orgId).single()
  if (error) throw new Error(`Failed to load organization: ${error.message}`)
  return getBankFeedProvider("plaid").createLinkToken({
    clientUserId: `${context.orgId}:${context.userId}`,
    organizationName: org.name ?? "Arc",
    webhookUrl: webhookUrl(),
  })
}

export async function connectPlaidItem(input: {
  publicToken: string
  institutionId?: string | null
  institutionName?: string | null
  orgId?: string
}) {
  const context = await requireBankContext(input.orgId)
  const provider = getBankFeedProvider("plaid")
  const exchanged = await provider.exchangePublicToken(input.publicToken)
  const accounts = await provider.listAccounts(exchanged.accessToken)
  const service = createServiceSupabaseClient()
  const { data, error } = await service.from("bank_feed_connections").upsert({
    org_id: context.orgId,
    provider: "plaid",
    external_item_id: exchanged.itemId,
    secret_ref: encryptIntegrationSecret(exchanged.accessToken),
    institution_id: input.institutionId ?? null,
    institution_name: input.institutionName ?? null,
    status: "active",
    connected_by: context.userId,
    connected_at: new Date().toISOString(),
  }, { onConflict: "provider,external_item_id" }).select("id").single()
  if (error) throw new Error(`Failed to save Plaid connection: ${error.message}`)
  const connectionId = z.object({ id: z.string().uuid() }).parse(data).id
  const accountResult = await service.from("bank_accounts").upsert(accounts.map((account) => ({
    org_id: context.orgId,
    connection_id: connectionId,
    provider: "plaid",
    external_account_id: account.externalAccountId,
    name: account.name,
    official_name: account.officialName,
    mask: account.mask,
    account_type: account.type,
    account_subtype: account.subtype,
    currency: account.currency,
    current_balance_cents: account.currentBalanceCents,
    available_balance_cents: account.availableBalanceCents,
    balance_as_of: new Date().toISOString(),
    active: true,
  })), { onConflict: "connection_id,external_account_id" })
  if (accountResult.error) throw new Error(`Failed to save Plaid accounts: ${accountResult.error.message}`)
  await recordEvent({
    orgId: context.orgId,
    actorId: context.userId,
    eventType: "books.bank_feed_connected",
    entityType: "bank_feed_connection",
    entityId: connectionId,
    payload: { provider: "plaid", account_count: accounts.length },
  })
  await syncBankFeedConnection(connectionId)
  return { connectionId, accountCount: accounts.length }
}

/** Bind a normalized feed account to the GL control account it represents. */
export async function mapBankAccountToGl(input: {
  bankAccountId: string
  glAccountId: string
  orgId?: string
}) {
  const context = await requireBankContext(input.orgId)
  const service = createServiceSupabaseClient()
  const [bankResult, glResult] = await Promise.all([
    service.from("bank_accounts").select("id, name, account_type, gl_account_id")
      .eq("org_id", context.orgId).eq("id", input.bankAccountId).single(),
    service.from("gl_accounts").select("id, code, name, account_type, subtype, active")
      .eq("org_id", context.orgId).eq("id", input.glAccountId).single(),
  ])
  if (bankResult.error || !bankResult.data) throw new Error("Bank account not found")
  if (glResult.error || !glResult.data) throw new Error("Ledger account not found")
  if (!glResult.data.active) throw new Error("Choose an active ledger account")

  const allowed = bankResult.data.account_type === "credit"
    ? glResult.data.account_type === "liability" && glResult.data.subtype === "credit_card"
    : bankResult.data.account_type === "loan"
      ? glResult.data.account_type === "liability" && new Set(["current_debt", "long_term_debt"]).has(glResult.data.subtype)
      : glResult.data.account_type === "asset" && new Set(["cash", "undeposited_funds", "other_asset"]).has(glResult.data.subtype)
  if (!allowed) {
    throw new Error(
      bankResult.data.account_type === "credit"
        ? "Credit-card feeds must map to a credit-card liability account"
        : bankResult.data.account_type === "loan"
          ? "Loan feeds must map to a current- or long-term debt account"
          : "Bank feeds must map to a cash or other-asset account",
    )
  }

  const { error } = await service.from("bank_accounts")
    .update({ gl_account_id: glResult.data.id })
    .eq("org_id", context.orgId).eq("id", bankResult.data.id)
  if (error) throw new Error(`Failed to map bank account: ${error.message}`)

  await Promise.all([
    recordEvent({
      orgId: context.orgId,
      actorId: context.userId,
      eventType: "books.bank_account_mapped",
      entityType: "bank_account",
      entityId: bankResult.data.id,
      payload: { gl_account_id: glResult.data.id, gl_account_code: glResult.data.code },
    }),
    recordAudit({
      orgId: context.orgId,
      actorId: context.userId,
      action: "update",
      entityType: "bank_account",
      entityId: bankResult.data.id,
      before: { gl_account_id: bankResult.data.gl_account_id },
      after: { gl_account_id: glResult.data.id, gl_account_code: glResult.data.code, gl_account_name: glResult.data.name },
      source: "books.banking",
    }),
  ])
  return { bankAccountId: bankResult.data.id, glAccountId: glResult.data.id }
}

export async function createManualBankAccount(input: {
  name: string
  accountType: "depository" | "credit" | "loan" | "investment" | "other"
  glAccountId: string
  lastFour?: string | null
  orgId?: string
}) {
  const context = await requireBankContext(input.orgId)
  const parsed = z.object({
    name: z.string().trim().min(2).max(120),
    accountType: z.enum(["depository", "credit", "loan", "investment", "other"]),
    glAccountId: z.string().uuid(),
    lastFour: z.string().regex(/^\d{4}$/).nullable().optional(),
  }).parse(input)
  const service = createServiceSupabaseClient()
  const externalItemId = `manual:${context.orgId}:${randomUUID()}`
  const { data: connection, error: connectionError } = await service.from("bank_feed_connections").insert({
    org_id: context.orgId,
    provider: "file",
    external_item_id: externalItemId,
    secret_ref: "manual:no-credential",
    institution_name: "Statement import",
    status: "active",
    connected_by: context.userId,
  }).select("id").single()
  if (connectionError || !connection) throw new Error(`Failed to create manual bank connection: ${connectionError?.message}`)
  let accountId: string | null = null
  try {
    const externalAccountId = `manual:${randomUUID()}`
    const { data: account, error: accountError } = await service.from("bank_accounts").insert({
      org_id: context.orgId,
      connection_id: connection.id,
      provider: "file",
      external_account_id: externalAccountId,
      name: parsed.name,
      mask: parsed.lastFour ?? null,
      account_type: parsed.accountType,
      currency: "usd",
      active: true,
    }).select("id").single()
    if (accountError || !account) throw new Error(`Failed to create manual bank account: ${accountError?.message}`)
    accountId = account.id
    await mapBankAccountToGl({ bankAccountId: account.id, glAccountId: parsed.glAccountId, orgId: context.orgId })
  } catch (error) {
    if (accountId) await service.from("bank_accounts").delete().eq("org_id", context.orgId).eq("id", accountId)
    await service.from("bank_feed_connections").delete().eq("org_id", context.orgId).eq("id", connection.id)
    throw error
  }
  await recordEvent({
    orgId: context.orgId,
    actorId: context.userId,
    eventType: "books.manual_bank_account_created",
    entityType: "bank_account",
    entityId: accountId!,
    payload: { name: parsed.name, account_type: parsed.accountType },
  })
  return { bankAccountId: accountId! }
}

export async function importBankStatement(input: {
  bankAccountId: string
  contents: string
  positiveDirection?: "inflow" | "outflow"
  fileName?: string | null
  orgId?: string
}) {
  const context = await requireBankContext(input.orgId)
  const parsed = z.object({
    bankAccountId: z.string().uuid(),
    contents: z.string().min(1).max(5_000_000),
    positiveDirection: z.enum(["inflow", "outflow"]).default("inflow"),
    fileName: z.string().trim().max(255).nullable().optional(),
  }).parse(input)
  const rows = parseBankStatement(parsed.contents, parsed.positiveDirection)
  const service = createServiceSupabaseClient()
  const { data: account, error: accountError } = await service.from("bank_accounts")
    .select("id, gl_account_id, name")
    .eq("org_id", context.orgId).eq("id", parsed.bankAccountId).eq("active", true).single()
  if (accountError || !account) throw new Error("Bank account not found")
  if (!account.gl_account_id) throw new Error("Map the bank account to its ledger control account before importing")

  let imported = 0
  let duplicates = 0
  for (let offset = 0; offset < rows.length; offset += 500) {
    const batch = rows.slice(offset, offset + 500).map((row, index) => {
      const externalId = `statement:${booksDigest({
        orgId: context.orgId,
        bankAccountId: account.id,
        sourceId: row.sourceId,
        date: row.date,
        description: row.description,
        amountCents: row.amountCents,
        ordinal: row.sourceId ? null : offset + index,
      })}`
      return { row, externalId }
    })
    const { data: existing, error: existingError } = await service.from("bank_transactions")
      .select("external_transaction_id")
      .eq("org_id", context.orgId).eq("provider", "file")
      .in("external_transaction_id", batch.map((item) => item.externalId))
    if (existingError) throw new Error(`Failed to check statement duplicates: ${existingError.message}`)
    const existingIds = new Set((existing ?? []).map((item) => item.external_transaction_id))
    const pending = batch.filter((item) => !existingIds.has(item.externalId))
    duplicates += batch.length - pending.length
    if (pending.length === 0) continue
    const { data: inserted, error: insertError } = await service.from("bank_transactions").insert(
      pending.map(({ row, externalId }) => ({
        org_id: context.orgId,
        bank_account_id: account.id,
        provider: "file",
        external_transaction_id: externalId,
        lifecycle_status: "posted",
        transaction_date: row.date,
        amount_cents: Math.abs(row.amountCents),
        direction: row.amountCents > 0 ? "inflow" : "outflow",
        currency: "usd",
        merchant_name: row.merchantName,
        description: row.description,
        category: [],
      })),
    ).select("id, external_transaction_id")
    if (insertError) throw new Error(`Failed to import bank statement: ${insertError.message}`)
    const sourceByExternalId = new Map(pending.map((item) => [item.externalId, item.row]))
    const revisions = (inserted ?? []).map((transaction) => {
      const source = sourceByExternalId.get(transaction.external_transaction_id)
      if (!source) throw new Error("Imported transaction lost its source row")
      return {
        org_id: context.orgId,
        bank_transaction_id: transaction.id,
        revision: 1,
        change_kind: "added",
        payload_hash: booksDigest(source),
        normalized_payload: source,
      }
    })
    if (revisions.length > 0) {
      const revisionResult = await service.from("bank_transaction_revisions").insert(revisions)
      if (revisionResult.error) throw new Error(`Failed to record statement audit rows: ${revisionResult.error.message}`)
    }
    imported += inserted?.length ?? 0
  }
  await Promise.all([
    recordEvent({
      orgId: context.orgId,
      actorId: context.userId,
      eventType: "books.bank_statement_imported",
      entityType: "bank_account",
      entityId: account.id,
      payload: { file_name: parsed.fileName ?? null, rows: rows.length, imported, duplicates },
    }),
    recordAudit({
      orgId: context.orgId,
      actorId: context.userId,
      action: "insert",
      entityType: "bank_statement_import",
      entityId: account.id,
      after: { file_name: parsed.fileName ?? null, rows: rows.length, imported, duplicates },
      source: "books.banking",
    }),
  ])
  return { rows: rows.length, imported, duplicates }
}

async function accountMap(orgId: string, connectionId: string) {
  const service = createServiceSupabaseClient()
  const { data, error } = await service
    .from("bank_accounts")
    .select("id, external_account_id")
    .eq("org_id", orgId)
    .eq("connection_id", connectionId)
  if (error) throw new Error(`Failed to load bank accounts: ${error.message}`)
  const rows = z.array(z.object({ id: z.string().uuid(), external_account_id: z.string() })).parse(data ?? [])
  return new Map(rows.map((account) => [account.external_account_id, account.id]))
}

async function applyTransactionChange(input: {
  orgId: string
  accountIds: Map<string, string>
  transaction: BankFeedTransaction
  changeKind: "added" | "modified"
  eventId?: string
}) {
  const service = createServiceSupabaseClient()
  const bankAccountId = input.accountIds.get(input.transaction.externalAccountId)
  if (!bankAccountId) throw new Error(`Unknown Plaid account ${input.transaction.externalAccountId}`)
  const { data: existing, error: loadError } = await service
    .from("bank_transactions")
    .select("id, latest_revision, lifecycle_status")
    .eq("provider", "plaid")
    .eq("external_transaction_id", input.transaction.externalTransactionId)
    .maybeSingle()
  if (loadError) throw new Error(`Failed to load bank transaction: ${loadError.message}`)
  const payloadHash = booksDigest(input.transaction.raw)
  if (existing?.id) {
    const { data: duplicate, error: duplicateError } = await service
      .from("bank_transaction_revisions")
      .select("id")
      .eq("org_id", input.orgId)
      .eq("bank_transaction_id", existing.id)
      .eq("payload_hash", payloadHash)
      .maybeSingle()
    if (duplicateError) throw new Error(`Failed to inspect bank transaction revision: ${duplicateError.message}`)
    if (duplicate) {
      await service.from("bank_transactions").update({ last_seen_at: new Date().toISOString() }).eq("org_id", input.orgId).eq("id", existing.id)
      return
    }
  }
  const revision = Number(existing?.latest_revision ?? 0) + 1
  const pendingPosted = existing?.lifecycle_status === "pending" && input.transaction.lifecycleStatus === "posted"
  const row = {
    org_id: input.orgId,
    bank_account_id: bankAccountId,
    provider: "plaid",
    external_transaction_id: input.transaction.externalTransactionId,
    lifecycle_status: input.transaction.lifecycleStatus,
    transaction_date: input.transaction.transactionDate,
    authorized_date: input.transaction.authorizedDate,
    amount_cents: input.transaction.amountCents,
    direction: input.transaction.direction,
    currency: input.transaction.currency,
    merchant_name: input.transaction.merchantName,
    description: input.transaction.description,
    pending_external_id: input.transaction.pendingExternalId,
    category: input.transaction.category,
    latest_revision: revision,
    last_seen_at: new Date().toISOString(),
  }
  const result = existing?.id
    ? await service.from("bank_transactions").update(row).eq("org_id", input.orgId).eq("id", existing.id).select("id").single()
    : await service.from("bank_transactions").insert(row).select("id").single()
  if (result.error) throw new Error(`Failed to save bank transaction: ${result.error.message}`)
  const transactionId = z.object({ id: z.string().uuid() }).parse(result.data).id
  const revisionResult = await service.from("bank_transaction_revisions").upsert({
    org_id: input.orgId,
    bank_transaction_id: transactionId,
    revision,
    change_kind: pendingPosted ? "pending_posted" : input.changeKind,
    payload_hash: payloadHash,
    normalized_payload: input.transaction.raw,
    provider_event_id: input.eventId ?? null,
  }, { onConflict: "bank_transaction_id,payload_hash", ignoreDuplicates: true })
  if (revisionResult.error) throw new Error(`Failed to save bank transaction revision: ${revisionResult.error.message}`)
}

async function applyRemovedTransaction(orgId: string, externalTransactionId: string, eventId?: string) {
  const service = createServiceSupabaseClient()
  const { data, error } = await service
    .from("bank_transactions")
    .select("id, latest_revision")
    .eq("org_id", orgId)
    .eq("provider", "plaid")
    .eq("external_transaction_id", externalTransactionId)
    .maybeSingle()
  if (error) throw new Error(`Failed to load removed transaction: ${error.message}`)
  if (!data) return
  const parsed = z.object({ id: z.string().uuid(), latest_revision: z.number().int() }).parse(data)
  const { data: current } = await service.from("bank_transactions").select("lifecycle_status").eq("org_id", orgId).eq("id", parsed.id).single()
  if (current?.lifecycle_status === "removed") return
  const revision = parsed.latest_revision + 1
  const updateResult = await service.from("bank_transactions").update({
    lifecycle_status: "removed",
    latest_revision: revision,
    last_seen_at: new Date().toISOString(),
  }).eq("org_id", orgId).eq("id", parsed.id)
  if (updateResult.error) throw new Error(`Failed to remove bank transaction: ${updateResult.error.message}`)
  const revisionResult = await service.from("bank_transaction_revisions").insert({
    org_id: orgId,
    bank_transaction_id: parsed.id,
    revision,
    change_kind: "removed",
    payload_hash: booksDigest({ externalTransactionId, revision, removed: true }),
    normalized_payload: { external_transaction_id: externalTransactionId, removed: true },
    provider_event_id: eventId ?? null,
  })
  if (revisionResult.error) throw new Error(`Failed to record removed transaction: ${revisionResult.error.message}`)
}

export async function syncBankFeedConnection(connectionId: string, eventId?: string) {
  const service = createServiceSupabaseClient()
  const { data, error } = await service
    .from("bank_feed_connections")
    .select("id, org_id, provider, external_item_id, secret_ref, cursor")
    .eq("id", connectionId)
    .eq("status", "active")
    .single()
  if (error) throw new Error(`Failed to load bank-feed connection: ${error.message}`)
  const connection = connectionSchema.parse(data)
  const provider = getBankFeedProvider(connection.provider)
  const accessToken = decryptIntegrationSecret(connection.secret_ref)
  const accountIds = await accountMap(connection.org_id, connection.id)
  let cursor = connection.cursor
  let added = 0
  let modified = 0
  let removed = 0
  do {
    const page = await provider.syncTransactions(accessToken, cursor)
    for (const transaction of page.added) {
      await applyTransactionChange({ orgId: connection.org_id, accountIds, transaction, changeKind: "added", eventId })
      added += 1
    }
    for (const transaction of page.modified) {
      await applyTransactionChange({ orgId: connection.org_id, accountIds, transaction, changeKind: "modified", eventId })
      modified += 1
    }
    for (const externalId of page.removedExternalIds) {
      await applyRemovedTransaction(connection.org_id, externalId, eventId)
      removed += 1
    }
    cursor = page.nextCursor
    const cursorResult = await service.from("bank_feed_connections").update({
      cursor,
      last_refresh_at: new Date().toISOString(),
      last_error: null,
    }).eq("org_id", connection.org_id).eq("id", connection.id)
    if (cursorResult.error) throw new Error(`Failed to advance Plaid cursor: ${cursorResult.error.message}`)
    if (!page.hasMore) break
  } while (true)
  return { added, modified, removed, cursor }
}

export async function receivePlaidWebhook(rawBody: string, verificationHeader: string | null) {
  const provider = getBankFeedProvider("plaid")
  if (!await provider.verifyWebhook(rawBody, verificationHeader)) return null
  const payload = z.object({
    webhook_type: z.string(),
    webhook_code: z.string(),
    item_id: z.string().optional(),
  }).passthrough().parse(JSON.parse(rawBody))
  const service = createServiceSupabaseClient()
  const connectionResult = payload.item_id
    ? await service.from("bank_feed_connections").select("id, org_id").eq("provider", "plaid").eq("external_item_id", payload.item_id).maybeSingle()
    : { data: null, error: null }
  if (connectionResult.error) throw new Error(`Failed to resolve Plaid item: ${connectionResult.error.message}`)
  if (!connectionResult.data) return { accepted: true, stored: false }
  const { data: moduleSettings, error: moduleError } = await service
    .from("books_settings")
    .select("workspace_enabled")
    .eq("org_id", connectionResult.data.org_id)
    .maybeSingle()
  if (moduleError) throw new Error(`Failed to resolve Arc Books state: ${moduleError.message}`)
  if (!moduleSettings?.workspace_enabled) return { accepted: true, stored: false }
  const eventKey = `${payload.webhook_type}:${payload.webhook_code}:${payload.item_id ?? "none"}`
  const payloadHash = booksDigest(rawBody)
  const { data, error } = await service.from("bank_feed_events").upsert({
    org_id: connectionResult.data.org_id,
    connection_id: connectionResult.data.id,
    provider: "plaid",
    provider_event_id: eventKey,
    event_type: `${payload.webhook_type}.${payload.webhook_code}`,
    signature_verified: true,
    payload_hash: payloadHash,
    payload,
    processing_status: "pending",
  }, { onConflict: "provider,provider_event_id,payload_hash", ignoreDuplicates: true }).select("id").maybeSingle()
  if (error) throw new Error(`Failed to persist Plaid webhook: ${error.message}`)
  return { accepted: true, stored: Boolean(data) }
}

export async function processPendingBankFeedEvents(limit = 25) {
  const service = createServiceSupabaseClient()
  const { data, error } = await service
    .from("bank_feed_events")
    .select("id, org_id, connection_id, event_type, attempt_count")
    .eq("provider", "plaid")
    .in("processing_status", ["pending", "failed"])
    .lt("attempt_count", 8)
    .order("received_at")
    .limit(limit)
  if (error) throw new Error(`Failed to load Plaid events: ${error.message}`)
  const orgIds = Array.from(new Set((data ?? []).map((row) => row.org_id)))
  const { data: enabledSettings, error: settingsError } = orgIds.length > 0
    ? await service.from("books_settings").select("org_id").eq("workspace_enabled", true).in("org_id", orgIds)
    : { data: [], error: null }
  if (settingsError) throw new Error(`Failed to load Arc Books state: ${settingsError.message}`)
  const enabledOrgIds = new Set((enabledSettings ?? []).map((row) => row.org_id))
  let processed = 0
  const failures: Array<{ eventId: string; error: string }> = []
  for (const row of data ?? []) {
    if (!enabledOrgIds.has(row.org_id)) {
      await service.from("bank_feed_events").update({ processing_status: "ignored", processed_at: new Date().toISOString() }).eq("id", row.id)
      continue
    }
    const { data: claimed, error: claimError } = await service.from("bank_feed_events").update({
      processing_status: "processing",
      attempt_count: Number(row.attempt_count ?? 0) + 1,
    }).eq("id", row.id).in("processing_status", ["pending", "failed"]).select("id").maybeSingle()
    if (claimError) {
      failures.push({ eventId: row.id, error: claimError.message })
      continue
    }
    if (!claimed) continue
    try {
      if (String(row.event_type).startsWith("TRANSACTIONS.")) {
        await syncBankFeedConnection(row.connection_id, row.id)
      }
      await service.from("bank_feed_events").update({ processing_status: "processed", processed_at: new Date().toISOString() }).eq("id", row.id)
      processed += 1
    } catch (eventError) {
      const message = eventError instanceof Error ? eventError.message : String(eventError)
      await service.from("bank_feed_events").update({ processing_status: "failed", error_message: message }).eq("id", row.id)
      failures.push({ eventId: row.id, error: message })
    }
  }
  return { attempted: data?.length ?? 0, processed, failures }
}
