import "server-only"
import { z } from "zod"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireOrgContext } from "@/lib/services/context"
import { requireBooksAuthorization } from "./access"
import { previewReviewedPayrollPostingPlan } from "./payroll-payment-reviews"
import { parsePayrollPostingProposal } from "./payroll-posting-proposal-evidence"
import { payrollPostingReceiptSchema } from "./payroll-posting-receipt"

const uuid = z.string().uuid().toLowerCase(), notesSchema = z.string().trim().min(10).max(4000)
async function access() {
  const context = await requireOrgContext()
  await requireBooksAuthorization({ permission: "books.adjust", userId: context.userId, orgId: context.orgId, supabase: context.supabase, resourceType: "payroll_import", resourceId: context.orgId, logDecision: true })
  return context
}
async function sources(orgId: string, row: Record<string, unknown>) {
  const service = createServiceSupabaseClient()
  const parent = await service.from("books_payroll_imports").select("*").eq("org_id", orgId).eq("id", row.payroll_import_id).single()
  if (parent.error || !parent.data || parent.data.org_id !== orgId) throw new Error("Payroll proposal parent is unavailable in organization")
  let payment: Record<string, unknown> | null = null
  if (row.payment_review_id !== null) {
    const result = await service.from("books_payroll_payment_reviews").select("*").eq("org_id", orgId).eq("id", row.payment_review_id).eq("payroll_import_id", row.payroll_import_id).single()
    if (result.error || !result.data || result.data.org_id !== orgId) throw new Error("Payroll proposal payment ownership is unavailable in organization")
    payment = result.data
  }
  return { parent: parent.data, payment, parsed: parsePayrollPostingProposal(row, parent.data, payment) }
}
export async function preparePayrollPostingProposal(input: { id: string; payrollImportId: string; notes: string; idempotencyKey: string }) {
  const context = await access(), id = uuid.parse(input.id), parentId = uuid.parse(input.payrollImportId), notes = notesSchema.parse(input.notes), key = z.string().trim().min(10).max(200).parse(input.idempotencyKey)
  const service = createServiceSupabaseClient()
  const existing = async () => {
    const { data, error } = await service.from("books_payroll_posting_proposals").select("*").eq("org_id", context.orgId).eq("idempotency_key", key).maybeSingle()
    if (error) throw new Error(`Failed to recover payroll posting proposal: ${error.message}`)
    return data
  }
  const recover = async (row: Record<string, unknown>) => {
    if (row.org_id !== context.orgId || row.id !== id || row.payroll_import_id !== parentId || row.prepared_by !== context.userId || row.preparation_notes !== notes || row.idempotency_key !== key) throw new Error("Payroll posting retry key belongs to different intent or preparer")
    const saved = await sources(context.orgId, row)
    return saved.parsed.row.id
  }
  const previous = await existing()
  if (previous) return recover(previous)
  try {
    const plan = await previewReviewedPayrollPostingPlan({ id: parentId })
    if (plan.orgId !== context.orgId || plan.runId !== parentId) throw new Error("Payroll posting proposal scope changed")
    const { data, error } = await service.rpc("prepare_books_payroll_posting_proposal", { p_org_id: context.orgId, p_id: id, p_parent_id: parentId, p_actor_id: context.userId, p_plan: plan, p_digest: plan.digest, p_notes: notes, p_key: key })
    if (error) throw new Error(`Failed to prepare payroll posting proposal: ${error.message}`)
    const result = uuid.parse(data)
    if (result !== id) throw new Error("Payroll posting preparation returned different identity")
    return result
  } catch (error) {
    let row
    try { row = await existing() } catch { throw error }
    if (row) return recover(row)
    throw error
  }
}
export async function reviewPayrollPostingProposal(input: { id: string; notes: string }) {
  const context = await access(), id = uuid.parse(input.id), notes = notesSchema.parse(input.notes), service = createServiceSupabaseClient()
  const { data, error } = await service.from("books_payroll_posting_proposals").select("*").eq("org_id", context.orgId).eq("id", id).single()
  if (error || !data || data.org_id !== context.orgId) throw new Error("Payroll posting proposal is unavailable in organization")
  const saved = await sources(context.orgId, data)
  if (context.userId === data.prepared_by || context.userId === saved.parent.prepared_by || context.userId === saved.payment?.prepared_by) throw new Error("Payroll posting proposal requires a separate reviewer")
  const current = await previewReviewedPayrollPostingPlan({ id: saved.parsed.row.payroll_import_id })
  if (current.digest !== saved.parsed.row.plan_digest) throw new Error("Payroll posting sources or proposal changed; withdraw and reprepare")
  const result = await service.rpc("review_books_payroll_posting_proposal", { p_org_id: context.orgId, p_id: id, p_actor_id: context.userId, p_plan: current, p_digest: current.digest, p_notes: notes })
  if (result.error) throw new Error(`Failed to review payroll posting proposal: ${result.error.message}`)
  const reviewedId = uuid.parse(result.data)
  if (reviewedId !== id) throw new Error("Payroll posting review returned different identity")
  return reviewedId
}
export async function withdrawPayrollPostingProposal(input: { id: string; reason: string }) {
  const context = await access(), id = uuid.parse(input.id)
  const { data, error } = await createServiceSupabaseClient().rpc("withdraw_books_payroll_posting_proposal", { p_org_id: context.orgId, p_id: id, p_actor_id: context.userId, p_reason: notesSchema.parse(input.reason) })
  if (error) throw new Error(`Failed to withdraw payroll posting proposal: ${error.message}`)
  const withdrawnId = uuid.parse(data)
  if (withdrawnId !== id) throw new Error("Payroll posting withdrawal returned different identity")
  return withdrawnId
}

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const controlsSchema = z.object({
  version: z.literal(1), orgId: uuid, proposalId: uuid, payrollImportId: uuid,
  planDigest: z.string().regex(/^[a-f0-9]{64}$/),
  accountingDates: z.array(z.object({ accountingDate: date, periodId: uuid.nullable(), status: z.string().nullable() }).strict()),
  calendarBlockers: z.array(z.object({ accountingDate: date, code: z.string().min(1) }).strict()),
  constructionBlockers: z.array(z.object({ allocationId: uuid, code: z.string().min(1) }).strict()),
  controlsSatisfied: z.boolean(), postingImplemented: z.boolean(), locksHeldUntilTransactionEnd: z.literal(true),
}).strict()

