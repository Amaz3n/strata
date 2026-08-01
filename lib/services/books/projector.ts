import "server-only"

import { z } from "zod"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { booksDigest } from "@/lib/services/books/hash"
import { postBooksJournalEntryForService } from "@/lib/services/books/ledger"
import {
  postBillPayment,
  postCustomerInvoice,
  postExpense,
  postInvoicePayment,
  postVendorBill,
} from "@/lib/services/books/posting-rules"
import type { JournalEntryDraft } from "@/lib/services/books/types"
import { recordEvent } from "@/lib/services/events"

type ProjectionCandidate = {
  sourceType: string
  sourceId: string
  sourceVersion: number
  accountingDate: string
  occurredAt: string
  payload: Record<string, unknown>
  draft: JournalEntryDraft
}

async function persistProjectionFact(orgId: string, candidate: ProjectionCandidate) {
  const service = createServiceSupabaseClient()
  const payloadHash = booksDigest(candidate.payload)
  const { data: existing, error: existingError } = await service.from("accounting_facts")
    .select("id, payload_hash, source_version")
    .eq("org_id", orgId)
    .eq("source_type", candidate.sourceType)
    .eq("source_id", candidate.sourceId)
    .order("source_version", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (existingError) throw new Error(`Failed to inspect accounting fact: ${existingError.message}`)
  if (existing?.payload_hash === payloadHash) return { factId: String(existing.id), created: false }
  if (existing) {
    await recordEvent({
      orgId,
      eventType: "books.projection_source_changed",
      entityType: candidate.sourceType,
      entityId: candidate.sourceId,
      payload: { prior_fact_id: existing.id, prior_version: existing.source_version, repair: "reverse_and_repost" },
      channel: "notification",
    })
    throw new Error(`${candidate.sourceType} ${candidate.sourceId} changed after its accounting fact was recorded; reverse and repost it`)
  }
  const idempotencyKey = booksDigest({ orgId, sourceType: candidate.sourceType, sourceId: candidate.sourceId, payloadHash })
  const { data, error } = await service.from("accounting_facts").insert({
    org_id: orgId,
    source_type: candidate.sourceType,
    source_id: candidate.sourceId,
    source_version: candidate.sourceVersion,
    fact_kind: `${candidate.sourceType}.recognized`,
    occurred_at: candidate.occurredAt,
    accounting_date: candidate.accountingDate,
    payload: candidate.payload,
    payload_hash: payloadHash,
    policy_version: candidate.draft.policyVersion,
    idempotency_key: idempotencyKey,
  }).select("id").single()
  if (error) throw new Error(`Failed to record accounting fact: ${error.message}`)
  return { factId: z.object({ id: z.string().uuid() }).parse(data).id, created: true }
}

async function projectionCandidates(orgId: string, policyVersion: number, since?: string): Promise<ProjectionCandidate[]> {
  const service = createServiceSupabaseClient()
  // The projection is idempotent at the fact and posting-key boundaries. Reading
  // finalized rows on every pass also repairs a missed event without trusting a
  // mutable watermark. `since` is retained for the public contract and future
  // high-volume paging, but correctness does not depend on it.
  void since
  const [bills, invoices, payments, expenses] = await Promise.all([
    service.from("vendor_bills").select("id, project_id, company_id, bill_number, bill_date, total_cents, retainage_cents, status, updated_at").eq("org_id", orgId).in("status", ["approved", "partial", "paid"]),
    service.from("invoices").select("id, project_id, title, invoice_number, issue_date, total_cents, retainage_cents, status, updated_at").eq("org_id", orgId).in("status", ["sent", "partial", "paid", "overdue"]),
    service.from("payments").select("id, project_id, invoice_id, bill_id, amount_cents, received_at, status, updated_at").eq("org_id", orgId).in("status", ["succeeded", "completed", "paid"]),
    service.from("project_expenses").select("id, project_id, vendor_company_id, expense_date, amount_cents, tax_cents, description, status, updated_at").eq("org_id", orgId).in("status", ["approved", "locked"]),
  ])
  const firstError = bills.error || invoices.error || payments.error || expenses.error
  if (firstError) throw new Error(`Failed to load Books projection sources: ${firstError.message}`)
  const candidates: ProjectionCandidate[] = []
  for (const row of bills.data ?? []) {
    const totalCents = Number(row.total_cents ?? 0)
    if (totalCents <= 0) continue
    const date = String(row.bill_date)
    const payload = { ...row }
    candidates.push({ sourceType: "vendor_bill", sourceId: row.id, sourceVersion: 1, accountingDate: date, occurredAt: row.updated_at, payload, draft: postVendorBill({ id: row.id, date, memo: `Vendor bill ${row.bill_number}`, policyVersion, projectId: row.project_id ?? undefined, companyId: row.company_id ?? undefined, grossCents: totalCents, retainageCents: Number(row.retainage_cents ?? 0) }) })
  }
  for (const row of invoices.data ?? []) {
    const totalCents = Number(row.total_cents ?? 0)
    if (totalCents <= 0) continue
    const date = String(row.issue_date)
    const payload = { ...row }
    candidates.push({ sourceType: "invoice", sourceId: row.id, sourceVersion: 1, accountingDate: date, occurredAt: row.updated_at, payload, draft: postCustomerInvoice({ id: row.id, date, memo: row.title || `Invoice ${row.invoice_number}`, policyVersion, projectId: row.project_id ?? undefined, grossCents: totalCents, retainageCents: Number(row.retainage_cents ?? 0) }) })
  }
  for (const row of payments.data ?? []) {
    const amountCents = Number(row.amount_cents ?? 0)
    if (amountCents <= 0) continue
    const date = String(row.received_at).slice(0, 10)
    const payload = { ...row }
    const billPayment = Boolean(row.bill_id && !row.invoice_id)
    const draft = billPayment
      ? postBillPayment({ id: row.id, date, memo: "Vendor bill payment", policyVersion, projectId: row.project_id ?? undefined, amountCents })
      : postInvoicePayment({ id: row.id, date, memo: "Customer payment", policyVersion, projectId: row.project_id ?? undefined, amountCents })
    candidates.push({ sourceType: billPayment ? "bill_payment" : "invoice_payment", sourceId: row.id, sourceVersion: 1, accountingDate: date, occurredAt: row.updated_at, payload, draft })
  }
  for (const row of expenses.data ?? []) {
    const amountCents = Number(row.amount_cents ?? 0) + Number(row.tax_cents ?? 0)
    if (amountCents <= 0) continue
    const date = String(row.expense_date)
    const payload = { ...row }
    candidates.push({ sourceType: "expense", sourceId: row.id, sourceVersion: 1, accountingDate: date, occurredAt: row.updated_at, payload, draft: postExpense({ id: row.id, date, memo: row.description || "Expense", policyVersion, projectId: row.project_id ?? undefined, companyId: row.vendor_company_id ?? undefined, amountCents }) })
  }
  return candidates
}

export async function projectJournal(orgId: string, options: { since?: string } = {}) {
  const service = createServiceSupabaseClient()
  const { data: settings, error } = await service.from("books_settings")
    .select("workspace_enabled, arc_ledger_mode, active_policy_version")
    .eq("org_id", orgId)
    .single()
  if (error) throw new Error(`Failed to load Books settings: ${error.message}`)
  if (!settings.workspace_enabled || settings.arc_ledger_mode === "disabled") return { projected: 0, skipped: 0, failures: [] }
  const candidates = await projectionCandidates(orgId, Number(settings.active_policy_version), options.since)
  let projected = 0
  let skipped = 0
  const failures: Array<{ sourceType: string; sourceId: string; error: string }> = []
  for (const candidate of candidates) {
    try {
      const fact = await persistProjectionFact(orgId, candidate)
      const journal = await postBooksJournalEntryForService(candidate.draft, orgId, fact.factId)
      if (fact.created || journal.created) projected += 1
      else skipped += 1
    } catch (projectionError) {
      failures.push({ sourceType: candidate.sourceType, sourceId: candidate.sourceId, error: projectionError instanceof Error ? projectionError.message : String(projectionError) })
    }
  }
  return { projected, skipped, failures }
}

export async function runBooksProjection() {
  const service = createServiceSupabaseClient()
  const { data, error } = await service.from("books_settings").select("org_id").eq("workspace_enabled", true).neq("arc_ledger_mode", "disabled").order("org_id")
  if (error) throw new Error(`Failed to load Books organizations: ${error.message}`)
  const results = []
  for (const row of data ?? []) results.push({ orgId: row.org_id, ...await projectJournal(row.org_id) })
  return { organizations: results.length, results }
}
