import { z } from "zod"
import { booksDigest } from "./hash"
import { economicLaborBasis, laborBasisFromJobCost, laborBasisSchema } from "./labor-evidence"
import { payrollLaborEvidenceSchema } from "./payroll-import-rules"
import { timestampMicros } from "./posting-state"
const uuid = z.string().uuid().toLowerCase()
export const payrollNativeOwnershipSchema = z.object({
  id: uuid, org_id: uuid, project_id: uuid, cost_code_id: uuid.nullable(), posting_id: uuid, time_entry_id: uuid, job_cost_entry_id: uuid, fact_id: uuid, journal_id: uuid, projection_receipt_id: uuid, created_at: z.string().datetime({ offset: true }),
}).strict()

/** Schema 12 recovery can derive identities only from intact original sources.
 * Verify the resulting inventory before returning any recovery rows. */
export function derivePayrollNativeOwnership(posting: {id:string;org_id:string;posted_at:string}, parent: Record<string,unknown>, tables: Record<string,Record<string,unknown>[]>) {
  const labor = payrollLaborEvidenceSchema.parse(parent.labor_evidence)
  const find = (table:string, predicate:(row:Record<string,unknown>)=>boolean) => {
    const matches = (tables[table] ?? []).filter(row => row.org_id === posting.org_id && predicate(row))
    if (matches.length !== 1) throw new Error(`Missing/ambiguous original payroll native ${table}`)
    return matches[0]
  }
  const rows = labor.map(item => {
    const job = find("job_cost_entries", row => row.id === item.id)
    const receipt = find("books_projection_receipts", row => row.source_type === "labor_cost" && row.source_id === item.id && row.fact_id === item.fact_id && row.journal_id === item.journal_id)
    return payrollNativeOwnershipSchema.parse({id:item.id, org_id:posting.org_id, project_id:item.project_id, cost_code_id:item.cost_code_id, posting_id:posting.id, time_entry_id:job.source_id, job_cost_entry_id:item.id, fact_id:item.fact_id, journal_id:item.journal_id, projection_receipt_id:receipt.id, created_at:posting.posted_at})
  })
  verifyPayrollNativeOwnership(posting, parent, {...tables, books_payroll_labor_ownership:rows})
  return rows
}
const metadataKeys = ["worker_user_id","worker_company_id","hours","base_rate_cents","burden_multiplier","is_overtime","ot_multiplier","is_double_time","dt_multiplier","labor_cost_policy_version"]
const jobKeys = ["id","org_id","project_id","cost_code_id","budget_line_id","gmp_classification","billable_cost_id","source_type","source_id","incurred_on","cost_cents","status"]
const select = (row: Record<string,unknown>, keys: string[]) => Object.fromEntries(keys.map(key => [key,row[key] ?? null]))
const equal = (left: unknown,right: unknown) => { if (booksDigest(left) !== booksDigest(right)) throw new Error("Payroll native ownership differs from original reviewed sources") }
function sameTimestamp(left: unknown,right: unknown) { const a=timestampMicros(String(left)),b=timestampMicros(String(right)); if(a===null||b===null||a!==b)throw new Error("Payroll native ownership timestamp differs") }

/** Minimal operational ownership must still prove the complete original native
 * wage basis. It never substitutes current employee profiles for original facts. */
export function verifyPayrollNativeOwnership(posting: {id:string;org_id:string;posted_at:string}, parent: Record<string,unknown>, tables: Record<string,Record<string,unknown>[]>) {
  const labor = payrollLaborEvidenceSchema.parse(parent.labor_evidence)
  const originalJobs = z.array(z.record(z.unknown())).parse((parent.reconciliation as { workflowEvidence:{sourceTables:{job_cost_entries:unknown}} }).workflowEvidence.sourceTables.job_cost_entries)
  const owned = (tables.books_payroll_labor_ownership ?? []).filter(row => row.org_id === posting.org_id && row.posting_id === posting.id).map(row => payrollNativeOwnershipSchema.parse(row))
  if (owned.length !== labor.length) throw new Error("Payroll native ownership inventory differs")
  const find = (table:string,id:string) => {const rows=(tables[table]??[]).filter(row=>row.id===id&&row.org_id===posting.org_id);if(rows.length!==1)throw new Error(`Missing payroll native ${table}`);return rows[0]}
  for (const item of labor) {
    const matches = owned.filter(row => row.job_cost_entry_id === item.id)
    if(matches.length!==1)throw new Error("Missing/duplicate original native ownership")
    const ownership=matches[0],job=find("job_cost_entries",item.id),time=find("time_entries",ownership.time_entry_id),fact=find("accounting_facts",item.fact_id),journal=find("journal_entries",item.journal_id),receipt=find("books_projection_receipts",ownership.projection_receipt_id)
    equal([ownership.id,ownership.project_id,ownership.cost_code_id,ownership.time_entry_id,ownership.fact_id,ownership.journal_id,job.source_type,job.status,fact.source_type,fact.source_id,journal.status,journal.fact_id,journal.source_type,journal.source_id,receipt.source_type,receipt.source_id,receipt.fact_id,receipt.journal_id],
      [item.id,item.project_id,item.cost_code_id,job.source_id,item.fact_id,item.journal_id,"time_entry","posted","labor_cost",item.id,"posted",item.fact_id,"labor_cost",item.id,"labor_cost",item.id,item.fact_id,item.journal_id])
    sameTimestamp(ownership.created_at,posting.posted_at)
    const original=originalJobs.find(row=>row.id===job.id);if(!original)throw new Error("Missing frozen native job source")
    equal(select(job,jobKeys),select(original,jobKeys));sameTimestamp(job.updated_at,original.updated_at)
    const metadata=z.record(z.unknown()).parse(job.metadata),originalMetadata=z.record(z.unknown()).parse(original.metadata)
    equal(select(metadata,metadataKeys),select(originalMetadata,metadataKeys))
    equal(select(time,["org_id","project_id","cost_code_id","cost_cents"]),select(job,["org_id","project_id","cost_code_id","cost_cents"]))
    equal([time.work_date,time.worker_user_id,time.worker_company_id ?? null],[job.incurred_on,metadata.worker_user_id,metadata.worker_company_id ?? null]);equal(select(time,metadataKeys.filter(key=>key!=="worker_user_id" && key!=="worker_company_id")),select(metadata,metadataKeys.filter(key=>key!=="worker_user_id" && key!=="worker_company_id")))
    if(!["pm_approved","client_approved","locked"].includes(String(time.status)))throw new Error("Payroll native time is no longer approved")
    const basis=laborBasisSchema.parse((fact.payload as {labor_basis:unknown}).labor_basis),current=laborBasisFromJobCost(posting.org_id,job)
    if(!current)throw new Error("Payroll native cost lost original wage decomposition")
    equal(economicLaborBasis(current),economicLaborBasis(basis))
    const observed=timestampMicros(String(receipt.source_observed_at)),source=timestampMicros(String(job.updated_at));if(observed===null||source===null||observed<source)throw new Error("Payroll native posting receipt is stale")
  }
  return owned
}
