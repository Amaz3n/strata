import { hasInvalidWipInputs } from "@/lib/financials/wip-validation"
import { wipSourcesCurrent } from "@/lib/services/books/wip-source-evidence"
import { assertReviewedWipUnchanged, wipSnapshotEvidence, type WipSnapshotEvidence, exactPeriodPosition, requireRecognitionDate } from "@/lib/services/books/wip-period-rules"
import "server-only"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { SYSTEM_ACCOUNT_CODES } from "@/lib/services/books/chart-of-accounts"
import { pocRevenueAllocationDeltas } from "@/lib/services/books/poc-revenue-allocations"
import type { InvoiceRevenueLine } from "@/lib/services/books/invoice-revenue-rules"
import { postBooksJournalEntryForService } from "@/lib/services/books/ledger"
import { postRevenueRecognition } from "@/lib/services/books/posting-rules"
import { loadPocProjectsForPeriod } from "@/lib/services/books/wip-project-scope"
import { loadPocPositionsAsOf } from "@/lib/services/poc"
import { recordEvent } from "@/lib/services/events"
import { todayIsoDateOnly } from "@/lib/services/reports/dates"

/**
 * Percentage-of-completion revenue recognition.
 *
 * Billing a customer is not revenue: an invoice credits `2350 Contract
 * liabilities`. This service converts the earned portion into revenue by
 * debiting `2350` and crediting `4000 Construction revenue`. What remains in
 * `2350` for a project is therefore `billings − earned` — a credit balance is
 * billings in excess, a debit balance is costs in excess.
 *
 * Recognition is cumulative-to-date and posted incrementally: the delta is
 * always `earned to date − already recognized to date`, so a period that is
 * reopened and re-closed tops up rather than double-counting, and a re-run with
 * nothing to recognize posts nothing at all. Closing-basis projects (production
 * spec homes) are excluded — their revenue is booked by the sale.
 *
 * Posting always uses the exact period-end snapshot, including when closing
 * today. Operational live previews are not posting evidence. Older snapshots
 * are insufficient because they omit the remainder of the accounting period.
 * Missing period-end evidence is returned as a blocking result.
 */

export type RevenueRecognitionSkipReason =
  | "no_poc_inputs"
  | "no_delta"
  | "missing_contract_value"
  | "invalid_wip_inputs"
  | "no_snapshot"
  | "period_evidence_incomplete"

export type RevenueRecognitionResult = {
  projectId: string
  earnedRevenueCents: number
  recognizedBeforeCents: number
  deltaCents: number
  posted: boolean
  skippedReason?: RevenueRecognitionSkipReason
}

function periodKeyFor(periodEnd: string) {
  return periodEnd.slice(0, 7)
}

const RECOGNIZED_REVENUE_PAGE_SIZE = 1000

/**
 * Revenue already recognized per project, on or before `asOf`.
 *
 * Paged. Unpaginated, this stopped at PostgREST's 1000-row default and
 * understated what had already been recognized — which overstates the delta and
 * recognizes the same revenue a second time, compounding at every close.
 */
async function loadRecognizedRevenueByProject(orgId: string, asOf: string) {
  const service = createServiceSupabaseClient()
  const byProject = new Map<string, InvoiceRevenueLine[]>()
  for (let from = 0; ; from += RECOGNIZED_REVENUE_PAGE_SIZE) {
    const { data, error } = await service
      .from("journal_lines")
      .select("id, project_id, debit_cents, credit_cents, dimensions, entry:journal_entries!journal_lines_entry_owner_fk!inner(status, entry_date, entry_kind, source_type, original:reversal_of_entry_id(source_type)), account:gl_accounts!journal_lines_account_owner_fk!inner(code)")
      .eq("org_id", orgId)
      .eq("account.account_type", "income")
      .in("entry.status", ["posted", "reversed"])
      .lte("entry.entry_date", asOf)
      .order("id", { ascending: true })
      .range(from, from + RECOGNIZED_REVENUE_PAGE_SIZE - 1)
    if (error) throw new Error(`Failed to load recognized revenue: ${error.message}`)
    const page = data ?? []
    for (const row of page) {
      if (!row.project_id) continue
      const account = Array.isArray(row.account) ? row.account[0] : row.account
      const entry = Array.isArray(row.entry) ? row.entry[0] : row.entry
      const original = Array.isArray(entry?.original) ? entry.original[0] : entry?.original
      if (!account || !entry || entry.entry_kind === "closing") continue
      // Preserve legacy 4000 balances, including imported opening revenue. Other
      // income is POC only when its journal (or reversed original) owns recognition.
      if (account.code !== SYSTEM_ACCOUNT_CODES.constructionRevenue && entry.source_type !== "revenue_recognition" && original?.source_type !== "revenue_recognition") continue
      const projectId = String(row.project_id)
      const net = Number(BigInt(row.credit_cents ?? 0) - BigInt(row.debit_cents ?? 0))
      if (!Number.isSafeInteger(net)) throw new Error("Recognized POC revenue exceeds safe integer cents")
      const lines = byProject.get(projectId) ?? []
      lines.push({ account_code: account.code, amount_cents: net, dimensions: row.dimensions as Record<string, unknown> | undefined })
      byProject.set(projectId, lines)
    }
    if (page.length < RECOGNIZED_REVENUE_PAGE_SIZE) break
  }
  return byProject
}

