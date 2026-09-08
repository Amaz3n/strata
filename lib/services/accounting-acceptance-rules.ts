/** Pure release rules. A successful cron response is never acceptance evidence. */
export const ACCOUNTING_ACCEPTANCE_CHECKER = "accounting-d2-v1"
export const ACCOUNTING_PARITY_VERSION = "legacy-present-neutral-equivalence-v1"
export type AcceptanceSample = {
  checked_at: string
  candidate_sha: string
  schema_fingerprint: string
  checker_version: string
  passed: boolean
  evidence: { complete: boolean; scope: string; blockers: string[] }
}
export type AcceptanceCandidate = { candidate_sha: string; schema_fingerprint: string; checker_version: string; started_at: string }
export function evaluateAcceptanceStreak(samples: AcceptanceSample[], candidate: AcceptanceCandidate, now = new Date()) {
  const dayMs = 86_400_000
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const blockers: string[] = []
  const days = new Map<number, boolean>()
  for (const sample of samples) {
    const time = Date.parse(sample.checked_at)
    if (!Number.isFinite(time) || time > now.getTime() || time < Date.parse(candidate.started_at)) continue
    const day = Math.floor(time / dayMs) * dayMs
    const valid = sample.passed === true && sample.evidence?.complete === true && sample.evidence.scope === "global" && Array.isArray(sample.evidence.blockers) && sample.evidence.blockers.length === 0 && sample.candidate_sha === candidate.candidate_sha && sample.schema_fingerprint === candidate.schema_fingerprint && sample.checker_version === candidate.checker_version
    days.set(day, (days.get(day) ?? true) && valid)
  }
  if (days.get(today) === false) blockers.push("current_day_failed")
  let consecutiveCompleteDays = 0
  for (let day = today - dayMs; days.get(day) === true; day -= dayMs) consecutiveCompleteDays++
  if (consecutiveCompleteDays < 14) blockers.push(`acceptance_days:${consecutiveCompleteDays}/14`)
  // Count completed UTC dates only. Multiple retries cannot manufacture days or erase failures.
  return { recommendation: blockers.length ? "HOLD" as const : "APPLY D2" as const, consecutiveCompleteDays, blockers }
}
