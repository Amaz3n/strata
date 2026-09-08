import "server-only"

import { createServiceSupabaseClient } from "@/lib/supabase/server"

/**
 * Money that stopped moving.
 *
 * ACH settles in days, not weeks, so anything past four days without reaching a
 * terminal state has stopped for a reason nobody has looked at. Production had a
 * run `processing` and its disbursement frozen at `transfer_pending` for four
 * weeks: the debit had cleared, a transfer to the vendor existed, and no sweep,
 * alert or exception ever mentioned it.
 *
 * The scan lived inside the daily reconciliation, which is gated on
 * `FINTECH_PAYMENTS_RECONCILIATION_ENABLED` and only visits organizations whose
 * rail is currently enabled. Both gates were off in the deployment holding that
 * stuck run, so the check written in response to it could never see it. A
 * payment is stuck whether or not the rail is switched on today, so the scan
 * lives here, owned by neither caller:
 *
 * - reconciliation uses it to raise exception ROWS a human works in the queue;
 * - the hourly watchdog uses it to raise the INCIDENT, across every
 *   organization, whether or not reconciliation ever runs.
 *
 * Both report the same subject (`stale_payment_state`) through the additive
 * single-org incident helpers, so they reinforce rather than resolve each other.
 */

/** ACH settles in days; four of them without a terminal state is stuck. */
export const STALE_PAYMENT_STATE_HOURS = 96

/** Non-terminal disbursement states. Anything here is still owed to someone. */
export const NON_TERMINAL_DISBURSEMENT_STATUSES = [
  "created",
  "submitted",
  "debit_pending",
  "funds_available",
  "transfer_pending",
  "payout_pending",
]

/** Non-terminal run states. `draft`/`pending_approval` wait on people, not on money. */
export const NON_TERMINAL_RUN_STATUSES = ["processing", "partially_failed"]

/** One incident per org for "money that stopped moving", regardless of how many rows. */
export const STALE_PAYMENT_STATE_INCIDENT_CODE = "stale_payment_state"

const STALE_SCAN_PAGE_SIZE = 500

export interface StaleDisbursement {
  id: string
  org_id: string
  run_id: string
  status: string
  amount_cents: number
  provider_payment_id: string | null
  created_at: string
}

export interface StalePaymentRun {
  id: string
  org_id: string
  status: string
  total_debit_cents: number
  processing_started_at: string | null
  created_at: string
}

export interface StalePaymentState {
  disbursements: StaleDisbursement[]
  runs: StalePaymentRun[]
}

export function stalePaymentStateCutoff(now = new Date()): string {
  return new Date(now.getTime() - STALE_PAYMENT_STATE_HOURS * 60 * 60 * 1000).toISOString()
}

export function hasStalePaymentState(state: StalePaymentState): boolean {
  return state.disbursements.length > 0 || state.runs.length > 0
}

/** A run ages from the moment execution starts, not from when its draft was created. */
export function isPaymentRunStale(
  run: Pick<StalePaymentRun, "processing_started_at" | "created_at">,
  cutoffIso: string,
): boolean {
  return Date.parse(run.processing_started_at ?? run.created_at) <= Date.parse(cutoffIso)
}

/**
 * Every non-terminal disbursement and run older than the threshold.
 *
 * Paged exhaustively rather than capped, for the same reason the incident
 * synchronizer pages: a truncated list reads as recovery for whatever fell off
 * the end. `orgId` is optional so the watchdog can sweep the whole deployment
 * while reconciliation stays scoped to the org it is reconciling.
 */
export async function loadStalePaymentState(input: { orgId?: string; now?: Date } = {}): Promise<StalePaymentState> {
  const supabase = createServiceSupabaseClient()
  const cutoff = stalePaymentStateCutoff(input.now)
  const disbursements: StaleDisbursement[] = []
  const runs: StalePaymentRun[] = []

  for (let from = 0; ; from += STALE_SCAN_PAGE_SIZE) {
    let query = supabase.from("disbursements")
      .select("id,org_id,run_id,status,amount_cents,provider_payment_id,created_at")
      .in("status", NON_TERMINAL_DISBURSEMENT_STATUSES)
      .lte("created_at", cutoff)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + STALE_SCAN_PAGE_SIZE - 1)
    if (input.orgId) query = query.eq("org_id", input.orgId)
    const { data, error } = await query
    if (error) throw new Error(`Unable to load stale disbursements: ${error.message}`)
    disbursements.push(...((data ?? []) as StaleDisbursement[]))
    if ((data ?? []).length < STALE_SCAN_PAGE_SIZE) break
  }

  for (let from = 0; ; from += STALE_SCAN_PAGE_SIZE) {
    let query = supabase.from("payment_runs")
      .select("id,org_id,status,total_debit_cents,processing_started_at,created_at")
      .in("status", NON_TERMINAL_RUN_STATUSES)
      .lte("created_at", cutoff)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + STALE_SCAN_PAGE_SIZE - 1)
    if (input.orgId) query = query.eq("org_id", input.orgId)
    const { data, error } = await query
    if (error) throw new Error(`Unable to load stale payment runs: ${error.message}`)
    // A draft may exist for weeks before approval. Counting from `created_at`
    // would call it stale immediately after it enters processing, so execution
    // states age from `processing_started_at` when that stamp is present. The
    // `created_at <= cutoff` predicate is still a safe candidate bound because
    // processing cannot start before the run exists.
    runs.push(...((data ?? []) as StalePaymentRun[]).filter((run) => isPaymentRunStale(run, cutoff)))
    if ((data ?? []).length < STALE_SCAN_PAGE_SIZE) break
  }

  return { disbursements, runs }
}

/**
 * The organizations owning stale money, and how much of it each has.
 *
 * The watchdog needs the population rather than the rows, because an incident is
 * per organization and a hundred stuck rows in one org is still one incident.
 */
export function groupStaleStateByOrg(
  state: Pick<StalePaymentState, "disbursements" | "runs">,
): Map<string, { disbursements: number; runs: number }> {
  const byOrg = new Map<string, { disbursements: number; runs: number }>()
  for (const row of state.disbursements) {
    const orgId = row.org_id
    const entry = byOrg.get(orgId) ?? { disbursements: 0, runs: 0 }
    entry.disbursements += 1
    byOrg.set(orgId, entry)
  }
  for (const row of state.runs) {
    const orgId = row.org_id
    const entry = byOrg.get(orgId) ?? { disbursements: 0, runs: 0 }
    entry.runs += 1
    byOrg.set(orgId, entry)
  }
  return byOrg
}