/** How many recognition entries this project already has for this period. */
async function countPeriodRecognitions(orgId: string, projectId: string, periodKey: string) {
  const service = createServiceSupabaseClient()
  const { count, error } = await service
    .from("journal_entries")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("source_type", "revenue_recognition")
    .like("posting_key", `revenue_recognition:${projectId}:${periodKey}:%`)
  if (error) throw new Error(`Failed to count revenue recognitions: ${error.message}`)
  return count ?? 0
}

async function resolveVersions(orgId: string) {
  const service = createServiceSupabaseClient()
  const [settings, policy] = await Promise.all([
    service.from("books_settings").select("workspace_enabled, arc_ledger_mode, active_policy_version").eq("org_id", orgId).single(),
    service.from("accounting_policies").select("version").eq("org_id", orgId).eq("status", "approved").order("version", { ascending: false }).limit(1).maybeSingle(),
  ])
  if (settings.error) throw new Error(`Failed to load Books settings: ${settings.error.message}`)
  if (policy.error) throw new Error(`Failed to resolve the projection version: ${policy.error.message}`)
  return {
    enabled: settings.data.workspace_enabled && settings.data.arc_ledger_mode !== "disabled",
    policyVersion: Number(settings.data.active_policy_version),
    projectionVersion: policy.data?.version ? Number(policy.data.version) : 1,
  }
}

/**
 * Recognizes revenue for every percentage-of-completion project in the
 * organization as of `periodEnd` (an ISO date, normally a month end).
 *
 * Contract for `books/period-close.ts`: call this with the period's
 * `period_end`, AFTER the blocking checklist has passed — the `poc_snapshots`
 * gate is what guarantees every POC project has a snapshot on that
 * date. `projectsWithoutSnapshot` is non-empty only when that guarantee was not
 * met, and those projects recognized nothing; treat it as a close-blocking
 * condition rather than as information.
 */
