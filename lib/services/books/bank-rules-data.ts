import "server-only"

import { z } from "zod"

import type { BankRuleCandidate } from "@/lib/services/books/bank-rule-matching"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

/**
 * The leaf that reads bank rules.
 *
 * Split out to break a real import cycle: `bank-rules.ts` needs `confirmBankMatch`
 * from `bank-reconciliation.ts` to close the loop after posting, and the review
 * tray in `bank-reconciliation.ts` needs the rules to suggest a category. Both now
 * depend on this instead of on each other. Books has paid for a cycle like this
 * once already (C3.1, where a top-level adapter binding resolved to `undefined`
 * depending on which module loaded first).
 */

export const ruleRowSchema = z.object({
  id: z.string().uuid(),
  match_kind: z.enum(["merchant_exact", "description_contains"]),
  match_value: z.string(),
  direction: z.enum(["inflow", "outflow"]).nullable(),
  bank_account_id: z.string().uuid().nullable(),
  gl_account_id: z.string().uuid(),
  project_id: z.string().uuid().nullable(),
  cost_code_id: z.string().uuid().nullable(),
  confidence: z.coerce.number(),
  hit_count: z.number().int(),
  correction_count: z.number().int(),
  active: z.boolean(),
})

function toCandidate(row: z.infer<typeof ruleRowSchema>): BankRuleCandidate {
  return {
    id: row.id,
    matchKind: row.match_kind,
    matchValue: row.match_value,
    direction: row.direction,
    bankAccountId: row.bank_account_id,
    glAccountId: row.gl_account_id,
    projectId: row.project_id,
    costCodeId: row.cost_code_id,
    confidence: row.confidence,
    hitCount: row.hit_count,
    active: row.active,
  }
}

export async function loadBankRuleCandidates(orgId: string): Promise<BankRuleCandidate[]> {
  const service = createServiceSupabaseClient()
  const { data, error } = await service
    .from("bank_rules")
    .select("id, match_kind, match_value, direction, bank_account_id, gl_account_id, project_id, cost_code_id, confidence, hit_count, correction_count, active")
    .eq("org_id", orgId)
    .eq("active", true)
    .limit(500)
  if (error) throw new Error(`Failed to load bank rules: ${error.message}`)
  return z.array(ruleRowSchema).parse(data ?? []).map(toCandidate)
}
