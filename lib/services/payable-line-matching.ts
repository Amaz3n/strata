import "server-only"

import {
  applyCommitmentLineBudgets,
  buildLineMatchRollup,
  lineMatchFingerprint,
  matchInvoiceLinesDeterministic,
  readLineMatchAssessment,
  resolvedLine,
  unmatchedLine,
  type CommitmentLineForMatch,
  type InvoiceLineForMatch,
  type MatchedInvoiceLine,
  type PayableLineMatchAssessment,
} from "@/lib/financials/payable-line-match"
import { requireAuthorization } from "@/lib/services/authorization"
import { requireOrgContext } from "@/lib/services/context"
import { arbitrateInvoiceLineMatches } from "@/lib/services/document-extraction"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

/**
 * Matching an invoice's lines to the commitment (purchase order / subcontract)
 * lines they are supposed to be billing against.
 *
 * Arc already refused to release a payment that pushed a commitment past its
 * approved value plus change orders. That is a total-level check, and it passes
 * happily while the invoice bills for concrete against the framing line, or
 * bills a line that was already fully drawn and hides it under one that wasn't.
 * Line-level matching is the check that catches those, and Arc can do it at all
 * only because it holds the commitment the invoice is claiming against.
 *
 * Deterministic first: description tokens and amounts decide most lines with no
 * model involved. The arbiter is asked only about lines where two commitment
 * lines are genuinely close, and it may only choose from candidates the
 * deterministic pass already shortlisted — it can never invent a line id.
 *
 * The result is a CHECKABLE CLAIM. It never changes a bill's status, never
 * blocks a payment, and never rewrites the coding a human entered. It is
 * evidence rendered next to the lines so an approver can see, in one glance,
 * that this invoice bills what the commitment says it should.
 */

async function loadCommitmentContext(
  supabase: ReturnType<typeof createServiceSupabaseClient>,
  orgId: string,
  commitmentId: string,
  /** Null while the payable is still being created and has no row to exclude. */
  billId: string | null,
) {
  const [{ data: commitment }, { data: lines }, { data: changeOrders }, { data: siblingBills }] = await Promise.all([
    supabase.from("commitments").select("id,total_cents").eq("org_id", orgId).eq("id", commitmentId).maybeSingle(),
    supabase
      .from("commitment_lines")
      .select("id,description,quantity,unit,unit_cost_cents,scheduled_value_cents,sort_order")
      .eq("org_id", orgId)
      .eq("commitment_id", commitmentId)
      .order("sort_order", { ascending: true })
      .limit(500),
    supabase
      .from("change_orders")
      .select("total_cents,status")
      .eq("org_id", orgId)
      .eq("commitment_id", commitmentId)
      .in("status", ["approved", "executed"])
      .limit(500),
    // Other bills already drawn against this commitment, so "remaining" means
    // remaining, not remaining-if-this-is-the-only-invoice.
    (() => {
      const query = supabase
        .from("vendor_bills")
        .select("id,total_cents,status,metadata")
        .eq("org_id", orgId)
        .eq("commitment_id", commitmentId)
        .neq("status", "rejected")
        .limit(500)
      return billId ? query.neq("id", billId) : query
    })(),
  ])

  const commitmentLineRows = lines ?? []
  const previouslyMatched = new Map<string, number>()
  for (const sibling of siblingBills ?? []) {
    const assessment = readLineMatchAssessment((sibling.metadata ?? {}) as Record<string, unknown>)
    if (!assessment) continue
    for (const line of assessment.lines) {
      if (!line.commitmentLineId) continue
      previouslyMatched.set(line.commitmentLineId, (previouslyMatched.get(line.commitmentLineId) ?? 0) + line.invoiceLine.amountCents)
    }
  }

  const commitmentLines: CommitmentLineForMatch[] = commitmentLineRows.map((row, index) => {
    const scheduled = Number(row.scheduled_value_cents ?? 0)
    const quantity = row.quantity === null ? null : Number(row.quantity)
    const unitCostCents = row.unit_cost_cents === null ? null : Number(row.unit_cost_cents)
    const derived = Math.round((unitCostCents ?? 0) * (quantity ?? 1))
    return {
      id: row.id,
      lineNumber: index + 1,
      description: row.description?.trim() || `Line ${index + 1}`,
      quantity,
      unit: row.unit ?? null,
      unitCostCents,
      scheduledValueCents: Math.max(0, scheduled || derived),
      previouslyMatchedCents: previouslyMatched.get(row.id) ?? 0,
    }
  })

  return {
    commitmentTotalCents: Number(commitment?.total_cents ?? 0),
    approvedChangeOrdersCents: (changeOrders ?? []).reduce((sum, row) => sum + Number(row.total_cents ?? 0), 0),
    billedToDateCents: (siblingBills ?? []).reduce((sum, row) => sum + Number(row.total_cents ?? 0), 0),
    commitmentLines,
  }
}

/**
 * The matching itself: deterministic pass, arbiter for the genuinely ambiguous,
 * then per-line budget stamping. Shared by the persisting path and the
 * creation-time preview so a bill cannot be assessed one way before it is saved
 * and a different way after.
 */