export async function recognizeRevenueForPeriod(orgId: string, periodEnd: string, expectedProjectIds?: string[], reviewedSnapshots?: WipSnapshotEvidence[]) {
  const { enabled, policyVersion, projectionVersion } = await resolveVersions(orgId)
  requireRecognitionDate(periodEnd, todayIsoDateOnly())
  const basis = "snapshot" as const
  if (!enabled) {
    return { periodEnd, basis, recognized: 0, postedCents: 0, projectsWithoutSnapshot: [] as string[], results: [] as RevenueRecognitionResult[] }
  }

  const periodKey = periodKeyFor(periodEnd)
  const [pocProjects, recognizedLinesByProject] = await Promise.all([
    loadPocProjectsForPeriod(orgId, periodEnd),
    loadRecognizedRevenueByProject(orgId, periodEnd),
  ])
  const recognizedByProject = new Map([...recognizedLinesByProject].map(([projectId, rows]) => {
    const total = Number(rows.reduce((sum, row) => sum + BigInt(row.amount_cents), BigInt(0)))
    if (!Number.isSafeInteger(total)) throw new Error("Recognized POC revenue exceeds safe integer cents")
    return [projectId, total] as const
  }))
  if (expectedProjectIds) {
    const expected = [...new Set(expectedProjectIds)].sort()
    const actual = pocProjects.map(project => project.projectId).sort()
    if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error("WIP project population changed after close review; rerun the checklist")
  }
  const snapshots = await loadPocPositionsAsOf({ orgId, projectIds: pocProjects.map((row) => row.projectId), asOf: periodEnd })

  if (reviewedSnapshots) assertReviewedWipUnchanged(reviewedSnapshots, wipSnapshotEvidence(snapshots, pocProjects.map(project => project.projectId)))

  const results: RevenueRecognitionResult[] = []
  const projectsWithoutSnapshot: string[] = []
  // Validate every project's evidence before posting any project's delta. A
  // missing position must not leave a partly recognized failed close attempt.
  const invalid = pocProjects.filter(project => {
    const position = exactPeriodPosition(snapshots.get(project.projectId), periodEnd)
    return !position || hasInvalidWipInputs(position.warnings)
  })
  if (invalid.length) {
    for (const project of pocProjects) {
      const position = exactPeriodPosition(snapshots.get(project.projectId), periodEnd)
      if (!position) projectsWithoutSnapshot.push(project.projectId)
      results.push({
        projectId: project.projectId,
        earnedRevenueCents: position?.earnedRevenueCents ?? 0,
        recognizedBeforeCents: recognizedByProject.get(project.projectId) ?? 0,
        deltaCents: 0,
        posted: false,
        skippedReason: !position ? "no_snapshot" : position.warnings.includes("missing_contract_value") ? "missing_contract_value" : hasInvalidWipInputs(position.warnings) ? "invalid_wip_inputs" : "period_evidence_incomplete",
      })
    }
    return { periodEnd, basis, recognized: 0, postedCents: 0, projectsWithoutSnapshot, results }
  }
  if (!await wipSourcesCurrent(createServiceSupabaseClient(), orgId, pocProjects.map(project => snapshots.get(project.projectId)!.snapshotId))) throw new Error("WIP source evidence changed; prepare and review the period again")
  const allocationsByProject = new Map(pocProjects.map(project => {
    const snapshot = snapshots.get(project.projectId)!
    if (!Number.isSafeInteger(snapshot.earnedRevenueCents - (recognizedByProject.get(project.projectId) ?? 0))) throw new Error("POC revenue delta exceeds safe integer cents")
    return [project.projectId, pocRevenueAllocationDeltas(snapshot.earnedRevenueCents, snapshot.revenueAllocations ?? [], recognizedLinesByProject.get(project.projectId) ?? [])] as const
  }))
  let postedCents = 0
  for (const project of pocProjects) {
    const snapshot = exactPeriodPosition(snapshots.get(project.projectId), periodEnd)
    if (!snapshot) {
      projectsWithoutSnapshot.push(project.projectId)
      results.push({ projectId: project.projectId, earnedRevenueCents: 0, recognizedBeforeCents: recognizedByProject.get(project.projectId) ?? 0, deltaCents: 0, posted: false, skippedReason: "no_snapshot" })
      continue
    }
    const position = { earnedRevenueCents: snapshot.earnedRevenueCents, warnings: snapshot.warnings }
    if (position.warnings.includes("missing_contract_value")) {
      results.push({ projectId: project.projectId, earnedRevenueCents: position.earnedRevenueCents, recognizedBeforeCents: recognizedByProject.get(project.projectId) ?? 0, deltaCents: 0, posted: false, skippedReason: "missing_contract_value" })
      continue
    }
    const recognizedBeforeCents = recognizedByProject.get(project.projectId) ?? 0
    const deltaCents = position.earnedRevenueCents - recognizedBeforeCents
    const revenueLines = allocationsByProject.get(project.projectId)!
    if (revenueLines.length === 0) {
      results.push({ projectId: project.projectId, earnedRevenueCents: position.earnedRevenueCents, recognizedBeforeCents, deltaCents: 0, posted: false, skippedReason: "no_delta" })
      continue
    }
    const revision = (await countPeriodRecognitions(orgId, project.projectId, periodKey)) + 1
    const draft = postRevenueRecognition({
      id: project.projectId,
      date: periodEnd,
      memo: `Percentage-of-completion revenue through ${periodEnd}`,
      projectionVersion,
      sourceVersion: revision,
      policyVersion,
      projectId: project.projectId,
      deltaCents,
      revenueLines,
      periodKey,
      dimensions: { wip_snapshot_id: snapshot.snapshotId, wip_inputs_hash: snapshot.inputsHash, wip_as_of: snapshot.asOf },
    })
    await postBooksJournalEntryForService(draft, orgId)
    postedCents += deltaCents
    results.push({ projectId: project.projectId, earnedRevenueCents: position.earnedRevenueCents, recognizedBeforeCents, deltaCents, posted: true })
  }

  const recognized = results.filter((row) => row.posted).length
  if (recognized > 0) {
    await recordEvent({
      orgId,
      eventType: "books.revenue_recognized",
      entityType: "books_settings",
      entityId: orgId,
      payload: { period_end: periodEnd, basis, projects: recognized, amount_cents: postedCents },
    })
  }
  return { periodEnd, basis, recognized, postedCents, projectsWithoutSnapshot, results }
}
