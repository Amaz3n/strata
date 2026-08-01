import "server-only"

import { z } from "zod"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireAuthorization } from "@/lib/services/authorization"
import { booksDigest } from "@/lib/services/books/hash"
import {
  postBillPayment,
  postCustomerInvoice,
  postExpense,
  postInvoicePayment,
  postVendorBill,
} from "@/lib/services/books/posting-rules"
import type { JournalEntryDraft } from "@/lib/services/books/types"
import { requireOrgContext } from "@/lib/services/context"

const factSchema = z.object({
  id: z.string().uuid(),
  source_type: z.string(),
  source_id: z.string().uuid(),
  accounting_date: z.string(),
  policy_version: z.number().int(),
  payload: z.record(z.unknown()),
})

function textValue(value: unknown, fallback = "") { return typeof value === "string" ? value : fallback }
function centsValue(value: unknown) { return typeof value === "number" && Number.isSafeInteger(value) ? value : 0 }
function optionalId(value: unknown) { return typeof value === "string" && value.length > 0 ? value : undefined }

export function rebuildDraftFromFact(fact: z.infer<typeof factSchema>): JournalEntryDraft | null {
  const row = fact.payload
  const common = { id: fact.source_id, date: fact.accounting_date, policyVersion: fact.policy_version, projectId: optionalId(row.project_id) }
  if (fact.source_type === "vendor_bill") return postVendorBill({ ...common, companyId: optionalId(row.company_id), memo: `Vendor bill ${textValue(row.bill_number)}`.trim(), grossCents: centsValue(row.total_cents), retainageCents: centsValue(row.retainage_cents) })
  if (fact.source_type === "invoice") return postCustomerInvoice({ ...common, memo: textValue(row.title, `Invoice ${textValue(row.invoice_number)}`), grossCents: centsValue(row.total_cents), retainageCents: centsValue(row.retainage_cents) })
  if (fact.source_type === "invoice_payment") return postInvoicePayment({ ...common, memo: "Customer payment", amountCents: centsValue(row.amount_cents) })
  if (fact.source_type === "bill_payment") return postBillPayment({ ...common, memo: "Vendor bill payment", amountCents: centsValue(row.amount_cents) })
  if (fact.source_type === "expense") return postExpense({ ...common, companyId: optionalId(row.vendor_company_id), memo: textValue(row.description, "Expense"), amountCents: centsValue(row.amount_cents) + centsValue(row.tax_cents) })
  return null
}

function normalizedDraft(draft: JournalEntryDraft) {
  return {
    entryDate: draft.entryDate,
    entryKind: draft.entryKind,
    memo: draft.memo,
    postingKey: draft.postingKey,
    policyVersion: draft.policyVersion,
    lines: draft.lines.map((line) => ({ accountCode: line.accountCode, projectId: line.projectId ?? null, companyId: line.companyId ?? null, debitCents: line.debitCents, creditCents: line.creditCents, description: line.description ?? null, dimensions: line.dimensions ?? {} })),
  }
}