async function resolveLineMatches(input: {
  orgId: string
  invoiceLines: InvoiceLineForMatch[]
  commitmentLines: CommitmentLineForMatch[]
}): Promise<{ lines: MatchedInvoiceLine[]; model: string | null; notes: string[] }> {
  const decisions = matchInvoiceLinesDeterministic(input.invoiceLines, input.commitmentLines)
  const notes: string[] = []
  let model: string | null = null

  const ambiguous = decisions
    .map((decision, index) => ({ decision, index }))
    .filter((entry) => entry.decision.resolution === null && entry.decision.candidates !== null)

  const arbitrated = new Map<number, { commitmentLineId: string | null; reason: string; confidence: "high" | "medium" | "low" }>()
  if (ambiguous.length > 0) {
    const arbitration = await arbitrateInvoiceLineMatches({
      orgId: input.orgId,
      ambiguousLines: ambiguous.map((entry) => ({
        index: entry.index,
        description: entry.decision.invoiceLine.description,
        quantity: entry.decision.invoiceLine.quantity,
        unit: entry.decision.invoiceLine.unit,
        amountCents: entry.decision.invoiceLine.amountCents,
        candidates: (entry.decision.candidates ?? []).map((candidate) => ({
          id: candidate.id,
          label: `Line ${candidate.lineNumber}: ${candidate.description}`,
          remainingCents: Math.max(0, candidate.scheduledValueCents - candidate.previouslyMatchedCents),
        })),
      })),
    }).catch(() => null)

    if (arbitration) {
      model = arbitration.model
      for (const decision of arbitration.decisions) {
        arbitrated.set(decision.index, {
          commitmentLineId: decision.commitmentLineId,
          reason: decision.reason,
          confidence: decision.confidence,
        })
      }
    } else {
      notes.push("Some lines were too close to call and no arbiter was available; they are listed as unmatched.")
    }
  }

  const lines: MatchedInvoiceLine[] = decisions.map((decision, index) => {
    if (decision.resolution) return decision.resolution
    const verdict = arbitrated.get(index)
    const candidates = decision.candidates ?? []
    if (!verdict || verdict.commitmentLineId === null) {
      return unmatchedLine(decision.invoiceLine, verdict?.reason ?? "No commitment line clearly covers this work.", verdict ? "ai" : "deterministic")
    }
    // The arbiter may only pick from what it was shown; anything else is discarded.
    const chosen = candidates.find((candidate) => candidate.id === verdict.commitmentLineId)
    if (!chosen) {
      return unmatchedLine(decision.invoiceLine, "No commitment line clearly covers this work.", "ai")
    }
    return resolvedLine(decision.invoiceLine, chosen, verdict.confidence === "high" ? "exact" : "probable", "ai", verdict.reason)
  })

  return { lines: applyCommitmentLineBudgets(lines, input.commitmentLines), model, notes }
}

/**
 * Match scanned invoice lines against a commitment before the payable exists.
 *
 * Read-only: nothing is persisted, because there is nothing yet to persist onto.
 * This is the check at the moment it is cheapest to act on — the invoice is on
 * screen and no coding has been entered yet.
 */
export async function previewCommitmentLineMatch(input: {
  commitmentId: string
  invoiceLines: InvoiceLineForMatch[]
  billTotalCents: number
  orgId?: string
}): Promise<PayableLineMatchAssessment | null> {
  const context = await requireOrgContext(input.orgId)
  const supabase = createServiceSupabaseClient()
  if (input.invoiceLines.length === 0) return null

  const { data: commitment } = await supabase
    .from("commitments")
    .select("id,project_id")
    .eq("org_id", context.orgId)
    .eq("id", input.commitmentId)
    .maybeSingle()
  if (!commitment) return null

  await requireAuthorization({
    permission: "bill.write",
    userId: context.userId,
    orgId: context.orgId,
    projectId: commitment.project_id,
    supabase,
    resourceType: "commitment",
    resourceId: input.commitmentId,
  })

  const commitmentContext = await loadCommitmentContext(supabase, context.orgId, input.commitmentId, null)
  const { lines, model, notes } = await resolveLineMatches({
    orgId: context.orgId,
    invoiceLines: input.invoiceLines,
    commitmentLines: commitmentContext.commitmentLines,
  })

  return {
    version: 1,
    fingerprint: lineMatchFingerprint({
      commitmentId: input.commitmentId,
      billTotalCents: input.billTotalCents,
      billedToDateCents: commitmentContext.billedToDateCents,
      commitmentTotalCents: commitmentContext.commitmentTotalCents,
      approvedChangeOrdersCents: commitmentContext.approvedChangeOrdersCents,
      invoiceLines: input.invoiceLines,
      commitmentLines: commitmentContext.commitmentLines,
    }),
    commitmentId: input.commitmentId,
    matchedAt: new Date().toISOString(),
    model,
    lines,
    rollup: buildLineMatchRollup({
      lines,
      billTotalCents: input.billTotalCents,
      billedToDateCents: commitmentContext.billedToDateCents,
      commitmentTotalCents: commitmentContext.commitmentTotalCents,
      approvedChangeOrdersCents: commitmentContext.approvedChangeOrdersCents,
    }),
    notes,
  }
}
