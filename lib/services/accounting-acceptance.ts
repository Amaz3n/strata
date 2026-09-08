import "server-only"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { ACCOUNTING_ACCEPTANCE_CHECKER } from "@/lib/services/accounting-acceptance-rules"

/** Existing nightly job owns scheduling; absent campaigns never create synthetic history. */
export async function captureAccountingAcceptance(reconciliation: { attempted: number; completed: number; failures: unknown[] }) {
  const service = createServiceSupabaseClient()
  const { data, error } = await service.rpc("capture_accounting_d2_acceptance", {
    p_deployed_sha: process.env.VERCEL_GIT_COMMIT_SHA ?? "unidentified-local-runtime",
    p_checker_version: ACCOUNTING_ACCEPTANCE_CHECKER,
    p_reconciliation_complete: reconciliation.attempted === reconciliation.completed && reconciliation.failures.length === 0,
  })
  if (error) throw new Error(`Accounting acceptance evidence could not be persisted: ${error.message}`)
  const samples = Array.isArray(data) ? data : []
  return { activeCampaigns: samples.length, failedSamples: samples.filter(row => row.passed !== true).length }
}