/** Readiness only: the standalone RPC's locks expire before this returns.
 * Posting must repeat these checks inside the transaction that writes money.
 */
export async function getPayrollPostingControls(input: { id: string }) {
  const context = await access(), id = uuid.parse(input.id), service = createServiceSupabaseClient()
  const { data, error } = await service.from("books_payroll_posting_proposals").select("*").eq("org_id", context.orgId).eq("id", id).single()
  if (error || !data || data.org_id !== context.orgId || data.id !== id) throw new Error("Payroll posting proposal is unavailable in organization")
  const saved = await sources(context.orgId, data)
  if (saved.parsed.row.status !== "reviewed") throw new Error("Payroll posting controls require independently reviewed full proposal")
  const current = await previewReviewedPayrollPostingPlan({ id: saved.parsed.row.payroll_import_id })
  if (current.digest !== saved.parsed.row.plan_digest) throw new Error("Payroll posting sources or proposal changed; withdraw and reprepare")
  const result = await service.rpc("lock_books_payroll_posting_context", { p_org_id: context.orgId, p_proposal_id: id })
  if (result.error) throw new Error(`Failed to check payroll posting controls: ${result.error.message}`)
  const controls = controlsSchema.parse(result.data)
  const expectedDates = [...new Set([...current.journalDrafts.map(draft => draft.entryDate), ...current.allocations.filter(allocation => allocation.construction.jobCostCorrections.length).map(allocation => allocation.construction.incurredOn)])].sort()
  if (controls.orgId !== context.orgId || controls.proposalId !== id || controls.payrollImportId !== current.runId || controls.planDigest !== current.digest
    || JSON.stringify(controls.accountingDates.map(row => row.accountingDate)) !== JSON.stringify(expectedDates)
    || controls.controlsSatisfied !== (controls.calendarBlockers.length === 0 && controls.constructionBlockers.length === 0)) throw new Error("Payroll posting controls returned inconsistent proposal evidence")
  const { locksHeldUntilTransactionEnd: _locks, ...readiness } = controls
  void _locks
  return { ...readiness, preflightOnly: true as const, requiresCommitRevalidation: true as const }
}

