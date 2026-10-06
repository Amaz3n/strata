import { z } from "zod"
import { createHash } from "node:crypto"
import { booksDigest } from "./hash"
import { verifyPayrollNativeOwnership } from "./payroll-native-ownership"
import { parsePayrollPostingProposal } from "./payroll-posting-proposal-evidence"
const uuid = z.string().uuid().toLowerCase(), date = z.string().date()
export const payrollPostingResultSchema = z.object({
  version: z.literal(1), postingId: uuid, proposalId: uuid, payrollImportId: uuid, planDigest: z.string().regex(/^[a-f0-9]{64}$/),
  journals: z.array(z.object({ journalId: uuid, factId: uuid, entryDate: date, postingKey: z.string().min(1) }).strict()),
  jobCostCorrections: z.array(z.object({ jobCostId: uuid, allocationId: uuid, component: z.string().min(1), sourceKey: z.string().min(1), costCents: z.number().int().safe() }).strict()),
  billingPreserved: z.array(uuid),
}).strict()
export const payrollPostingReceiptSchema = z.object({
  id: uuid, org_id: uuid, proposal_id: uuid, payroll_import_id: uuid, plan_digest: z.string().regex(/^[a-f0-9]{64}$/),
  posted_by: uuid, posted_at: z.string().datetime({ offset: true }), posting_notes: z.string().trim().min(10).max(4000), idempotency_key: z.string().trim().min(10).max(200), result: payrollPostingResultSchema,
}).strict()
type Tables = Record<string, Record<string, unknown>[]>
const equal = (left: unknown, right: unknown) => { if (booksDigest(left) !== booksDigest(right)) throw new Error("Payroll posting receipt differs from approved evidence") }
const number = (value: unknown) => { const parsed = z.union([z.number().int().safe(), z.string().regex(/^-?\d+$/)]).parse(value); const result = Number(parsed); if (!Number.isSafeInteger(result)) throw new Error("Unsafe payroll posting amount"); return result }

