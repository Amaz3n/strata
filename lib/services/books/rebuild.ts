import "server-only"

import { z } from "zod"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireAuthorization } from "@/lib/services/authorization"
import { draftFromFact, isRetiredFactKind } from "@/lib/services/books/fact-drafts"
import { booksDigest } from "@/lib/services/books/hash"
import { resolveProjectionVersion } from "@/lib/services/books/projector"
import type { JournalEntryDraft } from "@/lib/services/books/types"
import { requireOrgContext } from "@/lib/services/context"

/**
 * The orphan scan has no natural bound, so it is paged rather than capped, and
 * it still records `scan_capped` if it ever hits the ceiling — a determinism
 * drill that quietly examined the first 200 rows would report "passed" for a
 * ledger full of entries nobody projected.
 */
const ORPHAN_SCAN_PAGE_SIZE = 500
const ORPHAN_SCAN_LIMIT = 5000

const factSchema = z.object({
  id: z.string().uuid(),
  source_type: z.string(),
  source_id: z.string().uuid(),
  source_version: z.number().int(),
  fact_kind: z.string(),
  accounting_date: z.string(),
  policy_version: z.number().int(),
  payload: z.record(z.unknown()),
})

function normalizedDraft(draft: JournalEntryDraft) {
  return {
    entryDate: draft.entryDate,
    entryKind: draft.entryKind,
    memo: draft.memo,
    postingKey: draft.postingKey,
    policyVersion: draft.policyVersion,
    lines: draft.lines.map((line) => ({ accountCode: line.accountCode, projectId: line.projectId ?? null, companyId: line.companyId ?? null, debitCents: line.debitCents, creditCents: line.creditCents, description: line.description ?? null, dimensions: line.dimensions ?? {} })),
  }
}