export async function postPayrollPostingProposal(input: { id: string; proposalId: string; planDigest: string; notes: string; idempotencyKey: string }) {
  const context = await access(), id = uuid.parse(input.id), proposalId = uuid.parse(input.proposalId), digest = z.string().regex(/^[a-f0-9]{64}$/).parse(input.planDigest), notes = notesSchema.parse(input.notes), key = z.string().trim().min(10).max(200).parse(input.idempotencyKey)
  const service = createServiceSupabaseClient()
  const existing = async () => {
    const { data, error } = await service.from("books_payroll_postings").select("*").eq("org_id", context.orgId).eq("idempotency_key", key).maybeSingle()
    if (error) throw new Error(`Failed to recover payroll posting receipt: ${error.message}`)
    return data
  }
  const recover = async (input: unknown) => {
    const receipt = payrollPostingReceiptSchema.parse(input)
    if (receipt.org_id !== context.orgId || receipt.id !== id || receipt.proposal_id !== proposalId || receipt.plan_digest !== digest || receipt.posted_by !== context.userId || receipt.posting_notes !== notes || receipt.idempotency_key !== key) throw new Error("Payroll posting retry identity belongs to different intent")
    const proof = await service.rpc("assert_books_payroll_posting_receipt", { p_receipt: receipt })
    if (proof.error || proof.data !== true) throw new Error("Payroll posting recovery lacks confirmed approved ledger and construction proof")
    if (receipt.result.postingId !== id || receipt.result.proposalId !== proposalId || receipt.result.payrollImportId !== receipt.payroll_import_id || receipt.result.planDigest !== digest) throw new Error("Payroll posting receipt returned different identity")
    return receipt.result
  }
  const previous = await existing()
  if (previous) return recover(previous)
  try {
    const { data, error } = await service.from("books_payroll_posting_proposals").select("*").eq("org_id", context.orgId).eq("id", proposalId).single()
    if (error || !data || data.org_id !== context.orgId || data.id !== proposalId) throw new Error("Payroll posting proposal is unavailable in organization")
    const saved = await sources(context.orgId, data)
    if (saved.parsed.row.status !== "reviewed" || saved.parsed.row.plan_digest !== digest) throw new Error("Payroll posting requires exact independently reviewed proposal")
    const current = await previewReviewedPayrollPostingPlan({ id: saved.parsed.row.payroll_import_id })
    if (current.digest !== digest) throw new Error("Payroll posting sources or proposal changed; withdraw and reprepare")
    const result = await service.rpc("post_books_payroll_proposal", { p_org_id: context.orgId, p_id: id, p_proposal_id: proposalId, p_actor_id: context.userId, p_digest: digest, p_notes: notes, p_key: key })
    if (result.error) throw new Error(`Failed to post payroll proposal: ${result.error.message}`)
    const receipt = await existing()
    if (!receipt) throw new Error("Payroll posting returned without confirmed receipt")
    return recover(receipt)
  } catch (error) {
    let receipt
    try { receipt = await existing() } catch { throw error }
    if (receipt) return recover(receipt)
    throw error
  }
}
