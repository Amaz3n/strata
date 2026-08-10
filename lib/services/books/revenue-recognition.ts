import "server-only"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { SYSTEM_ACCOUNT_CODES } from "@/lib/services/books/chart-of-accounts"
import { postBooksJournalEntryForService } from "@/lib/services/books/ledger"
import { postRevenueRecognition } from "@/lib/services/books/posting-rules"
import { loadProjectRevenueBases } from "@/lib/services/books/revenue-basis"
import { computeProjectPocForProject, loadPocPositionsAsOf } from "@/lib/services/poc"
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
 * IT IS AS-OF. A period end in the past is answered from `poc_snapshots`, never
 * from live data: closing June on August 9 and computing POC now would book a
 * June-dated entry containing July and August costs, and no later correction
 * would ever find it. A project with no snapshot at or before the period end is
 * named in `projectsWithoutSnapshot` and left unrecognized — substituting
 * today's position under a historical heading is the defect, not the cure. Only
 * a period end at or after today is computed live, because then "now" IS the
 * as-of. `basis` reports which of the two ran, exactly as the WIP report does.
 */

export type RevenueRecognitionSkipReason =
  | "no_poc_inputs"
  | "no_delta"
  | "missing_contract_value"
  | "no_snapshot"

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
  const byProject = new Map<string, number>()
  for (let from = 0; ; from += RECOGNIZED_REVENUE_PAGE_SIZE) {
    const { data, error } = await service
      .from("journal_lines")
      .select("id, project_id, debit_cents, credit_cents, entry:journal_entries!inner(status, entry_date), account:gl_accounts!inner(code)")
      .eq("org_id", orgId)
      .eq("account.code", SYSTEM_ACCOUNT_CODES.constructionRevenue)
      .eq("entry.status", "posted")
      .lte("entry.entry_date", asOf)
      .order("id", { ascending: true })
      .range(from, from + RECOGNIZED_REVENUE_PAGE_SIZE - 1)
    if (error) throw new Error(`Failed to load recognized revenue: ${error.message}`)
    const page = data ?? []
    for (const row of page) {
      if (!row.project_id) continue
      const projectId = String(row.project_id)
      const net = Number(row.credit_cents ?? 0) - Number(row.debit_cents ?? 0)
      byProject.set(projectId, (byProject.get(projectId) ?? 0) + net)
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

/** The earned position a project had at the period end, however it was resolved. */
type EarnedPosition = { earnedRevenueCents: number; warnings: string[] } | null

/**
 * Recognizes revenue for every percentage-of-completion project in the
 * organization as of `periodEnd` (an ISO date, normally a month end).
 *
 * Contract for `books/period-close.ts`: call this with the period's
 * `period_end`, AFTER the blocking checklist has passed — the `poc_snapshots`
 * gate is what guarantees every POC project has a snapshot at or before that
 * date. `projectsWithoutSnapshot` is non-empty only when that guarantee was not
 * met, and those projects recognized nothing; treat it as a close-blocking
 * condition rather than as information.
 */
export async function recognizeRevenueForPeriod(orgId: string, periodEnd: string) {
  const { enabled, policyVersion, projectionVersion } = await resolveVersions(orgId)
  const historical = periodEnd < todayIsoDateOnly()
  const basis: "snapshot" | "live" = historical ? "snapshot" : "live"
  if (!enabled) {
    return { periodEnd, basis, recognized: 0, postedCents: 0, projectsWithoutSnapshot: [] as string[], results: [] as RevenueRecognitionResult[] }
  }

  const periodKey = periodKeyFor(periodEnd)
  const [bases, recognizedByProject] = await Promise.all([
    loadProjectRevenueBases(orgId),
    loadRecognizedRevenueByProject(orgId, periodEnd),
  ])
  const pocProjects = bases.filter((row) => row.basis === "percentage_of_completion" && row.status !== "archived")
  const snapshots = historical
    ? await loadPocPositionsAsOf({ orgId, projectIds: pocProjects.map((row) => row.projectId), asOf: periodEnd })
    : new Map<string, { earnedRevenueCents: number; warnings: string[] }>()

  const results: RevenueRecognitionResult[] = []
  const projectsWithoutSnapshot: string[] = []
  let postedCents = 0
  for (const project of pocProjects) {
    let position: EarnedPosition
    if (historical) {
      const snapshot = snapshots.get(project.projectId)
      if (!snapshot) {
        projectsWithoutSnapshot.push(project.projectId)
        results.push({ projectId: project.projectId, earnedRevenueCents: 0, recognizedBeforeCents: recognizedByProject.get(project.projectId) ?? 0, deltaCents: 0, posted: false, skippedReason: "no_snapshot" })
        continue
      }
      position = { earnedRevenueCents: snapshot.earnedRevenueCents, warnings: snapshot.warnings }
    } else {
      const poc = await computeProjectPocForProject(project.projectId, orgId)
      position = poc ? { earnedRevenueCents: poc.earnedRevenueCents, warnings: [...poc.warnings] } : null
    }
    if (!position) {
      results.push({ projectId: project.projectId, earnedRevenueCents: 0, recognizedBeforeCents: 0, deltaCents: 0, posted: false, skippedReason: "no_poc_inputs" })
      continue
    }
    if (position.warnings.includes("missing_contract_value")) {
      results.push({ projectId: project.projectId, earnedRevenueCents: position.earnedRevenueCents, recognizedBeforeCents: recognizedByProject.get(project.projectId) ?? 0, deltaCents: 0, posted: false, skippedReason: "missing_contract_value" })
      continue
    }
    const recognizedBeforeCents = recognizedByProject.get(project.projectId) ?? 0
    const deltaCents = position.earnedRevenueCents - recognizedBeforeCents
    if (deltaCents === 0) {
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
      periodKey,
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