export async function runLedgerRebuildDrillForOrg(orgId: string) {
  const service = createServiceSupabaseClient()
  const projectionVersion = await resolveProjectionVersion(orgId)
  const { data: run, error: runError } = await service.from("ledger_rebuild_runs").insert({ org_id: orgId, status: "running" }).select("id").single()
  if (runError) throw new Error(`Failed to start ledger rebuild drill: ${runError.message}`)
  const runId = z.object({ id: z.string().uuid() }).parse(run).id
  const differences: Array<Record<string, unknown>> = []
  let sourceFactCount = 0
  let rebuiltEntryCount = 0
  const rebuilt: unknown[] = []
  try {
    for (let from = 0; ; from += 250) {
      const { data, error } = await service.from("accounting_facts").select("id, source_type, source_id, source_version, fact_kind, accounting_date, policy_version, payload").eq("org_id", orgId).order("created_at").order("id").range(from, from + 249)
      if (error) throw new Error(error.message)
      const page = z.array(factSchema).parse(data ?? [])
      sourceFactCount += page.length
      // A retirement fact records that a source left the projectable set. Its
      // entry was already reversed, so producing no draft is the right answer,
      // not an unsupported fact kind.
      const facts = page.filter((fact) => !isRetiredFactKind(fact.fact_kind))
      const ids = facts.map((fact) => fact.id)
      const { data: entries, error: entryError } = ids.length > 0
        ? await service.from("journal_entries").select("id, fact_id, entry_date, entry_kind, memo, posting_key, policy_version, lines:journal_lines(line_no, project_id, company_id, debit_cents, credit_cents, description, dimensions, account:gl_accounts(code))").eq("org_id", orgId).in("fact_id", ids).eq("status", "posted")
        : { data: [], error: null }
      if (entryError) throw new Error(entryError.message)
      const entryByFact = new Map((entries ?? []).map((entry) => [entry.fact_id, entry]))
      for (const fact of facts) {
        let expected: JournalEntryDraft | null = null
        try {
          expected = draftFromFact({
            sourceType: fact.source_type,
            sourceId: fact.source_id,
            accountingDate: fact.accounting_date,
            payload: fact.payload,
            sourceVersion: fact.source_version,
            projectionVersion,
            policyVersion: fact.policy_version,
          })
        } catch (error) {
          differences.push({ fact_id: fact.id, type: "invalid_fact", message: error instanceof Error ? error.message : String(error) })
          continue
        }
        if (!expected) {
          differences.push({ fact_id: fact.id, type: "unsupported_fact_kind", source_type: fact.source_type })
          continue
        }
        const actual = entryByFact.get(fact.id)
        if (!actual) {
          differences.push({ fact_id: fact.id, type: "missing_journal" })
          continue
        }
        const actualLines = (actual.lines ?? []).sort((left, right) => left.line_no - right.line_no).map((line) => {
          const account = Array.isArray(line.account) ? line.account[0] : line.account
          return { accountCode: account?.code, projectId: line.project_id ?? null, companyId: line.company_id ?? null, debitCents: Number(line.debit_cents), creditCents: Number(line.credit_cents), description: line.description ?? null, dimensions: line.dimensions ?? {} }
        })
        const actualNormalized = { entryDate: actual.entry_date, entryKind: actual.entry_kind, memo: actual.memo, postingKey: actual.posting_key, policyVersion: actual.policy_version, lines: actualLines }
        const expectedNormalized = normalizedDraft(expected)
        rebuilt.push(expectedNormalized)
        rebuiltEntryCount += 1
        if (booksDigest(actualNormalized) !== booksDigest(expectedNormalized)) differences.push({ fact_id: fact.id, type: "journal_divergence", expected: expectedNormalized, actual: actualNormalized })
      }
      if (page.length < 250) break
    }
    // The drill also has to look the other way. Iterating facts alone can only
    // ever report a missing journal, so an operational entry posted without a
    // fact behind it — anything that bypassed the projector — would be
    // invisible. Adjusting, opening, closing and reversal entries are authored
    // deliberately and are expected to have no fact.
    let orphanScanCapped = false
    for (let from = 0; ; from += ORPHAN_SCAN_PAGE_SIZE) {
      const { data: orphanEntries, error: orphanError } = await service
        .from("journal_entries")
        .select("id, posting_key, entry_date")
        .eq("org_id", orgId)
        .eq("status", "posted")
        .eq("entry_kind", "operational")
        .is("fact_id", null)
        .order("entry_date", { ascending: true })
        .order("id", { ascending: true })
        .range(from, from + ORPHAN_SCAN_PAGE_SIZE - 1)
      if (orphanError) throw new Error(orphanError.message)
      const orphanPage = orphanEntries ?? []
      const orphanIds = orphanPage.map((entry) => entry.id)
      const [debtEvents, assetEvents] = orphanIds.length > 0
        ? await Promise.all([
            service.from("books_debt_events").select("journal_entry_id").eq("org_id", orgId).in("journal_entry_id", orphanIds),
            service.from("books_fixed_asset_events").select("journal_entry_id").eq("org_id", orgId).in("journal_entry_id", orphanIds),
          ])
        : [{ data: [], error: null }, { data: [], error: null }]
      if (debtEvents.error ?? assetEvents.error) throw new Error((debtEvents.error ?? assetEvents.error)?.message)
      const registeredEntryIds = new Set([
        ...(debtEvents.data ?? []).map((row) => String(row.journal_entry_id)),
        ...(assetEvents.data ?? []).map((row) => String(row.journal_entry_id)),
      ])
      for (const entry of orphanPage) {
        if (registeredEntryIds.has(String(entry.id))) continue
        differences.push({ type: "unexpected_journal", entry_id: entry.id, posting_key: entry.posting_key, entry_date: entry.entry_date })
      }
      if (orphanPage.length < ORPHAN_SCAN_PAGE_SIZE) break
      if (from + ORPHAN_SCAN_PAGE_SIZE >= ORPHAN_SCAN_LIMIT) {
        orphanScanCapped = true
        break
      }
    }
    // Recorded first so it survives the evidence cap below: a truncated scan that
    // lost its own truncation marker is exactly the failure this replaces.
    if (orphanScanCapped) {
      differences.unshift({ type: "orphan_scan_capped", scan_capped: true, scanned: ORPHAN_SCAN_LIMIT })
    }

    const rebuiltDigest = booksDigest(rebuilt)
    const status = differences.length === 0 ? "passed" : "failed"
    const { error: updateError } = await service.from("ledger_rebuild_runs").update({ status, source_fact_count: sourceFactCount, rebuilt_entry_count: rebuiltEntryCount, rebuilt_digest: rebuiltDigest, differences: differences.slice(0, 200), completed_at: new Date().toISOString() }).eq("org_id", orgId).eq("id", runId)
    if (updateError) throw new Error(updateError.message)
    return { runId, status, sourceFactCount, rebuiltEntryCount, rebuiltDigest, differences, orphanScanCapped }
  } catch (error) {
    await service.from("ledger_rebuild_runs").update({ status: "failed", source_fact_count: sourceFactCount, rebuilt_entry_count: rebuiltEntryCount, differences: [{ type: "run_error", message: error instanceof Error ? error.message : String(error) }], completed_at: new Date().toISOString() }).eq("org_id", orgId).eq("id", runId)
    throw error
  }
}

export async function requestLedgerRebuildDrill(orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requireAuthorization({ permission: "books.export", userId: context.userId, orgId: context.orgId, supabase: context.supabase, resourceType: "ledger_rebuild", resourceId: context.orgId, logDecision: true })
  return runLedgerRebuildDrillForOrg(context.orgId)
}

export async function runScheduledLedgerRebuildDrills() {
  const service = createServiceSupabaseClient()
  // Shadow-mode organizations are drilled too. Restricting this to parallel and
  // official meant the determinism check never ran for anyone during the phase
  // where the ledger is least trusted and most likely to be wrong.
  const { data, error } = await service.from("books_settings").select("org_id").eq("workspace_enabled", true).in("arc_ledger_mode", ["shadow", "parallel", "official"]).order("org_id")
  if (error) throw new Error(`Failed to load Books rebuild organizations: ${error.message}`)
  const results = []
  for (const row of data ?? []) results.push(await runLedgerRebuildDrillForOrg(row.org_id))
  return { attempted: data?.length ?? 0, results }
}
