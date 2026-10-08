import "server-only"
import { verifyBooksReversalHistory } from "@/lib/services/books/reversal-history"

import { z } from "zod"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireBooksAuthorization as requireAuthorization } from "@/lib/services/books/access"
import { checkFactJournals, factCheckSchema, FACT_CHECK_COLUMNS, type LedgerDifference } from "@/lib/services/books/fact-journal-check"
import { booksDigest } from "@/lib/services/books/hash"
import { proveProjectedSources, resolveProjectionVersion } from "@/lib/services/books/projector"
import { collectBooksRows } from "@/lib/services/books/paging"
import { requireOrgContext } from "@/lib/services/context"
import { recordLedgerProofFindings } from "@/lib/services/books/reconciliation"

/**
 * The orphan scan has no natural bound, so it is paged rather than capped, and
 * it still records `scan_capped` if it ever hits the ceiling — a determinism
 * drill that quietly examined the first 200 rows would report "passed" for a
 * ledger full of entries nobody projected.
 */
const ORPHAN_SCAN_PAGE_SIZE = 500
const ORPHAN_SCAN_LIMIT = 5000

export async function runLedgerRebuildDrillForOrg(orgId: string) {
  const service = createServiceSupabaseClient()
  const projectionVersion = await resolveProjectionVersion(orgId)
  const { data: run, error: runError } = await service.from("ledger_rebuild_runs").insert({ org_id: orgId, status: "running" }).select("id").single()
  if (runError) throw new Error(`Failed to start ledger rebuild drill: ${runError.message}`)
  const runId = z.object({ id: z.string().uuid() }).parse(run).id
  const differences: LedgerDifference[] = []
  let sourceFactCount = 0
  let rebuiltEntryCount = 0
  const rebuilt: unknown[] = []
  try {
    for (let from = 0; ; from += 250) {
      const { data, error } = await service.from("accounting_facts").select(FACT_CHECK_COLUMNS).eq("org_id", orgId).order("created_at").order("id").range(from, from + 249)
      if (error) throw new Error(error.message)
      const page = z.array(factCheckSchema).parse(data ?? [])
      sourceFactCount += page.length
      const checked = await checkFactJournals(orgId, page, projectionVersion)
      differences.push(...checked.differences)
      rebuilt.push(...checked.rebuilt)
      rebuiltEntryCount += checked.rebuilt.length
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
      const [debtEvents, assetEvents, depositBatches] = orphanIds.length > 0
        ? await Promise.all([
            service.from("books_debt_events").select("journal_entry_id").eq("org_id", orgId).in("journal_entry_id", orphanIds),
            service.from("books_fixed_asset_events").select("journal_entry_id").eq("org_id", orgId).in("journal_entry_id", orphanIds),
            service.from("books_deposit_batches").select("journal_entry_id").eq("org_id", orgId).eq("status", "posted").in("journal_entry_id", orphanIds),
          ])
        : [{ data: [], error: null }, { data: [], error: null }, { data: [], error: null }]
      if (debtEvents.error ?? assetEvents.error ?? depositBatches.error) throw new Error((debtEvents.error ?? assetEvents.error ?? depositBatches.error)?.message)
      const registeredEntryIds = new Set([
        ...(debtEvents.data ?? []).map((row) => String(row.journal_entry_id)),
        ...(assetEvents.data ?? []).map((row) => String(row.journal_entry_id)),
        ...(depositBatches.data ?? []).map((row) => String(row.journal_entry_id)),
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

    differences.push(...await verifyBooksReversalHistory(orgId))
    const rebuiltDigest = booksDigest(rebuilt)
    const status = differences.length === 0 ? "passed" : "failed"
    const { error: updateError } = await service.from("ledger_rebuild_runs").update({ status, source_fact_count: sourceFactCount, rebuilt_entry_count: rebuiltEntryCount, rebuilt_digest: rebuiltDigest, differences: differences.slice(0, 200), completed_at: new Date().toISOString() }).eq("org_id", orgId).eq("id", runId)
    if (updateError) throw new Error(updateError.message)
    // A capped scan is not a whole proof, so it cannot clear findings.
    if (!orphanScanCapped) await recordLedgerProofFindings(orgId, differences)
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

/** A full drill at least this often; nightly runs between prove only what changed. */
const FULL_DRILL_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * The narrowed proof of every source changed since `since`, recorded as a run.
 * Damage written around the application's timestamps is the full drill's job.
 */
export async function runLedgerProofSinceForOrg(orgId: string, since: string) {
  const service = createServiceSupabaseClient()
  const { data: run, error: runError } = await service.from("ledger_rebuild_runs").insert({ org_id: orgId, status: "running", scope: "changed_since", changed_since: since }).select("id").single()
  if (runError) throw new Error(`Failed to start ledger proof: ${runError.message}`)
  const runId = z.object({ id: z.string().uuid() }).parse(run).id
  try {
    const proof = await proveProjectedSources(orgId, { changedSince: since })
    const status = proof.differences.length === 0 ? "passed" : "failed"
    const { error } = await service.from("ledger_rebuild_runs").update({ status, source_fact_count: proof.sourcesChecked, rebuilt_entry_count: 0, differences: proof.differences.slice(0, 200), completed_at: new Date().toISOString() }).eq("org_id", orgId).eq("id", runId)
    if (error) throw new Error(error.message)
    return { runId, scope: "changed_since" as const, status, differences: proof.differences }
  } catch (error) {
    await service.from("ledger_rebuild_runs").update({ status: "failed", differences: [{ type: "run_error", message: error instanceof Error ? error.message : String(error) }], completed_at: new Date().toISOString() }).eq("org_id", orgId).eq("id", runId)
    throw error
  }
}

/**
 * The nightly ledger proof for every Books company, least recently proven first,
 * until `deadline`: the full rebuild drill when the last one is a week old, and
 * otherwise the narrowed proof of what changed since the last proof began. A
 * company not reached is reported, never counted as proven.
 */
export async function runScheduledLedgerRebuildDrills(options: { deadline?: number } = {}) {
  const service = createServiceSupabaseClient()
  // Shadow-mode organizations are drilled too. Restricting this to parallel and
  // official meant the determinism check never ran for anyone during the phase
  // where the ledger is least trusted and most likely to be wrong.
  const [{ data, error }, latestRuns] = await Promise.all([
    service.from("books_settings").select("org_id").eq("workspace_enabled", true).in("arc_ledger_mode", ["shadow", "parallel", "official"]).order("org_id"),
    collectBooksRows((from, to) => service.from("ledger_rebuild_runs").select("org_id, scope, started_at")
      .in("status", ["passed", "failed"]).gte("started_at", new Date(Date.now() - FULL_DRILL_INTERVAL_MS).toISOString())
      .order("started_at", { ascending: false }).order("id").range(from, to)),
  ])
  if (error) throw new Error(`Failed to load Books rebuild organizations: ${error.message}`)
  const lastProof = new Map<string, string>()
  const lastFull = new Map<string, string>()
  for (const row of latestRuns) {
    const orgId = String(row.org_id)
    if (!lastProof.has(orgId)) lastProof.set(orgId, String(row.started_at))
    if (row.scope === "full" && !lastFull.has(orgId)) lastFull.set(orgId, String(row.started_at))
  }
  const orgIds = (data ?? []).map((row) => String(row.org_id))
    .sort((left, right) => (lastProof.get(left) ?? "").localeCompare(lastProof.get(right) ?? "") || left.localeCompare(right))
  const results = []
  const unreached: string[] = []
  for (const orgId of orgIds) {
    if (options.deadline !== undefined && Date.now() >= options.deadline) { unreached.push(orgId); continue }
    const since = lastProof.get(orgId)
    results.push(lastFull.has(orgId) && since
      ? await runLedgerProofSinceForOrg(orgId, since)
      : { ...(await runLedgerRebuildDrillForOrg(orgId)), scope: "full" as const })
  }
  return { attempted: orgIds.length, results, unreached }
}