export async function runLedgerRebuildDrillForOrg(orgId: string) {
  const service = createServiceSupabaseClient()
  const { data: run, error: runError } = await service.from("ledger_rebuild_runs").insert({ org_id: orgId, status: "running" }).select("id").single()
  if (runError) throw new Error(`Failed to start ledger rebuild drill: ${runError.message}`)
  const runId = z.object({ id: z.string().uuid() }).parse(run).id
  const differences: Array<Record<string, unknown>> = []
  let sourceFactCount = 0
  let rebuiltEntryCount = 0
  const rebuilt: unknown[] = []
  try {
    for (let from = 0; ; from += 250) {
      const { data, error } = await service.from("accounting_facts").select("id, source_type, source_id, accounting_date, policy_version, payload").eq("org_id", orgId).order("created_at").range(from, from + 249)
      if (error) throw new Error(error.message)
      const facts = z.array(factSchema).parse(data ?? [])
      sourceFactCount += facts.length
      const ids = facts.map((fact) => fact.id)
      const { data: entries, error: entryError } = ids.length > 0
        ? await service.from("journal_entries").select("id, fact_id, entry_date, entry_kind, memo, posting_key, policy_version, lines:journal_lines(line_no, project_id, company_id, debit_cents, credit_cents, description, dimensions, account:gl_accounts(code))").eq("org_id", orgId).in("fact_id", ids).eq("status", "posted")
        : { data: [], error: null }
      if (entryError) throw new Error(entryError.message)
      const entryByFact = new Map((entries ?? []).map((entry) => [entry.fact_id, entry]))
      for (const fact of facts) {
        let expected: JournalEntryDraft | null = null
        try { expected = rebuildDraftFromFact(fact) } catch (error) {
          differences.push({ fact_id: fact.id, type: "invalid_fact", message: error instanceof Error ? error.message : String(error) })
          continue
        }
        if (!expected) {
          differences.push({ fact_id: fact.id, type: "unsupported_fact_kind", source_type: fact.source_type })
          continue
        }
        const actual = entryByFact.get(fact.id)
        if (!actual) {
          differences.push({ fact_id: fact.id, type: "missing_journal" })
          continue
        }
        const actualLines = (actual.lines ?? []).sort((left, right) => left.line_no - right.line_no).map((line) => {
          const account = Array.isArray(line.account) ? line.account[0] : line.account
          return { accountCode: account?.code, projectId: line.project_id ?? null, companyId: line.company_id ?? null, debitCents: Number(line.debit_cents), creditCents: Number(line.credit_cents), description: line.description ?? null, dimensions: line.dimensions ?? {} }
        })
        const actualNormalized = { entryDate: actual.entry_date, entryKind: actual.entry_kind, memo: actual.memo, postingKey: actual.posting_key, policyVersion: actual.policy_version, lines: actualLines }
        const expectedNormalized = normalizedDraft(expected)
        rebuilt.push(expectedNormalized)
        rebuiltEntryCount += 1
        if (booksDigest(actualNormalized) !== booksDigest(expectedNormalized)) differences.push({ fact_id: fact.id, type: "journal_divergence", expected: expectedNormalized, actual: actualNormalized })
      }
      if (facts.length < 250) break
    }
    const rebuiltDigest = booksDigest(rebuilt)
    const status = differences.length === 0 ? "passed" : "failed"
    const { error: updateError } = await service.from("ledger_rebuild_runs").update({ status, source_fact_count: sourceFactCount, rebuilt_entry_count: rebuiltEntryCount, rebuilt_digest: rebuiltDigest, differences: differences.slice(0, 200), completed_at: new Date().toISOString() }).eq("org_id", orgId).eq("id", runId)
    if (updateError) throw new Error(updateError.message)
    return { runId, status, sourceFactCount, rebuiltEntryCount, rebuiltDigest, differences }
  } catch (error) {
    await service.from("ledger_rebuild_runs").update({ status: "failed", source_fact_count: sourceFactCount, rebuilt_entry_count: rebuiltEntryCount, differences: [{ type: "run_error", message: error instanceof Error ? error.message : String(error) }], completed_at: new Date().toISOString() }).eq("org_id", orgId).eq("id", runId)
    throw error
  }
}

export async function requestLedgerRebuildDrill(orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requireAuthorization({ permission: "books.export", userId: context.userId, orgId: context.orgId, supabase: context.supabase, resourceType: "ledger_rebuild", resourceId: context.orgId, logDecision: true })
  return runLedgerRebuildDrillForOrg(context.orgId)
}

export async function runScheduledLedgerRebuildDrills() {
  const service = createServiceSupabaseClient()
  const { data, error } = await service.from("books_settings").select("org_id").eq("workspace_enabled", true).in("arc_ledger_mode", ["parallel", "official"]).order("org_id")
  if (error) throw new Error(`Failed to load Books rebuild organizations: ${error.message}`)
  const results = []
  for (const row of data ?? []) results.push(await runLedgerRebuildDrillForOrg(row.org_id))
  return { attempted: data?.length ?? 0, results }
}
