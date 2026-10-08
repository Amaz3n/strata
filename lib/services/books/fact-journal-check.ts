import "server-only"

import { z } from "zod"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { chunk } from "@/lib/utils"
import { draftFromFact, isRetiredFactKind } from "@/lib/services/books/fact-drafts"
import { booksDigest } from "@/lib/services/books/hash"
import type { JournalEntryDraft } from "@/lib/services/books/types"

/**
 * Rebuilds each fact's journal entry from the fact alone and compares it with the
 * entry the ledger holds. The full ledger rebuild drill and the narrowed proof of
 * chosen sources both run this, so the two agree on every fact they both read.
 */

export const factCheckSchema = z.object({
  id: z.string().uuid(),
  source_type: z.string(),
  source_id: z.string().uuid(),
  source_version: z.number().int(),
  fact_kind: z.string(),
  accounting_date: z.string(),
  policy_version: z.number().int(),
  payload: z.record(z.unknown()),
})
export type CheckedFact = z.infer<typeof factCheckSchema>
export const FACT_CHECK_COLUMNS = "id, source_type, source_id, source_version, fact_kind, accounting_date, policy_version, payload"

export type LedgerDifference = Record<string, unknown> & { type: string }

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

export async function checkFactJournals(orgId: string, facts: CheckedFact[], projectionVersion: number) {
  const service = createServiceSupabaseClient()
  const differences: LedgerDifference[] = []
  const rebuilt: unknown[] = []
  // A retirement fact records that a source left the projectable set. Its entry
  // was already reversed, so producing no draft is the right answer, not an
  // unsupported fact kind.
  const live = facts.filter((fact) => !isRetiredFactKind(fact.fact_kind))
  // Fact ids travel in the URL beside a long select, so they go 100 at a time.
  const entries = []
  for (const slice of chunk(live.map((fact) => fact.id), 100)) {
    const { data, error } = await service.from("journal_entries").select("id, fact_id, status, entry_date, entry_kind, memo, posting_key, projection_version, policy_version, lines:journal_lines!journal_lines_entry_owner_fk(line_no, project_id, company_id, debit_cents, credit_cents, description, dimensions, account:gl_accounts!journal_lines_account_owner_fk(code))").eq("org_id", orgId).in("fact_id", slice).in("status", ["posted", "reversed"])
    if (error) throw new Error(`Failed to load journals for facts: ${error.message}`)
    entries.push(...(data ?? []))
  }
  // A fact is compared with the entry standing for it. A reversed entry stands in
  // only for a fact a later revision superseded; for a current fact it means the
  // posting was reversed and not yet replaced, so the source is off the books.
  const superseded = new Set<string>()
  for (const slice of chunk(live.map((fact) => fact.id), 100)) {
    const { data, error } = await service.from("accounting_facts").select("supersedes_fact_id").eq("org_id", orgId).in("supersedes_fact_id", slice)
    if (error) throw new Error(`Failed to load fact revisions: ${error.message}`)
    for (const row of data ?? []) superseded.add(String(row.supersedes_fact_id))
  }
  const entryByFact = new Map<string, (typeof entries)[number]>()
  for (const entry of entries) {
    const fact = String(entry.fact_id), held = entryByFact.get(fact)
    if (entry.status === "posted") entryByFact.set(fact, entry)
    else if (!held && superseded.has(fact)) entryByFact.set(fact, entry)
  }
  for (const fact of live) {
    let expected: JournalEntryDraft | null = null
    try {
      expected = draftFromFact({
        sourceType: fact.source_type,
        sourceId: fact.source_id,
        accountingDate: fact.accounting_date,
        payload: fact.payload,
        sourceVersion: fact.source_version,
        projectionVersion: Number(entryByFact.get(fact.id)?.projection_version ?? projectionVersion),
        policyVersion: fact.policy_version,
      })
    } catch (draftError) {
      differences.push({ fact_id: fact.id, type: "invalid_fact", message: draftError instanceof Error ? draftError.message : String(draftError) })
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
    // The database adds the due-from / due-to pair when an entry's lines belong to
    // different legal entities; those legs follow from ownership, not the draft.
    const actualLines = (actual.lines ?? []).filter((line) => (line.dimensions as Record<string, unknown> | null)?.intercompany !== true).sort((left, right) => left.line_no - right.line_no).map((line) => {
      const account = Array.isArray(line.account) ? line.account[0] : line.account
      // The database stamps each posted line with its account's classification at
      // posting; that is evidence beside the posting, not part of the draft, and the
      // account itself is compared by code.
      const { books_account_classification: _classification, ...dimensions } = (line.dimensions ?? {}) as Record<string, unknown>
      return { accountCode: account?.code, projectId: line.project_id ?? null, companyId: line.company_id ?? null, debitCents: Number(line.debit_cents), creditCents: Number(line.credit_cents), description: line.description ?? null, dimensions }
    })
    // A source posted again after a reversal carries a `:repost:N` key; the entry is otherwise the draft's.
    const actualNormalized = { entryDate: actual.entry_date, entryKind: actual.entry_kind, memo: actual.memo, postingKey: actual.posting_key.replace(/:repost:\d+$/, ""), policyVersion: actual.policy_version, lines: actualLines }
    const expectedNormalized = normalizedDraft(expected)
    rebuilt.push(expectedNormalized)
    if (booksDigest(actualNormalized) !== booksDigest(expectedNormalized)) differences.push({ fact_id: fact.id, type: "journal_divergence", expected: expectedNormalized, actual: actualNormalized })
  }
  return { differences, rebuilt }
}