// PostgreSQL JSONB orders object keys by UTF-8 byte length, then binary bytes:
// postgres/src/backend/utils/adt/jsonb_util.c lengthCompareJsonbString.
// This payroll payload grammar admits integer numbers only; arbitrary decimal
// or exponent JSON would need PostgreSQL numeric formatting as well.
export function postgresPayrollJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value)
  if (typeof value === "number" && Number.isSafeInteger(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(postgresPayrollJson).join(", ")}]`
  if (typeof value === "object" && value !== null) return `{${Object.entries(value).sort(([a],[b]) => {
    const left = Buffer.from(a), right = Buffer.from(b)
    return left.length-right.length || Buffer.compare(left,right)
  }).map(([key,value]) => `${JSON.stringify(key)}: ${postgresPayrollJson(value)}`).join(", ")}}`
  throw new Error("Unsupported payroll fact JSON value")
}

/** Replays actual posted rows against the immutable, independently reviewed
 * proposal. Frozen receipt IDs alone never prove that money was posted. */
export function verifyPayrollPostingReceipt(input: unknown, tables: Tables, options: { requireNativeOwnership: boolean } = { requireNativeOwnership: false }) {
  const row = payrollPostingReceiptSchema.parse(input), result = row.result
  const find = (table: string, id: string) => { const matches = (tables[table] ?? []).filter(value => value.id === id && value.org_id === row.org_id); if (matches.length !== 1) throw new Error(`Missing/ambiguous payroll posting ${table}`); return matches[0] }
  const proposal = find("books_payroll_posting_proposals", row.proposal_id), parent = find("books_payroll_imports", row.payroll_import_id)
  const payment = proposal.payment_review_id == null ? null : find("books_payroll_payment_reviews", String(proposal.payment_review_id))
  const parsed = parsePayrollPostingProposal(proposal, parent, payment), plan = parsed.plan
  if (parsed.row.status !== "reviewed" || parent.status !== "reviewed" || payment && payment.status !== "reviewed" || parsed.row.payroll_import_id !== row.payroll_import_id || parsed.row.plan_digest !== row.plan_digest) throw new Error("Payroll posted ownership lacks reviewed proposal")
  equal([result.postingId,result.proposalId,result.payrollImportId,result.planDigest], [row.id,row.proposal_id,row.payroll_import_id,row.plan_digest])
  const accounts = z.array(z.object({ id: uuid, code: z.string(), account_type: z.string(), subtype: z.string() }).passthrough()).parse((parent.reconciliation as { postingAccounts: unknown }).postingAccounts)
  if (result.journals.length !== plan.journalDrafts.length) throw new Error("Payroll posting journal inventory differs")
  const journalIds = new Set<string>(), factIds = new Set<string>(), costIds = new Set<string>()
  for (const [index, draft] of plan.journalDrafts.entries()) {
    const link = result.journals[index], journal = find("journal_entries", link.journalId), fact = find("accounting_facts", link.factId)
    if (journalIds.has(link.journalId) || factIds.has(link.factId)) throw new Error("Duplicate payroll posted journal/fact")
    journalIds.add(link.journalId); factIds.add(link.factId)
    equal([link.entryDate,link.postingKey,journal.fact_id,journal.status,journal.entry_date,journal.entry_kind,journal.memo,journal.posting_key,journal.source_type,journal.source_id,number(journal.projection_version),number(journal.policy_version),journal.created_by,journal.posted_by],
      [draft.entryDate,draft.postingKey,link.factId,"posted",draft.entryDate,draft.entryKind,draft.memo,draft.postingKey,"payroll_import",row.payroll_import_id,draft.projectionVersion,draft.policyVersion,row.posted_by,row.posted_by])
    z.string().datetime({ offset: true }).parse(journal.posted_at)
    equal(new Date(String(journal.posted_at)).getTime(),new Date(row.posted_at).getTime())
    equal(new Date(String(fact.occurred_at)).getTime(),new Date(row.posted_at).getTime())
    equal([fact.source_type,fact.source_id,number(fact.source_version),fact.fact_kind,fact.accounting_date,fact.idempotency_key,number(fact.policy_version),fact.created_by], ["payroll_import",row.payroll_import_id,index+1,"payroll_reconciliation",draft.entryDate,draft.postingKey,draft.policyVersion,row.posted_by])
    equal(fact.payload, { payroll_posting_id: row.id, proposal_id: row.proposal_id, plan_digest: row.plan_digest, source_revision: plan.sourceRevision, draft })
    equal(fact.payload_hash, createHash("sha256").update(postgresPayrollJson(fact.payload)).digest("hex"))
    const expected = draft.lines.map((line, index) => {
      const matches = accounts.filter(account => account.code === line.accountCode); if (matches.length !== 1) throw new Error("Ambiguous approved payroll account")
      const account = matches[0]; find("gl_accounts", account.id)
      return { line_no: index+1, account_id: account.id, project_id: line.projectId ?? null, company_id: null, description: line.description ?? null, debit_cents: line.debitCents, credit_cents: line.creditCents,
        dimensions: { ...line.dimensions, payroll_posting_id: row.id, payroll_proposal_id: row.proposal_id, books_account_classification: { version: 1, account_id: account.id, code: account.code, account_type: account.account_type, subtype: account.subtype } } }
    })
    const actual = (tables.journal_lines ?? []).filter(line => line.org_id === row.org_id && line.entry_id === link.journalId).sort((a,b) => number(a.line_no)-number(b.line_no)).map(line => ({ line_no: number(line.line_no), account_id: line.account_id, project_id: line.project_id ?? null, company_id: line.company_id ?? null, description: line.description ?? null, debit_cents: number(line.debit_cents), credit_cents: number(line.credit_cents), dimensions: line.dimensions }))
    equal(actual, expected)
  }
  equal((tables.journal_entries ?? []).filter(journal => journal.org_id === row.org_id && journal.source_type === "payroll_import" && journal.source_id === row.payroll_import_id).map(journal => journal.id).sort(), [...journalIds].sort())
  equal((tables.accounting_facts ?? []).filter(fact => fact.org_id === row.org_id && fact.source_type === "payroll_import" && fact.source_id === row.payroll_import_id).map(fact => fact.id).sort(), [...factIds].sort())
  let costIndex = 0
  for (const allocation of plan.allocations) {
    const context = allocation.construction
    if (context.blockers.length || context.billing.requiresReview) throw new Error("Posted payroll has unresolved construction controls")
    for (const component of context.jobCostCorrections) {
      const link = result.jobCostCorrections[costIndex++]; if (!link || costIds.has(link.jobCostId)) throw new Error("Missing/duplicate payroll correction")
      costIds.add(link.jobCostId); const job = find("job_cost_entries",link.jobCostId)
      equal([link.allocationId,link.component,link.sourceKey,link.costCents], [allocation.allocationId,component.component,component.sourceKey,component.costCents])
      equal([job.source_type,job.source_id,job.status,job.project_id,job.cost_code_id ?? null,job.budget_line_id ?? null,job.gmp_classification,job.incurred_on,number(job.cost_cents),job.is_billable,job.billable_cost_id ?? null,job.invoice_id ?? null],
        ["payroll_import",job.id,"posted",context.projectId,context.costCodeId,context.budgetLineId,context.gmpClassification,context.incurredOn,component.costCents,false,null,null])
      equal(job.metadata,{ payroll_posting_id:row.id,payroll_proposal_id:row.proposal_id,payroll_run_id:row.payroll_import_id,payroll_worker_id:allocation.workerId,payroll_allocation_id:allocation.allocationId,payroll_component:component.component,payroll_source_key:component.sourceKey,cost_account_code:allocation.accountCode,original_job_cost_ids:context.sourceJobCostIds,billing_action:context.billing.action })
    }
  }
  if (costIndex !== result.jobCostCorrections.length) throw new Error("Unexpected payroll correction receipt")
  const owned = (tables.job_cost_entries ?? []).filter(job => job.org_id === row.org_id && job.source_type === "payroll_import" && (job.metadata as { payroll_posting_id?: unknown })?.payroll_posting_id === row.id)
  equal(owned.map(job => job.id).sort(),[...costIds].sort())
  equal(result.billingPreserved,[...new Set(plan.allocations.flatMap(allocation => allocation.construction.billing.originalBillableCostIds))].sort())
  if (options.requireNativeOwnership) verifyPayrollNativeOwnership(row,parent,tables)
  return row
}
