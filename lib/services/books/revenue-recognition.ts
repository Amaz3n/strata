import { hasInvalidWipInputs } from "@/lib/financials/wip-validation"
import { wipSourcesCurrent } from "@/lib/services/books/wip-source-evidence"
import { assertReviewedWipUnchanged, wipScopeKey, wipSnapshotEvidence, type WipScope, type WipSnapshotEvidence, exactPeriodPosition, requireRecognitionDate } from "@/lib/services/books/wip-period-rules"
import "server-only"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { SYSTEM_ACCOUNT_CODES } from "@/lib/services/books/chart-of-accounts"
import { pocRevenueAllocationDeltas } from "@/lib/services/books/poc-revenue-allocations"
import type { InvoiceRevenueLine } from "@/lib/services/books/invoice-revenue-rules"
import { postBooksJournalEntryForService } from "@/lib/services/books/ledger"
import { postRevenueRecognition } from "@/lib/services/books/posting-rules"
import { loadWipScopesForPeriod } from "@/lib/services/books/wip-project-scope"
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
  contractId: string | null
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

/** How many recognition entries this project (or contract) already has for this period. */
async function countPeriodRecognitions(orgId: string, scope: WipScope, periodKey: string) {
  const service = createServiceSupabaseClient()
  const { count, error } = await service
    .from("journal_entries")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("source_type", "revenue_recognition")
    .like("posting_key", `revenue_recognition:${scope.projectId}:${scope.contractId ? `${scope.contractId}:` : ""}${periodKey}:%`)
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
 * Revenue already recognized for one WIP scope: every POC line of the project,
 * or, for a contract, the lines carrying that contract. A project that earned
 * revenue before it had a second contract has lines no contract owns; adding them
 * to neither would earn them twice, so recognition refuses with the cure.
 */
function recognizedLinesForScope(lines: InvoiceRevenueLine[], scope: WipScope, projectName: string) {
  if (!scope.contractId) return lines
  if (lines.some(line => !line.dimensions?.contract_id)) {
    throw new Error(`Revenue on ${projectName} was recognized before it had more than one contract, so it belongs to no contract. Reclassify that revenue to its contracts before recognizing each contract's revenue.`)
  }
  return lines.filter(line => line.dimensions?.contract_id === scope.contractId)
}

/**
 * Recognizes revenue for every percentage-of-completion position — each project,
 * or each contract of a project with several — as of `periodEnd` (an ISO date,
 * normally a month end).
 *
 * Contract for `books/period-close.ts`: call this with the period's
 * `period_end`, AFTER the blocking checklist has passed — the `poc_snapshots`
 * gate is what guarantees every scope has a snapshot on that date.
 * `projectsWithoutSnapshot` is non-empty only when that guarantee was not met,
 * and those scopes recognized nothing; treat it as a close-blocking condition
 * rather than as information.
 */
export async function recognizeRevenueForPeriod(orgId: string, periodEnd: string, expectedScopes?: WipScope[], reviewedSnapshots?: WipSnapshotEvidence[]) {
  const { enabled, policyVersion, projectionVersion } = await resolveVersions(orgId)
  requireRecognitionDate(periodEnd, todayIsoDateOnly())
  const basis = "snapshot" as const
  if (!enabled) {
    return { periodEnd, basis, recognized: 0, postedCents: 0, projectsWithoutSnapshot: [] as string[], results: [] as RevenueRecognitionResult[] }
  }

  const periodKey = periodKeyFor(periodEnd)
  const [scopes, recognizedLinesByProject] = await Promise.all([
    loadWipScopesForPeriod(orgId, periodEnd),
    loadRecognizedRevenueByProject(orgId, periodEnd),
  ])
  if (expectedScopes) {
    const expected = [...new Set(expectedScopes.map(wipScopeKey))].sort()
    const actual = scopes.map(wipScopeKey).sort()
    if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error("WIP project population changed after close review; rerun the checklist")
  }
  const projectIds = [...new Set(scopes.map(scope => scope.projectId))]
  const [snapshots, projectNames] = await Promise.all([
    loadPocPositionsAsOf({ orgId, projectIds, asOf: periodEnd }),
    loadProjectNames(orgId, scopes.filter(scope => scope.contractId).map(scope => scope.projectId)),
  ])
  const recognizedLines = new Map(scopes.map(scope => [wipScopeKey(scope), recognizedLinesForScope(recognizedLinesByProject.get(scope.projectId) ?? [], scope, projectNames.get(scope.projectId) ?? "a project")] as const))
  const recognizedBefore = (scope: WipScope) => {
    const total = Number((recognizedLines.get(wipScopeKey(scope)) ?? []).reduce((sum, row) => sum + BigInt(row.amount_cents), BigInt(0)))
    if (!Number.isSafeInteger(total)) throw new Error("Recognized POC revenue exceeds safe integer cents")
    return total
  }

  if (reviewedSnapshots) assertReviewedWipUnchanged(reviewedSnapshots, wipSnapshotEvidence(snapshots, scopes))

  const results: RevenueRecognitionResult[] = []
  const projectsWithoutSnapshot: string[] = []
  const positionOf = (scope: WipScope) => exactPeriodPosition(snapshots.get(wipScopeKey(scope)), periodEnd)
  // Validate every scope's evidence before posting any delta. A missing position
  // must not leave a partly recognized failed close attempt.
  const invalid = scopes.filter(scope => {
    const position = positionOf(scope)
    return !position || hasInvalidWipInputs(position.warnings)
  })
  if (invalid.length) {
    for (const scope of scopes) {
      const position = positionOf(scope)
      if (!position) projectsWithoutSnapshot.push(scope.projectId)
      results.push({
        projectId: scope.projectId,
        contractId: scope.contractId,
        earnedRevenueCents: position?.earnedRevenueCents ?? 0,
        recognizedBeforeCents: recognizedBefore(scope),
        deltaCents: 0,
        posted: false,
        skippedReason: !position ? "no_snapshot" : position.warnings.includes("missing_contract_value") ? "missing_contract_value" : hasInvalidWipInputs(position.warnings) ? "invalid_wip_inputs" : "period_evidence_incomplete",
      })
    }
    return { periodEnd, basis, recognized: 0, postedCents: 0, projectsWithoutSnapshot, results }
  }
  const positions = new Map(scopes.map(scope => [wipScopeKey(scope), positionOf(scope)!] as const))
  if (!await wipSourcesCurrent(createServiceSupabaseClient(), orgId, [...positions.values()].map(position => position.snapshotId))) throw new Error("WIP source evidence changed; prepare and review the period again")
  const allocationsByScope = new Map(scopes.map(scope => {
    const snapshot = positions.get(wipScopeKey(scope))!
    if (!Number.isSafeInteger(snapshot.earnedRevenueCents - recognizedBefore(scope))) throw new Error("POC revenue delta exceeds safe integer cents")
    return [wipScopeKey(scope), pocRevenueAllocationDeltas(snapshot.earnedRevenueCents, snapshot.revenueAllocations ?? [], recognizedLines.get(wipScopeKey(scope)) ?? [], scope.contractId)] as const
  }))
  let postedCents = 0
  for (const scope of scopes) {
    const snapshot = positions.get(wipScopeKey(scope))!
    const recognizedBeforeCents = recognizedBefore(scope)
    if (snapshot.warnings.includes("missing_contract_value")) {
      results.push({ projectId: scope.projectId, contractId: scope.contractId, earnedRevenueCents: snapshot.earnedRevenueCents, recognizedBeforeCents, deltaCents: 0, posted: false, skippedReason: "missing_contract_value" })
      continue
    }
    const deltaCents = snapshot.earnedRevenueCents - recognizedBeforeCents
    const revenueLines = allocationsByScope.get(wipScopeKey(scope))!
    if (revenueLines.length === 0) {
      results.push({ projectId: scope.projectId, contractId: scope.contractId, earnedRevenueCents: snapshot.earnedRevenueCents, recognizedBeforeCents, deltaCents: 0, posted: false, skippedReason: "no_delta" })
      continue
    }
    const revision = (await countPeriodRecognitions(orgId, scope, periodKey)) + 1
    const draft = postRevenueRecognition({
      id: scope.projectId,
      date: periodEnd,
      memo: `Percentage-of-completion revenue through ${periodEnd}`,
      projectionVersion,
      sourceVersion: revision,
      policyVersion,
      projectId: scope.projectId,
      contractId: scope.contractId,
      deltaCents,
      revenueLines,
      periodKey,
      dimensions: { wip_snapshot_id: snapshot.snapshotId, wip_inputs_hash: snapshot.inputsHash, wip_as_of: snapshot.asOf },
    })
    await postBooksJournalEntryForService(draft, orgId)
    postedCents += deltaCents
    results.push({ projectId: scope.projectId, contractId: scope.contractId, earnedRevenueCents: snapshot.earnedRevenueCents, recognizedBeforeCents, deltaCents, posted: true })
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

async function loadProjectNames(orgId: string, projectIds: string[]) {
  if (projectIds.length === 0) return new Map<string, string>()
  const { data, error } = await createServiceSupabaseClient().from("projects").select("id, name").eq("org_id", orgId).in("id", [...new Set(projectIds)])
  if (error) throw new Error(`Failed to load project names: ${error.message}`)
  return new Map((data ?? []).map(row => [String(row.id), String(row.name)]))
}
